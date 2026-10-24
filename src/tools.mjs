// account, bracket and cancel_all: the tools around the core order flow. Same shape as trader.mjs
// (chain access through `deps`, every outcome journaled and returned as a value):
//   deps.chain  createChain()  placeStops / cancelStops / cancelAll      deps.native()  STT balance (bigint)
import { formatUnits } from "viem";
import { findMarket, units } from "./trader.mjs";
import { explainExchangeError, isExchangeRefusal, describeError } from "./exchange-errors.mjs";

const abs = (x) => (x < 0n ? -x : x);
const nearestTo = (x, step) => ((x + step / 2n) / step) * step;
const user = (msg) => Object.assign(new Error(msg), { pilotUser: true });
const fmt = (x, d = 18) => formatUnits(BigInt(x), d);
const num = (x, d = 18) => Number(fmt(x, d));

const pendingStops = async (client, account) => client.listPerpStopOrders({ account, status: ["PENDING"], limit: 100 });

// ---- account -----------------------------------------------------------------------------------
export const accountInfo = async (deps) => {
  const client = deps.client();
  const account = deps.account();
  const markets = await client.listPerpMarkets();
  const bank = markets[0].marginBank;
  const [ma, stops, stt] = await Promise.all([
    client.getMarginAccount(bank, account),
    pendingStops(client, account).catch((e) => ({ error: describeError(e) })),
    deps.native ? deps.native().catch(() => null) : null,
  ]);
  const byPool = new Map(markets.map((m) => [m.poolAddress.toLowerCase(), m]));
  const positions = [];
  for (const pool of ma.activePerpPools) {
    const mk = byPool.get(String(pool).toLowerCase());
    if (!mk) continue;
    const ref = { pool: mk.poolAddress, marginBank: mk.marginBank, account };
    const [pos, an] = await Promise.all([client.getPerpPosition(ref), client.getPerpPositionAnalytics(ref).catch(() => null)]);
    if (pos.size === 0n) continue;
    const u = units(mk);
    positions.push({
      market: mk.baseSymbol,
      side: pos.size > 0n ? "long" : "short",
      size: u.qty(abs(pos.size)),
      avgEntryPrice: u.px(pos.avgEntryPrice),
      markPrice: an?.priceable ? u.px(an.markPrice) : null,
      notionalUsd: an?.priceable ? num(an.notional) : null,
      unrealizedPnlUsd: an?.priceable ? num(an.unrealizedPnl) : null,
    });
  }
  const bySymbol = new Map(markets.map((m) => [m.stopRegistry?.toLowerCase(), m.baseSymbol]));
  const brackets = Array.isArray(stops)
    ? stops.map((s) => ({ id: s.orderIdRaw, market: bySymbol.get(String(s.registry).toLowerCase()) ?? null, closes: s.isBid ? "short (buys)" : "long (sells)", triggerPrice: fmt(s.triggerPrice), when: s.triggerOperator === 0 ? "mark >= trigger" : "mark <= trigger" }))
    : { unavailable: stops.error };
  const p = deps.policy();
  return {
    account,
    sttForGas: stt == null ? null : Number(Number(fmt(stt)).toFixed(4)),
    collateralUsdso: { equity: num(ma.equity), unlocked: num(ma.unlockedCollateralBalance), lockedAsMargin: num(ma.lockedCollateral), withdrawable: num(ma.withdrawable) },
    marginStatus: ma.marginStatus,
    marginRequirementsUsd: { initial: num(ma.imReq), maintenance: num(ma.mmReq), closeOut: num(ma.cmReq) },
    positions,
    pendingBrackets: brackets,
    policy: { maxNotionalUsd: p.maxNotionalUsd, allowedMarkets: p.allowedMarkets, dailyOrderCap: p.dailyOrderCap, ordersSentTodayUtc: deps.journal.ordersToday(new Date(deps.now())), source: p.source },
    asOfBlock: Number(ma.asOfBlock),
  };
};

// ---- shared failure handling for the stop/cancel transactions ---------------------------------
// Same rules as sendIoc: a revert is the exchange's refusal (decoded), anything else without a
// hash may still have gone out ("unknown") unless the sender proved otherwise.
const failTx = (deps, e, base) => {
  const tx = e?.txHash ?? null;
  if (isExchangeRefusal(e)) {
    const x = explainExchangeError(e);
    deps.journal.append({ kind: "refusal", refused_by: "exchange", stage: "chain", sent: tx ? true : "unknown", tx, code: x.code, reason: x.reason, next: x.next, rawReason: e?.reason ?? null, ...base });
    return { ok: false, refused_by: "exchange", code: x.code, reason: x.reason, next: x.next, tx, ...base };
  }
  const sent = tx ? true : e?.pilotNotSent ? false : "unknown";
  const error = describeError(e);
  deps.journal.append({ kind: "error", sent, tx, error, ...base });
  return { ok: false, error, sent, tx, next: sent === false ? "nothing was sent; fix the error and try again" : "send status unknown: call account to see what is on chain before trying again", ...base };
};

