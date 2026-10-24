// The core flow: plan_order -> place_order(plan_id) -> close_position, every step journaled.
// Pure money math is exported for tests; chain access comes in through `deps`:
//   deps.client()  SDK read client          deps.account()  trading address (no key needed)
//   deps.send(p)   trader.placePerpOrder(p); a thrown error carries `txHash` when a tx was mined
//   deps.journal   createJournal()          deps.policy()   loadPolicy()
//   deps.plans     Map of live plans        deps.now()      ms clock (tests freeze it)
import { randomBytes } from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { evaluate } from "./policy.mjs";
import { explainExchangeError, isExchangeRefusal, describeError } from "./exchange-errors.mjs";

// Report 009 (sieve): successful IOC orders used up to 13.4M gas, above the documented ~1.56M
// and the bot-kit's 10M; 20M leaves room. Testnet gas is cheap, a reverted out-of-gas order is not.
export const GAS = 20_000_000n;
// Order type 2 = immediate-or-cancel: fills what it can at the limit, never rests on the book.
export const IOC = 2;

const abs = (x) => (x < 0n ? -x : x);
const floorTo = (x, step) => (x / step) * step;
const ceilTo = (x, step) => ((x + step - 1n) / step) * step;

// Limit price with slippage room off the touch, kept on the tick grid and inside the slippage bound:
// a buy floors (never above ask + slippage), a sell ceils (never below bid - slippage).
export const limitPrice = ({ isBid, bid, ask, tick, slippagePct }) => {
  const bps = BigInt(Math.round(slippagePct * 100));
  return isBid ? floorTo((ask * (10_000n + bps)) / 10_000n, tick) : ceilTo((bid * (10_000n - bps)) / 10_000n, tick);
};

export const notionalRaw = (quantity, price, baseDecimals) => (quantity * price) / 10n ** BigInt(baseDecimals);

// Distance from mark to the projected liquidation price in %. null = no reachable liquidation
// price: the SDK returns 0/null for a position too small to liquidate (e.g. 0.2x long), and that
// must read as "safe", never as distance 0.
export const liquidationDistancePct = (liq, mark) => {
  if (liq == null || liq <= 0n || mark <= 0n) return null;
  return (Number(abs(mark - liq)) / Number(mark)) * 100;
};

const findMarket = async (client, symbol) => {
  const want = symbol.toUpperCase();
  const mk = (await client.listPerpMarkets()).find((p) => p.baseSymbol === want);
  if (!mk) throw Object.assign(new Error(`No perp market named ${want}. Call markets to see all of them.`), { pilotUser: true });
  return mk;
};

const readTouch = async (client, mk) => {
  const t = (await client.getBookTopsOnchain([{ id: mk.id, poolAddress: mk.poolAddress }])).tops[mk.poolAddress];
  return { bid: BigInt(t?.bestBid ?? 0), ask: BigInt(t?.bestAsk ?? 0) };
};

const units = (mk) => {
  const q = mk.quoteDecimals ?? 18;
  const b = mk.baseDecimals;
  return {
    px: (x) => (x == null ? null : formatUnits(BigInt(x), q)),
    usd: (x) => Number(formatUnits(BigInt(x), q)),
    qty: (x) => (x == null ? null : formatUnits(BigInt(x), b)),
  };
};

const newPlanId = () => `plan_${randomBytes(6).toString("hex")}`;

// Signed exposure in a market after an order, as USD notional at the order's limit price.
const exposureUsd = (u, posSize, signedQty, price, baseDecimals) => u.usd(notionalRaw(abs(posSize + signedQty), price, baseDecimals));

