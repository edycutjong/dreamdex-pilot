// account, bracket and cancel_all: the tools around the core order flow. Same shape as trader.mjs
// (chain access through `deps`, every outcome journaled and returned as a value):
//   deps.chain  createChain()  placeStops / cancelStops / cancelAll      deps.native()  STT balance (bigint)
import { formatUnits } from "viem";
import { findMarket, units, inflight, busy, ordersToday } from "./trader.mjs";
import { explainExchangeError, isExchangeRefusal, describeError } from "./exchange-errors.mjs";

const abs = (x) => (x < 0n ? -x : x);
const nearestTo = (x, step) => ((x + step / 2n) / step) * step;
const user = (msg) => Object.assign(new Error(msg), { pilotUser: true });
const fmt = (x, d = 18) => formatUnits(BigInt(x), d);
const num = (x, d = 18) => Number(fmt(x, d));

const pendingStops = async (client, account) => client.listPerpStopOrders({ account, status: ["PENDING"], limit: 100 });


// The stops that protect this account on one registry: the indexer's pending list UNION the stop
// ids this journal recorded when pilot armed them, each confirmed live and owned on chain. The
// indexer can lag a just-armed bracket by seconds; the chain read cannot.
const liveStops = async (deps, mk, indexed, rows = deps.journal.read()) => {
  const client = deps.client();
  const account = deps.account().toLowerCase();
  const reg = mk.stopRegistry.toLowerCase();
  const ids = new Set(indexed.filter((s) => String(s.registry).toLowerCase() === reg).map((s) => String(s.orderIdRaw)));
  const cancelled = new Set(rows.filter((e) => e.kind === "cancel").flatMap((e) => (e.cancelledStops ?? []).map((c) => String(c.id))));
  for (const e of rows) {
    if (e.kind !== "bracket" || e.market !== mk.baseSymbol) continue;
    for (const id of [e.takeProfitStopId, e.stopLossStopId]) if (id && !cancelled.has(String(id))) ids.add(String(id));
  }
  const live = [];
  for (const id of ids) {
    const o = await client.getPerpStopOrder({ registry: mk.stopRegistry, orderId: id });
    if (o && String(o.owner).toLowerCase() === account) live.push({ id, isBid: o.isBid, triggerPrice: o.triggerPrice, triggerOperator: o.triggerOperator });
  }
  return live;
};

// Brackets still armed on one market. A bracket closes the WHOLE position at its trigger, so one
// left behind after a close acts on the next position opened in that market, at its old prices.
export const armedBrackets = async (deps, market) => {
  const client = deps.client();
  const mk = await findMarket(client, market);
  return liveStops(deps, mk, await pendingStops(client, deps.account()));
};