const refusePilot = (deps, base, rule, detail, next) => {
  deps.journal.append({ kind: "refusal", refused_by: "pilot-policy", stage: "bracket", rules: [rule], reason: detail, next, ...base });
  return { ok: false, refused_by: "pilot-policy", rule, reason: detail, next, ...base };
};

// ---- bracket -----------------------------------------------------------------------------------
// A linked take-profit + stop-loss pair on the account's open position: one-cancels-other, whole
// position at trigger time (quantity 0 = resolved against the live position when it fires),
// MARKET type (slippage-bounded by the registry). Both legs are reduce-only, so a bracket can
// only shrink risk: like close_position it is not blocked by the allowlist or the daily cap, but
// it needs a position to protect, a sane trigger distance, and the SOMI the registry holds
// (refunded on cancel).
export const bracket = async (deps, { market, take_profit_pct, stop_loss_pct }) => {
  const client = deps.client();
  const account = deps.account();
  const mk = await findMarket(client, market);
  const u = units(mk);
  const base = { action: "bracket", market: mk.baseSymbol, takeProfitPct: take_profit_pct, stopLossPct: stop_loss_pct };
  if (!(take_profit_pct >= 0.1 && take_profit_pct <= 50 && stop_loss_pct >= 0.1 && stop_loss_pct <= 50))
    throw user("take_profit_pct and stop_loss_pct must each be between 0.1 and 50 (percent away from the current mark price).");

  let pos, an, pending, perLeg, balance;
  try {
    const ref = { pool: mk.poolAddress, marginBank: mk.marginBank, account };
    [pos, an, pending, perLeg, balance] = await Promise.all([
      client.getPerpPosition(ref),
      client.getPerpPositionAnalytics(ref),
      pendingStops(client, account),
      client.getPerpStopOrderSomiPayment(mk.stopRegistry),
      deps.native ? deps.native() : null,
    ]);
  } catch (e) {
    const error = describeError(e);
    deps.journal.append({ kind: "error", stage: "bracket", sent: false, error, ...base });
    return { ok: false, error, sent: false, next: "nothing was sent; try again", ...base };
  }
  if (pos.size === 0n) return refusePilot(deps, base, "noPosition", `there is no open ${mk.baseSymbol} position to protect`, "open one with plan_order and place_order first");
  if (!an?.priceable) return refusePilot(deps, base, "markUnknown", `the exchange could not price the ${mk.baseSymbol} position right now`, "try again shortly");
  const mine = pending.filter((s) => String(s.registry).toLowerCase() === mk.stopRegistry.toLowerCase());
  if (mine.length) return refusePilot(deps, base, "bracketExists", `${mine.length} pending stop(s) already protect ${mk.baseSymbol}`, "call cancel_all for this market first, then bracket again");
  const need = perLeg * 2n;
  if (balance != null && balance < need + 10n ** 17n)
    return refusePilot(deps, base, "insufficientNative", `a bracket holds ${fmt(need)} STT (2 x ${fmt(perLeg)}, refunded on cancel) plus gas, and the account has ${fmt(balance)} STT`, "fund the account with STT from the faucet");

  const long = pos.size > 0n;
  const mark = an.markPrice;
  const tick = BigInt(mk.tickSize);
  const bps = (pct) => BigInt(Math.round(pct * 100));
  const up = (pct) => nearestTo((mark * (10_000n + bps(pct))) / 10_000n, tick);
  const down = (pct) => nearestTo((mark * (10_000n - bps(pct))) / 10_000n, tick);
  const tpTrigger = long ? up(take_profit_pct) : down(take_profit_pct);
  const slTrigger = long ? down(stop_loss_pct) : up(stop_loss_pct);
  const exitIsBid = !long; // closing a short buys
  // GTE (0) fires when mark >= trigger, LTE (1) when mark <= trigger. Long: TP above, SL below.
  const tp = { isBid: exitIsBid, quantity: 0n, triggerPrice: tpTrigger, triggerOperator: long ? 0 : 1, stopOrderType: 1 };
  const sl = { isBid: exitIsBid, quantity: 0n, triggerPrice: slTrigger, triggerOperator: long ? 1 : 0, stopOrderType: 1 };
  const size = abs(pos.size);
  const pnlAt = (trigger) => Number(((num(trigger) - num(an.avgEntryPrice)) * (long ? 1 : -1) * Number(fmt(size, mk.baseDecimals))).toFixed(4));
  const human = {
    ...base, side: long ? "long" : "short", size: u.qty(size), entryPrice: u.px(an.avgEntryPrice), markPrice: u.px(mark),
    takeProfitTrigger: u.px(tpTrigger), stopLossTrigger: u.px(slTrigger),
    approxPnlAtTakeProfitUsd: pnlAt(tpTrigger), approxPnlAtStopLossUsd: pnlAt(slTrigger),
    covers: "the whole position at trigger time; one leg firing cancels the other",
    sttHeldUntilCancel: Number(fmt(need)),
  };

  let res;
  try {
    res = await deps.chain.placeStops({ registry: mk.stopRegistry, pool: mk.poolAddress, ...tp, pair: sl, somiPayment: perLeg, gas: 20_000_000n });
  } catch (e) {
    return failTx(deps, e, human);
  }
  const out = { ok: true, ...human, tx: res.hash, block: Number(res.receipt?.blockNumber ?? 0), status: res.receipt?.status ?? null, takeProfitStopId: res.stopOrderId?.toString() ?? null, stopLossStopId: res.pairedStopOrderId?.toString() ?? null, gasUsed: res.receipt?.gasUsed?.toString?.() ?? null };
  try {
    deps.journal.append({ kind: "bracket", sent: true, ...out });
  } catch (e) {
    out.journalError = `the bracket landed but the journal write failed: ${describeError(e)}`;
  }
  return out;
};