export const planOrder = async (deps, { market, side, size, notionalUsd }) => {
  const policy = deps.policy();
  for (const [id, p] of deps.plans) if (p.used || deps.now() > p.expiresAt) deps.plans.delete(id); // sweep dead plans
  const client = deps.client();
  const account = deps.account();
  const mk = await findMarket(client, market);
  const u = units(mk);
  const isBid = side === "long";
  const tick = BigInt(mk.tickSize);
  const lot = BigInt(mk.lotSize);
  const minQ = BigInt(mk.minQuantity);
  const q = mk.quoteDecimals ?? 18;

  const touch = await readTouch(client, mk);
  if ((isBid && touch.ask === 0n) || (!isBid && touch.bid === 0n)) {
    const row = deps.journal.append({ kind: "refusal", refused_by: "pilot-policy", stage: "plan", action: "open", market: mk.baseSymbol, side, rules: ["emptyBook"] });
    return { verdict: "refused", market: mk.baseSymbol, side, refusals: [{ rule: "emptyBook", detail: `no ${isBid ? "asks" : "bids"} on the ${mk.baseSymbol} book to fill against`, next: "try later or another market" }], journaled: row.at };
  }
  const price = limitPrice({ isBid, ...touch, tick, slippagePct: policy.maxSlippagePct });

  let quantity;
  if (size != null) quantity = floorTo(parseUnits(String(size), mk.baseDecimals), lot);
  // toFixed: a tiny number must not reach parseUnits as "1e-7".
  else quantity = floorTo((parseUnits(Number(notionalUsd).toFixed(q), q) * 10n ** BigInt(mk.baseDecimals)) / price, lot);

  const capQty = floorTo((parseUnits(Number(policy.maxNotionalUsd).toFixed(q), q) * 10n ** BigInt(mk.baseDecimals)) / price, lot);
  const policyFacts = (dist, notional, room = capQty) => ({
    market: mk.baseSymbol,
    notionalUsd: notional,
    maxSizeUnderCap: `${u.qty(room > 0n ? room : 0n)} ${mk.baseSymbol}`,
    liquidationDistancePct: dist,
    ordersToday: deps.journal.ordersToday(new Date(deps.now())),
  });
  // Below the market minimum (a size that floors to 0 on the lot grid included) the SDK previews
  // throw, so refuse here, before any preview, and still name every policy rule it breaks.
  if (quantity < minQ) {
    const refusals = [
      ...evaluate(policy, policyFacts(null, u.usd(notionalRaw(quantity, price, mk.baseDecimals)))),
      { rule: "minQuantity", detail: `size ${u.qty(quantity)} ${mk.baseSymbol} (after rounding to the ${u.qty(lot)} lot) is below the ${mk.baseSymbol} minimum ${u.qty(minQ)}`, next: `plan at least ${u.qty(minQ)} ${mk.baseSymbol}` },
    ];
    const human = { market: mk.baseSymbol, side, size: u.qty(quantity), requestedSize: size ?? null, limitPrice: u.px(price), minSize: u.qty(minQ), lotSize: u.qty(lot) };
    const row = deps.journal.append({ kind: "refusal", refused_by: "pilot-policy", stage: "plan", action: "open", ...human, rules: refusals.map((r) => r.rule), refusals });
    return { verdict: "refused", refused_by: "pilot-policy", ...human, refusals, policy: policySummary(policy), journaled: row.at };
  }

  const ref = { pool: mk.poolAddress, marginBank: mk.marginBank, account };
  const [max, margin, liq, pos] = await Promise.all([
    client.getMaxPerpOrderSize({ ...ref, isBid, price }),
    client.previewPerpOrderMargin({ ...ref, isBid, quantity, price }),
    client.previewPerpLiquidationPrice({ ...ref, isBid, quantity, price }),
    client.getPerpPosition(ref),
  ]);

  const notional = u.usd(notionalRaw(quantity, price, mk.baseDecimals));
  // The notional cap is on the position this order leaves, not on the order alone: twenty $25
  // orders must not stack into a $500 position. A reducing order shrinks exposure.
  const signedQty = isBid ? quantity : -quantity;
  const exposure = exposureUsd(u, pos.size, signedQty, price, mk.baseDecimals);
  const sameSide = (isBid ? pos.size : -pos.size); // > 0: the position already leans this way
  const markRaw = liq?.markPrice ?? margin?.markPrice ?? mk.markPrice;
  const mark = markRaw == null ? 0n : BigInt(markRaw);
  const liqPrice = liq?.priceable ? liq.projectedLiquidationPrice : null;
  const dist = liquidationDistancePct(liqPrice, mark);

  const refusals = evaluate(policy, policyFacts(dist, exposure, capQty - sameSide));
  // A preview the chain could not price is unknown, not safe: never let it read as "no liquidation".
  if (!liq?.priceable || mark === 0n)
    refusals.push({ rule: "liquidationUnknown", detail: "the exchange could not price a liquidation preview for this order", next: "plan again shortly; check markets for a mark price" });
  if (!margin?.priceable)
    refusals.push({ rule: "marginUnknown", detail: "the exchange could not price a margin preview for this order", next: "plan again shortly" });
  // What the exchange itself would refuse, caught before a tx is sent.
  // Report 006 (sieve): the docs' list of voucher-closed markets disagrees with the chain, so the
  // chain's own preview decides, never a hard-coded list.
  if (margin?.priceable && margin.voucherBlocked)
    refusals.push({ rule: "voucherBlocked", detail: `${mk.baseSymbol} is closed to voucher (paper USDso) margin for this account`, next: "pick a market the voucher allows" });
  // Report 002 (sieve): the per-account cap is not the documented tenth of open interest; the
  // chain's max-size read is the only reliable bound.
  if (!max?.priceable || !max.placeable || max.maxQuantity < quantity)
    refusals.push({ rule: "exchangeMaxSize", detail: `the exchange would accept at most ${max?.priceable ? u.qty(max.maxQuantity) : "nothing priceable"} ${mk.baseSymbol} here (limited by ${max?.limitedBy ?? "unknown"})`, next: "plan a smaller size" });
  else if (margin?.priceable && (!margin.meetsInitialMargin || !margin.hasCollateralForLock))
    refusals.push({ rule: "margin", detail: `margin preview: initial margin ${margin.meetsInitialMargin ? "met" : "NOT met"}, collateral for lock ${margin.hasCollateralForLock ? "yes" : "NO"}`, next: "plan a smaller size or deposit USDso" });

  const human = {
    market: mk.baseSymbol,
    side,
    size: u.qty(quantity),
    limitPrice: u.px(price),
    orderType: "IOC (fills now or not at all, never rests)",
    touch: { bid: u.px(touch.bid), ask: u.px(touch.ask) },
    markPrice: u.px(mark),
    notionalUsd: Number(notional.toFixed(4)),
    positionNow: u.qty(pos.size),
    positionAfter: u.qty(pos.size + signedQty),
    positionNotionalAfterUsd: Number(exposure.toFixed(4)),
    marginLockUsd: margin?.priceable ? Number(u.usd(margin.lockAmount).toFixed(4)) : null,
    projectedLeverageX: liq?.priceable && liq.projectedPositionLeverageBps != null ? Number(liq.projectedPositionLeverageBps) / 10_000 : null,
    liquidationPrice: liqPrice != null && liqPrice > 0n ? u.px(liqPrice) : null,
    liquidationDistancePct: dist == null ? null : Number(dist.toFixed(2)),
    liquidationNote: dist == null ? "no reachable liquidation price at this size" : undefined,
    exchangeMaxSize: max?.priceable ? u.qty(max.maxQuantity) : null,
    limitedBy: max?.limitedBy ?? null,
  };

  if (refusals.length) {
    const row = deps.journal.append({ kind: "refusal", refused_by: "pilot-policy", stage: "plan", action: "open", ...human, rules: refusals.map((r) => r.rule), refusals });
    return { verdict: "refused", refused_by: "pilot-policy", ...human, refusals, policy: policySummary(policy), journaled: row.at };
  }

  const plan_id = newPlanId();
  const expiresAt = deps.now() + policy.planTtlSec * 1000;
  deps.plans.set(plan_id, {
    expiresAt, used: false, human,
    raw: { symbol: mk.baseSymbol, pool: mk.poolAddress, marginBank: mk.marginBank, id: mk.id, isBid, price, quantity, baseDecimals: mk.baseDecimals, quoteDecimals: q, liquidationDistancePct: dist, positionNotionalAfterUsd: exposure },
  });
  deps.journal.append({ kind: "plan", plan_id, action: "open", ...human, expiresAt: new Date(expiresAt).toISOString() });
  return { verdict: "ok", plan_id, expiresInSec: policy.planTtlSec, ...human, policy: policySummary(policy), next: `call place_order with plan_id ${plan_id} within ${policy.planTtlSec}s to send it` };
};