// ---- account -----------------------------------------------------------------------------------
export const accountInfo = async (deps) => {
  const client = deps.client();
  const account = deps.account();
  const markets = await client.listPerpMarkets();
  if (!markets.length) throw new Error("the exchange returned no perp markets (indexer or RPC not ready); try again shortly");
  const bank = markets[0].marginBank;
  const [ma, stops, stt] = await Promise.all([
    client.getMarginAccount(bank, account),
    pendingStops(client, account).catch((e) => ({ error: describeError(e) })),
    deps.native ? deps.native().catch(() => null) : null,
  ]);
  const byPool = new Map(markets.map((m) => [m.poolAddress.toLowerCase(), m]));
  // One read pair per active pool, all pools at once; order follows activePerpPools.
  const rows = await Promise.all(ma.activePerpPools.map(async (pool) => {
    const mk = byPool.get(String(pool).toLowerCase());
    if (!mk) return null;
    const ref = { pool: mk.poolAddress, marginBank: mk.marginBank, account };
    const [pos, an] = await Promise.all([client.getPerpPosition(ref), client.getPerpPositionAnalytics(ref).catch(() => null)]);
    if (pos.size === 0n) return null;
    const u = units(mk);
    return {
      market: mk.baseSymbol,
      side: pos.size > 0n ? "long" : "short",
      size: u.qty(abs(pos.size)),
      avgEntryPrice: u.px(pos.avgEntryPrice),
      markPrice: an?.priceable ? u.px(an.markPrice) : null,
      notionalUsd: an?.priceable ? u.usd(an.notional) : null,
      unrealizedPnlUsd: an?.priceable ? u.usd(an.unrealizedPnl) : null,
    };
  }));
  const positions = rows.filter(Boolean);
  // Pending brackets: the indexer's list plus the ids pilot armed (confirmed live on chain), since
  // the indexer lags a fresh bracket by seconds. Read failures are said, never shown as "none".
  let brackets;
  if (Array.isArray(stops)) {
    brackets = [];
    try {
      const rows = deps.journal.read();
      for (const mk of markets) {
        if (!mk.stopRegistry) continue;
        for (const s of await liveStops(deps, mk, stops, rows))
          brackets.push({ id: s.id, market: mk.baseSymbol, closes: s.isBid ? "short (buys)" : "long (sells)", triggerPrice: fmt(s.triggerPrice), when: s.triggerOperator === 0 ? "mark >= trigger" : "mark <= trigger" });
      }
    } catch (e) {
      brackets = { unavailable: describeError(e) };
    }
  } else brackets = { unavailable: stops.error };
  const p = deps.policy();
  return {
    account,
    sttForGas: stt == null ? null : Number(Number(fmt(stt)).toFixed(4)),
    collateralUsdso: { equity: num(ma.equity), unlocked: num(ma.unlockedCollateralBalance), lockedAsMargin: num(ma.lockedCollateral), withdrawable: num(ma.withdrawable) },
    marginStatus: ma.marginStatus,
    marginRequirementsUsd: { initial: num(ma.imReq), maintenance: num(ma.mmReq), closeOut: num(ma.cmReq) },
    positions,
    pendingBrackets: brackets,
    policy: { maxNotionalUsd: p.maxNotionalUsd, allowedMarkets: p.allowedMarkets, dailyOrderCap: p.dailyOrderCap, ordersSentTodayUtc: ordersToday(deps), source: p.source },
    asOfBlock: Number(ma.asOfBlock),
  };
};

// ---- shared failure handling for the stop/cancel transactions ---------------------------------
// Same rules as sendIoc: a revert is the exchange's refusal (decoded), anything else without a
// hash may still have gone out ("unknown") unless the sender proved otherwise.
const failTx = (deps, e, base) => {
  // A stop placement can send two txs (operator grant, then the stop); after a failure which hash
  // belongs to the failing one is unknowable, so all of them are reported, none as "the" tx.
  const txs = Array.isArray(e?.txHashes) ? e.txHashes : null;
  if (txs) base = { ...base, ...(txs.length ? { txsSeen: txs } : {}) };
  const tx = txs ? null : e?.txHash ?? null;
  // A tx may already be out: a journal write that throws must not replace the outcome we return.
  const journalIt = (row) => {
    try {
      deps.journal.append(row);
      return {};
    } catch (err) {
      return { journalError: `the outcome could not be journaled: ${describeError(err)}` };
    }
  };
  if (isExchangeRefusal(e)) {
    const x = explainExchangeError(e);
    const sent = tx || txs?.length ? true : "unknown";
    const j = journalIt({ kind: "refusal", refused_by: "exchange", stage: "chain", sent, tx, code: x.code, reason: x.reason, next: x.next, rawReason: e?.reason ?? null, ...base });
    return { ok: false, refused_by: "exchange", code: x.code, reason: x.reason, next: x.next, tx, sent, ...base, ...j };
  }
  const sent = tx || txs?.length ? true : e?.pilotNotSent ? false : "unknown";
  const error = describeError(e);
  const j = journalIt({ kind: "error", sent, tx, error, ...base });
  return { ok: false, error, sent, tx, next: sent === false ? "nothing was sent; fix the error and try again" : "send status unknown: call account to see what is on chain before trying again", ...base, ...j };
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
  const mk = await findMarket(client, market);
  const u = units(mk);
  const base = { action: "bracket", market: mk.baseSymbol, takeProfitPct: take_profit_pct, stopLossPct: stop_loss_pct };
  if (!mk.stopRegistry) return refusePilot(deps, base, "noStopRegistry", `${mk.baseSymbol} has no stop registry, so it cannot hold a bracket`, "pick another market");
  if (!(take_profit_pct >= 0.1 && take_profit_pct <= 50 && stop_loss_pct >= 0.1 && stop_loss_pct <= 50))
    throw user("take_profit_pct and stop_loss_pct must each be between 0.1 and 50 (percent away from the current mark price).");

  // One bracket (or order) per market at a time, shared with place_order/close_position: two parallel
  // brackets cannot both pass the "no bracket yet" check below.
  const lock = inflight(deps);
  if (lock.markets.has(mk.baseSymbol)) return busy(deps, mk.baseSymbol, "bracket");
  lock.markets.add(mk.baseSymbol);
  try {
    return await bracketLocked(deps, { mk, u, base, take_profit_pct, stop_loss_pct });
  } finally {
    lock.markets.delete(mk.baseSymbol);
  }
};