// ---- cancel_all --------------------------------------------------------------------------------
// Tears down this account's pending brackets (stops) and any resting orders. pilot's own orders
// are IOC and never rest, so resting orders only exist if the account was used elsewhere.
export const cancelAll = async (deps, { market } = {}) => {
  const client = deps.client();
  const account = deps.account();
  const markets = await client.listPerpMarkets();
  const target = market ? [await findMarket(client, market)] : markets;
  const base = { action: "cancel_all", market: market ? target[0].baseSymbol : "all" };
  let stops;
  try {
    stops = await pendingStops(client, account);
  } catch (e) {
    const error = describeError(e);
    deps.journal.append({ kind: "error", stage: "cancel", sent: false, error, ...base });
    return { ok: false, error, sent: false, next: "nothing was cancelled; try again", ...base };
  }
  const result = { ok: true, ...base, cancelledStops: [], cancelledOrders: [], txs: [] };
  const fail = [];
  for (const mk of target) {
    const ids = stops.filter((s) => String(s.registry).toLowerCase() === mk.stopRegistry?.toLowerCase()).map((s) => s.orderIdRaw);
    if (ids.length) {
      try {
        const r = await deps.chain.cancelStops({ registry: mk.stopRegistry, orderIds: ids, gas: 20_000_000n });
        result.cancelledStops.push(...ids.map((id) => ({ market: mk.baseSymbol, id })));
        result.txs.push({ what: `${ids.length} stop(s) on ${mk.baseSymbol}`, tx: r.hash, status: r.receipt?.status ?? null });
      } catch (e) {
        fail.push(failTx(deps, e, { ...base, market: mk.baseSymbol, stage: "cancel stops" }));
      }
    }
  }
  // Resting orders: only where this account has a position or a stop, or when one market was named
  // (the chain read costs one eth_call per market; nothing resting sends nothing).
  const active = new Set((await client.getMarginAccount(markets[0].marginBank, account).catch(() => ({ activePerpPools: [] }))).activePerpPools.map((p) => String(p).toLowerCase()));
  for (const mk of target) {
    if (!market && !active.has(mk.poolAddress.toLowerCase())) continue;
    try {
      const r = await deps.chain.cancelAll(mk.poolAddress);
      if (r.sent) {
        result.cancelledOrders.push(...r.orderIds.map((id) => ({ market: mk.baseSymbol, id: id.toString() })));
        result.txs.push({ what: `resting orders on ${mk.baseSymbol}`, tx: r.hash, status: r.receipt?.status ?? null });
      }
    } catch (e) {
      fail.push(failTx(deps, e, { ...base, market: mk.baseSymbol, stage: "cancel orders" }));
    }
  }
  result.nothingToCancel = result.cancelledStops.length === 0 && result.cancelledOrders.length === 0 && fail.length === 0;
  if (fail.length) result.failures = fail;
  if (fail.length) result.ok = false;
  try {
    deps.journal.append({ kind: "cancel", sent: result.txs.length > 0, ...result });
  } catch (e) {
    result.journalError = `the cancel landed but the journal write failed: ${describeError(e)}`;
  }
  return result;
};