const policySummary = (p) => ({ maxNotionalUsd: p.maxNotionalUsd, minLiquidationDistancePct: p.minLiquidationDistancePct, allowedMarkets: p.allowedMarkets, dailyOrderCap: p.dailyOrderCap });

const refuseAll = (deps, refusals, extra = {}) => {
  deps.journal.append({ kind: "refusal", refused_by: "pilot-policy", stage: "place", action: "open", rules: refusals.map((r) => r.rule), refusals, ...extra });
  const [first] = refusals;
  return { ok: false, refused_by: "pilot-policy", rule: first.rule, reason: first.detail, next: first.next, refusals, ...extra };
};
const refuse = (deps, rule, detail, next, extra = {}) => refuseAll(deps, [{ rule, detail, next }], extra);

// Sends in flight on this server: opens count toward the daily cap before their journal row
// exists, and one order per market at a time, open or close (a close is not reduce-only on
// chain, so two parallel closes sized from the same read would flip the position, and an open
// racing a close would be sized against a position about to change).
const inflight = (deps) => (deps.inflight ??= { opens: 0, markets: new Set() });
const busy = (deps, symbol, action) => ({ ok: false, action, market: symbol, reason: `an order on ${symbol} is already in flight`, next: "wait for it to finish, then try again" });

// A failure that is not the send itself (a read before it): nothing went out.
const failedBeforeSend = (deps, e, extra) => {
  const error = describeError(e);
  deps.journal.append({ kind: "error", stage: extra.stage, sent: false, error, ...extra });
  return { ok: false, error, sent: false, next: "nothing was sent; plan again", ...extra };
};