const bracketLocked = async (deps, { mk, u, base, take_profit_pct, stop_loss_pct }) => {
  const client = deps.client();
  const account = deps.account();
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
  let mine;
  try {
    mine = await liveStops(deps, mk, pending);
  } catch (e) {
    const error = describeError(e);
    deps.journal.append({ kind: "error", stage: "bracket", sent: false, error, ...base });
    return { ok: false, error, sent: false, next: "nothing was sent; try again", ...base };
  }
  if (mine.length) return refusePilot(deps, base, "bracketExists", `${mine.length} pending stop(s) already protect ${mk.baseSymbol} (confirmed on chain)`, "call cancel_all for this market first, then bracket again");
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
  // Rounding to the tick must not move a trigger onto or across the mark.
  if (long ? !(tpTrigger > mark && slTrigger < mark) : !(tpTrigger < mark && slTrigger > mark))
    return refusePilot(deps, base, "triggersTooTight", `at tick ${u.px(tick)} the triggers round onto or across the mark ${u.px(mark)} (take-profit ${u.px(tpTrigger)}, stop-loss ${u.px(slTrigger)})`, "use wider take_profit_pct and stop_loss_pct");
  const exitIsBid = !long; // closing a short buys
  // GTE (0) fires when mark >= trigger, LTE (1) when mark <= trigger. Long: TP above, SL below.
  const tp = { isBid: exitIsBid, quantity: 0n, triggerPrice: tpTrigger, triggerOperator: long ? 0 : 1, stopOrderType: 1 };
  const sl = { isBid: exitIsBid, quantity: 0n, triggerPrice: slTrigger, triggerOperator: long ? 1 : 0, stopOrderType: 1 };
  const size = abs(pos.size);
  const pnlAt = (trigger) => Number(((num(trigger, mk.quoteDecimals ?? 18) - num(an.avgEntryPrice, mk.quoteDecimals ?? 18)) * (long ? 1 : -1) * Number(fmt(size, mk.baseDecimals))).toFixed(4));
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
  // First bracket on this registry: the SDK sent the one-time operator grant before the stop.
  const grantTxs = (res.txsSent ?? []).filter((h) => h !== res.hash);
  const out = { ok: true, ...human, ...(grantTxs.length ? { operatorGrantTxs: grantTxs, operatorGrantNote: "one-time: lets this stop registry place the triggered reduce-only order for the account" } : {}), tx: res.hash, block: Number(res.receipt?.blockNumber ?? 0), status: res.receipt?.status ?? null, takeProfitStopId: res.stopOrderId?.toString() ?? null, stopLossStopId: res.pairedStopOrderId?.toString() ?? null, gasUsed: res.receipt?.gasUsed?.toString?.() ?? null };
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
// Stops come from the indexer plus the ids pilot's own journal armed, each confirmed live on chain
// (the indexer lags a fresh bracket); resting orders are looked for on every target market.
// "nothingToCancel" is only said when every read succeeded.
export const cancelAll = async (deps, { market } = {}) => {
  const client = deps.client();
  const account = deps.account();
  const markets = await client.listPerpMarkets();
  const target = market ? [await findMarket(client, market)] : markets;
  const base = { action: "cancel_all", market: market ? target[0].baseSymbol : "all" };
  const lock = inflight(deps);
  const busyOn = target.find((mk) => lock.markets.has(mk.baseSymbol));
  if (busyOn) return busy(deps, busyOn.baseSymbol, "cancel_all");
  for (const mk of target) lock.markets.add(mk.baseSymbol);
  try {
    return await cancelLocked(deps, { client, account, target, base });
  } finally {
    for (const mk of target) lock.markets.delete(mk.baseSymbol);
  }
};

const cancelLocked = async (deps, { client, account, target, base }) => {
  let indexed;
  try {
    indexed = await pendingStops(client, account);
  } catch (e) {
    const error = describeError(e);
    deps.journal.append({ kind: "error", stage: "cancel", sent: false, error, ...base });
    return { ok: false, error, sent: false, next: "nothing was cancelled; try again", ...base };
  }
  const result = { ok: true, ...base, cancelledStops: [], cancelledOrders: [], txs: [] };
  const fail = [];
  let journalRows;
  const success = (r) => (r.receipt?.status ?? "success") === "success";
  for (const mk of target) {
    if (!mk.stopRegistry) continue;
    let live;
    try {
      live = await liveStops(deps, mk, indexed, (journalRows ??= deps.journal.read()));
    } catch (e) {
      fail.push({ ok: false, market: mk.baseSymbol, stage: "read stops", error: describeError(e), sent: false });
      continue;
    }
    if (!live.length) continue;
    const ids = live.map((s) => s.id);
    try {
      const r = await deps.chain.cancelStops({ registry: mk.stopRegistry, orderIds: ids, gas: 20_000_000n });
      if (!success(r)) throw Object.assign(new Error(`the cancel tx ${r.hash} did not succeed (${r.receipt?.status})`), { txHash: r.hash });
      result.cancelledStops.push(...ids.map((id) => ({ market: mk.baseSymbol, id })));
      result.txs.push({ what: `${ids.length} stop(s) on ${mk.baseSymbol}`, tx: r.hash, status: r.receipt?.status ?? null });
    } catch (e) {
      fail.push(failTx(deps, e, { ...base, market: mk.baseSymbol, stage: "cancel stops" }));
    }
  }
  for (const mk of target) {
    try {
      const r = await deps.chain.cancelAll(mk.poolAddress);
      if (!r.sent) continue;
      if (!success(r)) throw Object.assign(new Error(`the cancel tx ${r.hash} did not succeed (${r.receipt?.status})`), { txHash: r.hash });
      result.cancelledOrders.push(...r.orderIds.map((id) => ({ market: mk.baseSymbol, id: id.toString() })));
      result.txs.push({ what: `resting orders on ${mk.baseSymbol}`, tx: r.hash, status: r.receipt?.status ?? null });
    } catch (e) {
      fail.push(failTx(deps, e, { ...base, market: mk.baseSymbol, stage: "cancel orders" }));
    }
  }
  result.nothingToCancel = result.cancelledStops.length === 0 && result.cancelledOrders.length === 0 && fail.length === 0;
  if (result.nothingToCancel) result.checked = "indexer pending stops + the brackets this journal armed (confirmed on chain) + resting orders on each market";
  if (fail.length) {
    result.failures = fail;
    result.ok = false;
  }
  // `sent` stays honest when a failure may have broadcast: true / "unknown" beat false.
  const maybeSent = fail.some((f) => f.sent === true || f.sent === "unknown" || f.tx || f.txsSeen);
  try {
    deps.journal.append({ kind: "cancel", sent: result.txs.length > 0 ? true : maybeSent ? "unknown" : false, ...result });
  } catch (e) {
    result.journalError = `the cancel landed but the journal write failed: ${describeError(e)}`;
  }
  return result;
};