// One IOC send + read-back, shared by place_order and close_position. Exchange refusals and other
// failures come back as values (journaled), never as thrown errors.
const sendIoc = async (deps, { action, raw, plan_id, extra = {} }) => {
  const u = units({ quoteDecimals: raw.quoteDecimals, baseDecimals: raw.baseDecimals });
  const order = { pool: raw.pool, isBid: raw.isBid, price: raw.price, quantity: raw.quantity, orderType: IOC, gas: GAS };
  const direction = action === "open" ? (raw.isBid ? "long" : "short") : raw.isBid ? "close short" : "close long";
  const base = { action, plan_id, market: raw.symbol, side: raw.isBid ? "buy" : "sell", direction, size: u.qty(raw.quantity), limitPrice: u.px(raw.price), ...extra };
  let res;
  try {
    res = await deps.send(order);
  } catch (e) {
    const tx = e?.txHash ?? null;
    if (isExchangeRefusal(e)) {
      const x = explainExchangeError(e);
      // A revert without a captured hash still most likely went out: count it ("unknown").
      deps.journal.append({ kind: "refusal", refused_by: "exchange", stage: "chain", sent: tx ? true : "unknown", tx, code: x.code, reason: x.reason, next: x.next, rawReason: e?.reason ?? null, ...base });
      return { ok: false, refused_by: "exchange", code: x.code, reason: x.reason, next: x.next, tx, ...base };
    }
    // Without a hash a tx may still have gone out (a timeout after broadcast): "unknown", which
    // the daily cap counts, unless the sender proved nothing was sent (e.g. no key configured).
    const sent = tx ? true : e?.pilotNotSent ? false : "unknown";
    const msg = describeError(e);
    deps.journal.append({ kind: "error", sent, tx, error: msg, ...base });
    const next = sent === false ? "nothing was sent; fix the error and plan again" : "send status unknown: check the position (close_position reads it live) and the explorer before trying again";
    return { ok: false, error: msg, sent, tx, next, ...base };
  }
  // From here a real tx exists: nothing below may throw before its row is journaled.
  const filled = (res.fills ?? []).reduce((s, f) => s + BigInt(f.quantityFilled), 0n);
  let positionAfter = null;
  let readBack;
  try {
    // Report 016 (sieve): margin/equity reads can pin a block from before our own receipt;
    // getPerpPosition reads at latest, so it is the read-back.
    positionAfter = u.qty((await deps.client().getPerpPosition({ pool: raw.pool, marginBank: raw.marginBank, account: deps.account() })).size);
  } catch (e) {
    readBack = `the order landed but the position read-back failed (${describeError(e)}); close_position reads it live`;
  }
  const out = {
    ok: true, ...base, tx: res.hash, block: Number(res.receipt?.blockNumber ?? 0), status: res.receipt?.status ?? null,
    gasUsed: res.receipt?.gasUsed?.toString?.() ?? null, orderId: res.orderId?.toString() ?? null,
    filled: u.qty(filled), requested: u.qty(raw.quantity), positionAfter, ...(readBack ? { readBack } : {}),
  };
  deps.journal.append({ kind: action === "close" ? "close" : "order", sent: true, ...out });
  return out;
};

export const placeOrder = async (deps, { plan_id }) => {
  const policy = deps.policy();
  const s = inflight(deps);
  const p = deps.plans.get(plan_id);
  if (!p) return refuse(deps, "unknownPlan", `no live plan ${plan_id}: plans live in this server's memory only and are one-shot`, "call plan_order first", { plan_id });
  if (p.used) return refuse(deps, "planAlreadyUsed", `plan ${plan_id} was already sent once`, "call plan_order for a new plan", { plan_id });
  const { raw } = p;
  if (s.markets.has(raw.symbol)) return busy(deps, raw.symbol, "open"); // plan stays usable
  // Claimed synchronously, before any await: two parallel calls with one plan_id cannot both pass.
  p.used = true;
  if (deps.now() > p.expiresAt) {
    deps.plans.delete(plan_id);
    return refuse(deps, "planExpired", `plan ${plan_id} expired ${Math.round((deps.now() - p.expiresAt) / 1000)}s ago (plans live ${policy.planTtlSec}s)`, "call plan_order again for fresh prices", { plan_id });
  }
  const u = units({ quoteDecimals: raw.quoteDecimals, baseDecimals: raw.baseDecimals });
  // The policy is read again at send time: limits the user tightened after the plan still apply.
  const refusals = evaluate(policy, {
    market: raw.symbol,
    notionalUsd: raw.positionNotionalAfterUsd,
    liquidationDistancePct: raw.liquidationDistancePct,
    ordersToday: deps.journal.ordersToday(new Date(deps.now())) + s.opens,
  });
  if (refusals.length) return refuseAll(deps, refusals, { plan_id });

  s.opens++;
  s.markets.add(raw.symbol);
  try {
    let touch, pos;
    try {
      [touch, pos] = await Promise.all([
        readTouch(deps.client(), { id: raw.id, poolAddress: raw.pool }),
        deps.client().getPerpPosition({ pool: raw.pool, marginBank: raw.marginBank, account: deps.account() }),
      ]);
    } catch (e) {
      return failedBeforeSend(deps, e, { stage: "place", action: "open", plan_id, market: raw.symbol });
    }
    // Freshness: the book can move between plan and place. If the touch is now beyond the plan's
    // limit, the plan's numbers are stale; refuse rather than send an IOC that will not fill.
    const moved = raw.isBid ? touch.ask === 0n || touch.ask > raw.price : touch.bid === 0n || touch.bid < raw.price;
    if (moved) return refuse(deps, "stalePlan", `the ${raw.isBid ? "ask" : "bid"} moved to ${u.px(raw.isBid ? touch.ask : touch.bid)}, past the plan's limit ${u.px(raw.price)}`, "call plan_order again", { plan_id });
    // The position may have changed since the plan (another client, a liquidation): the
    // exposure cap is checked against the live one.
    const exposure = exposureUsd(u, pos.size, raw.isBid ? raw.quantity : -raw.quantity, raw.price, raw.baseDecimals);
    if (exposure > policy.maxNotionalUsd)
      return refuse(deps, "maxNotionalUsd", `the live position makes this order's resulting notional $${exposure.toFixed(2)}, above the $${policy.maxNotionalUsd} cap`, "plan again against the current position", { plan_id });
    return await sendIoc(deps, { action: "open", raw, plan_id });
  } finally {
    s.opens--;
    s.markets.delete(raw.symbol);
  }
};

// Closing reduces risk, so policy never blocks it (not the allowlist, not the daily cap). The size
// comes from the live position (getPerpPosition), never from remembered fills.
export const closePosition = async (deps, { market }) => {
  const policy = deps.policy();
  const client = deps.client();
  const mk = await findMarket(client, market);
  const u = units(mk);
  const s = inflight(deps);
  if (s.markets.has(mk.baseSymbol)) return busy(deps, mk.baseSymbol, "close");
  s.markets.add(mk.baseSymbol);
  try {
    return await closeLocked(deps, { policy, client, mk, u });
  } catch (e) {
    return failedBeforeSend(deps, e, { stage: "close", action: "close", market: mk.baseSymbol });
  } finally {
    s.markets.delete(mk.baseSymbol);
  }
};

const closeLocked = async (deps, { policy, client, mk, u }) => {
  const pos = await client.getPerpPosition({ pool: mk.poolAddress, marginBank: mk.marginBank, account: deps.account() });
  if (pos.size === 0n) return { ok: true, action: "close", market: mk.baseSymbol, status: "already flat", positionAfter: "0" };
  const isBid = pos.size < 0n; // a short closes with a buy
  const touch = await readTouch(client, mk);
  if ((isBid && touch.ask === 0n) || (!isBid && touch.bid === 0n))
    return { ok: false, action: "close", market: mk.baseSymbol, reason: `no ${isBid ? "asks" : "bids"} on the book to close against`, next: "try again shortly", positionBefore: u.qty(pos.size) };
  const price = limitPrice({ isBid, ...touch, tick: BigInt(mk.tickSize), slippagePct: policy.maxSlippagePct });
  const raw = { symbol: mk.baseSymbol, pool: mk.poolAddress, marginBank: mk.marginBank, id: mk.id, isBid, price, quantity: abs(pos.size), baseDecimals: mk.baseDecimals, quoteDecimals: mk.quoteDecimals ?? 18 };
  return sendIoc(deps, { action: "close", raw, extra: { positionBefore: u.qty(pos.size) } });
};
