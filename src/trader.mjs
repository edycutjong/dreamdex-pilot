// The core flow: plan_order -> place_order(plan_id) -> close_position, every step journaled.
// Pure money math is exported for tests; chain access comes in through `deps`:
//   deps.client()  SDK read client          deps.account()  trading address (no key needed)
//   deps.send(p)   trader.placePerpOrder(p); a thrown error carries `txHash` when a tx was mined
//   deps.journal   createJournal()          deps.policy()   loadPolicy()
//   deps.plans     Map of live plans        deps.now()      ms clock (tests freeze it)
import { randomBytes } from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { evaluate, DEFAULT_POLICY } from "./policy.mjs";
import { explainExchangeError, isExchangeRefusal, describeError } from "./exchange-errors.mjs";

// Report 009 (sieve): successful IOC orders used up to 13.4M gas, above the documented ~1.56M
// and the bot-kit's 10M; 20M leaves room. Testnet gas is cheap, a reverted out-of-gas order is not.
export const GAS = 20_000_000n;
// Order type 2 = immediate-or-cancel: fills what it can at the limit, never rests on the book.
export const IOC = 2;

const abs = (x) => (x < 0n ? -x : x);
const floorTo = (x, step) => (x / step) * step;
const ceilTo = (x, step) => ((x + step - 1n) / step) * step;
const ceilDiv = (a, b) => (a + b - 1n) / b;

// Limit price with slippage room off the touch, kept on the tick grid and inside the slippage bound:
// a buy floors (never above ask + slippage), a sell ceils (never below bid - slippage). The budget
// is whole basis points, floored so rounding never widens it (the epsilon absorbs float noise:
// 0.29 * 100 = 28.999...).
export const limitPrice = ({ isBid, bid, ask, tick, slippagePct }) => {
  const bps = BigInt(Math.floor(slippagePct * 100 + 1e-9));
  return isBid ? floorTo((ask * (10_000n + bps)) / 10_000n, tick) : ceilTo(ceilDiv(bid * (10_000n - bps), 10_000n), tick);
};

export const notionalRaw = (quantity, price, baseDecimals) => (quantity * price) / 10n ** BigInt(baseDecimals);

// Distance from mark to the projected liquidation price in %. null = no reachable liquidation
// price: the SDK returns 0/null for a position too small to liquidate (e.g. 0.2x long), and that
// must read as "safe", never as distance 0.
export const liquidationDistancePct = (liq, mark) => {
  if (liq == null || liq <= 0n || mark <= 0n) return null;
  return (Number(abs(mark - liq)) / Number(mark)) * 100;
};

export const findMarket = async (client, symbol) => {
  const want = symbol.toUpperCase();
  const mk = (await client.listPerpMarkets()).find((p) => p.baseSymbol === want);
  if (!mk) throw Object.assign(new Error(`No perp market named ${want}. Call markets to see all of them.`), { pilotUser: true });
  return mk;
};

export const readTouch = async (client, mk) => {
  const t = (await client.getBookTopsOnchain([{ id: mk.id, poolAddress: mk.poolAddress }])).tops[mk.poolAddress];
  return { bid: BigInt(t?.bestBid ?? 0), ask: BigInt(t?.bestAsk ?? 0) };
};

export const units = (mk) => {
  const q = mk.quoteDecimals ?? 18;
  const b = mk.baseDecimals;
  return {
    px: (x) => (x == null ? null : formatUnits(BigInt(x), q)),
    usd: (x) => Number(formatUnits(BigInt(x), q)),
    qty: (x) => (x == null ? null : formatUnits(BigInt(x), b)),
  };
};

const newPlanId = () => `plan_${randomBytes(6).toString("hex")}`;
// A plan stays in memory this long after it expires, so a late or repeated place_order is told
// what became of it (expired, sent, refused) instead of "no plan"; then it is forgotten.
export const PLAN_MEMORY_MS = 10 * 60_000;

// Signed exposure in a market after an order, as USD notional at `price`.
const exposureUsd = (u, posSize, signedQty, price, baseDecimals) => u.usd(notionalRaw(abs(posSize + signedQty), price, baseDecimals));

export const planOrder = async (deps, { market, side, size, notionalUsd }) => {
  const policy = deps.policy();
  for (const [id, p] of deps.plans) if (deps.now() > p.expiresAt + PLAN_MEMORY_MS) deps.plans.delete(id); // forget old plans
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
  // Notional (the cap, notional_usd sizing) is valued at the highest price the order can fill at:
  // a buy pays at most its limit, but a sell fills at the bids from the top bid down to its limit,
  // so at its limit a short would pass the cap and then fill above it.
  const capPx = isBid || touch.bid < price ? price : touch.bid;

  let quantity;
  if (size != null) quantity = floorTo(parseUnits(String(size), mk.baseDecimals), lot);
  // toFixed: a tiny number must not reach parseUnits as "1e-7".
  else quantity = floorTo((parseUnits(Number(notionalUsd).toFixed(q), q) * 10n ** BigInt(mk.baseDecimals)) / capPx, lot);

  const capQty = floorTo((parseUnits(Number(policy.maxNotionalUsd).toFixed(q), q) * 10n ** BigInt(mk.baseDecimals)) / capPx, lot);
  // `leaning` > 0: the position already leans the order's way, so reducing it is what frees room.
  const policyFacts = (dist, notional, room = capQty, leaning = 0n) => ({
    market: mk.baseSymbol,
    notionalUsd: notional,
    maxSizeUnderCap: `${u.qty(room > 0n ? room : 0n)} ${mk.baseSymbol}`,
    // Room under the cap that is below the market minimum is no next step at all: say no order fits.
    capNext: room < minQ
      ? `no ${mk.baseSymbol} order fits under the cap: the room left is ${u.qty(room > 0n ? room : 0n)} ${mk.baseSymbol}, below the ${mk.baseSymbol} minimum ${u.qty(minQ)}; ${leaning > 0n ? `close_position or a reducing order frees room` : `pick another market or raise maxNotionalUsd in policy.json yourself`}`
      : undefined,
    liquidationDistancePct: dist,
    ordersToday: ordersToday(deps),
  });
  // Below the market minimum (a size that floors to 0 on the lot grid included) the SDK previews
  // throw, so refuse here, before any preview, and still name every policy rule it breaks.
  if (quantity < minQ) {
    const refusals = [
      ...evaluate(policy, policyFacts(null, u.usd(notionalRaw(quantity, capPx, mk.baseDecimals)))),
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

  const notional = u.usd(notionalRaw(quantity, capPx, mk.baseDecimals));
  // The notional cap is on the position this order leaves, not on the order alone: twenty $25
  // orders must not stack into a $500 position. A reducing order shrinks exposure.
  const signedQty = isBid ? quantity : -quantity;
  const exposure = exposureUsd(u, pos.size, signedQty, capPx, mk.baseDecimals);
  const sameSide = (isBid ? pos.size : -pos.size); // > 0: the position already leans this way
  const markRaw = liq?.markPrice ?? margin?.markPrice ?? mk.markPrice;
  const mark = markRaw == null ? 0n : BigInt(markRaw);
  const liqPrice = liq?.priceable ? liq.projectedLiquidationPrice : null;
  const dist = liquidationDistancePct(liqPrice, mark);

  const refusals = evaluate(policy, policyFacts(dist, exposure, capQty - sameSide, sameSide));
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
    raw: { symbol: mk.baseSymbol, pool: mk.poolAddress, marginBank: mk.marginBank, id: mk.id, isBid, price, tick, markPrice: mark, quantity, baseDecimals: mk.baseDecimals, quoteDecimals: q, liquidationDistancePct: dist, positionNotionalAfterUsd: exposure, positionSize: pos.size },
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
export const inflight = (deps) => (deps.inflight ??= { opens: 0, markets: new Set(), unjournaled: [] });
// Opens sent today (UTC) for the daily cap: the journal's count plus any open whose journal row
// failed to write after it landed (kept in memory as its UTC day, so the cap still sees it).
export const ordersToday = (deps) => {
  const now = new Date(deps.now());
  const day = now.toISOString().slice(0, 10);
  return deps.journal.ordersToday(now) + inflight(deps).unjournaled.filter((d) => d === day).length;
};
export const busy = (deps, symbol, action) => ({ ok: false, action, market: symbol, reason: `an order on ${symbol} is already in flight`, next: "wait for it to finish, then try again" });

// A failure that is not the send itself (a read before it): nothing went out.
const failedBeforeSend = (deps, e, extra) => {
  const error = describeError(e);
  deps.journal.append({ kind: "error", stage: extra.stage, sent: false, error, ...extra });
  return { ok: false, error, sent: false, next: "nothing was sent; plan again", ...extra };
};

// One IOC send + read-back, shared by place_order and close_position. Exchange refusals and other
// failures come back as values (journaled), never as thrown errors.
const sendIoc = async (deps, { action, raw, plan_id, extra = {}, check }) => {
  const u = units({ quoteDecimals: raw.quoteDecimals, baseDecimals: raw.baseDecimals });
  const order = { pool: raw.pool, isBid: raw.isBid, price: raw.price, quantity: raw.quantity, orderType: IOC, gas: GAS };
  const direction = action === "open" ? (raw.isBid ? "long" : "short") : raw.isBid ? "close short" : "close long";
  const base = { action, plan_id, market: raw.symbol, side: raw.isBid ? "buy" : "sell", direction, size: u.qty(raw.quantity), limitPrice: u.px(raw.price), ...extra };
  let res;
  try {
    res = await (check ? deps.send(order, check) : deps.send(order));
  } catch (e) {
    // The re-check inside the writer queue refused it: nothing was broadcast.
    if (e?.pilotRefusals) return refuseAll(deps, e.pilotRefusals, { plan_id, stage: "send" });
    const tx = e?.txHash ?? null;
    if (isExchangeRefusal(e)) {
      const x = explainExchangeError(e);
      // A revert without a captured hash still most likely went out: count it ("unknown").
      const row = { kind: "refusal", refused_by: "exchange", stage: "chain", sent: tx ? true : "unknown", tx, code: x.code, reason: x.reason, next: x.next, rawReason: e?.reason ?? null, ...base };
      return journalAfterSend(deps, action, row, { ok: false, refused_by: "exchange", code: x.code, reason: x.reason, next: x.next, tx, ...base });
    }
    // Without a hash a tx may still have gone out (a timeout after broadcast): "unknown", which
    // the daily cap counts, unless the sender proved nothing was sent (e.g. no key configured).
    const sent = tx ? true : e?.pilotNotSent ? false : "unknown";
    const msg = describeError(e);
    const next = sent === false ? "nothing was sent; fix the error and plan again" : "send status unknown: check the position (close_position reads it live) and the explorer before trying again";
    return journalAfterSend(deps, action, { kind: "error", sent, tx, error: msg, ...base }, { ok: false, error: msg, sent, tx, next, ...base });
  }
  // From here a real tx exists: nothing below may throw, and the row carries the tx hash.
  let filled = null;
  try {
    filled = u.qty((res.fills ?? []).reduce((s, f) => s + BigInt(f.quantityFilled), 0n));
  } catch {
    // a malformed fill row: the tx still landed; report the fill as unknown
  }
  let positionAfter = null;
  let readBack;
  let flipped;
  try {
    // Report 016 (sieve): margin/equity reads can pin a block from before our own receipt;
    // getPerpPosition reads at latest, so it is the read-back.
    const after = (await deps.client().getPerpPosition({ pool: raw.pool, marginBank: raw.marginBank, account: deps.account() })).size;
    positionAfter = u.qty(after);
    // A perp order is not reduce-only on chain: if something else shrank the position while the
    // close was in flight (a bracket triggering, another client), the close opens the other side.
    if (action === "close" && (raw.isBid ? after > 0n : after < 0n))
      flipped = `the position was reduced by something else while this close was in flight (a bracket triggering, another client), so the close opened a ${after > 0n ? "long" : "short"} of ${u.qty(after < 0n ? -after : after)}: call close_position again`;
  } catch (e) {
    readBack = `the order landed but the position read-back failed (${describeError(e)}); close_position reads it live`;
  }
  const out = {
    ok: true, ...base, tx: res.hash, block: Number(res.receipt?.blockNumber ?? 0), status: res.receipt?.status ?? null,
    gasUsed: res.receipt?.gasUsed?.toString?.() ?? null, orderId: res.orderId?.toString() ?? null,
    filled, requested: u.qty(raw.quantity), positionAfter, ...(readBack ? { readBack } : {}), ...(flipped ? { flipped } : {}),
  };
  return journalAfterSend(deps, action, { kind: action === "close" ? "close" : "order", sent: true, ...out }, out);
};

// Every journal write after deps.send goes through this (writes before the send need not): a failed
// write must not hide the tx or become a thrown error, and an open that may have gone out still counts.
const journalAfterSend = (deps, action, row, out) => {
  try {
    deps.journal.append(row);
  } catch (e) {
    out.journalError = `the journal write failed after the send: ${describeError(e)}`;
    if (action === "open" && row.sent !== false) inflight(deps).unjournaled.push(new Date(deps.now()).toISOString().slice(0, 10));
  }
  return out;
};

export const placeOrder = async (deps, { plan_id }) => {
  const policy = deps.policy();
  const s = inflight(deps);
  const p = deps.plans.get(plan_id);
  if (!p) return refuse(deps, "unknownPlan", `no plan ${plan_id} on this server: plans live in its memory only (a restart drops them), are one-shot, and are forgotten ${PLAN_MEMORY_MS / 60_000} minutes after they expire`, "call plan_order first", { plan_id });
  if (p.used) return refuse(deps, "planAlreadyUsed", `plan ${plan_id} was already used: ${p.outcome}`, "call plan_order for a new plan", { plan_id });
  if (s.markets.has(p.raw.symbol)) return busy(deps, p.raw.symbol, "open"); // plan stays usable
  // Claimed synchronously, before any await: two parallel calls with one plan_id cannot both pass.
  // The claim is not the send: `outcome` records what became of it, so a retry is told the truth.
  p.used = true;
  p.outcome = "an earlier place_order call is handling it right now";
  let r;
  try {
    r = await placeClaimed(deps, { plan_id, p, policy, s });
  } catch (e) {
    p.outcome = `an earlier place_order stopped with an error (${describeError(e)}); check the position before trying again`;
    throw e;
  }
  p.outcome = r.ok ? `it was sent as tx ${r.tx}`
    : r.refused_by === "exchange" ? `the exchange refused it (${r.code})${r.tx ? `, tx ${r.tx}` : ", tx hash not captured: check the position before trying again"}`
    : r.refused_by === "pilot-policy" ? `an earlier place_order refused it (${r.rule}) and sent nothing`
    : r.sent === false ? `an earlier place_order stopped before sending (${r.error}); nothing was sent`
    : `its send status is unknown (${r.error})${r.tx ? `, tx ${r.tx}` : ""}; check the position before trying again`;
  return r;
};

const placeClaimed = async (deps, { plan_id, p, policy, s }) => {
  const { raw } = p;
  if (deps.now() > p.expiresAt) {
    return refuse(deps, "planExpired", `plan ${plan_id} expired ${Math.round((deps.now() - p.expiresAt) / 1000)}s ago (plans live ${policy.planTtlSec}s)`, "call plan_order again for fresh prices", { plan_id });
  }
  const u = units({ quoteDecimals: raw.quoteDecimals, baseDecimals: raw.baseDecimals });
  // The policy is read again at send time: limits the user tightened after the plan still apply.
  const refusals = evaluate(policy, {
    market: raw.symbol,
    notionalUsd: raw.positionNotionalAfterUsd,
    liquidationDistancePct: raw.liquidationDistancePct,
    ordersToday: ordersToday(deps) + s.opens,
  });
  if (refusals.length) return refuseAll(deps, refusals, { plan_id });

  s.opens++;
  s.markets.add(raw.symbol);
  try {
    let touch, pos, liq, margin;
    try {
      const ref = { pool: raw.pool, marginBank: raw.marginBank, account: deps.account() };
      const order = { ...ref, isBid: raw.isBid, quantity: raw.quantity, price: raw.price };
      [touch, pos, liq, margin] = await Promise.all([
        readTouch(deps.client(), { id: raw.id, poolAddress: raw.pool }),
        deps.client().getPerpPosition(ref),
        deps.client().previewPerpLiquidationPrice(order),
        deps.client().previewPerpOrderMargin(order),
      ]);
    } catch (e) {
      return failedBeforeSend(deps, e, { stage: "place", action: "open", plan_id, market: raw.symbol });
    }
    // Freshness: the book can move between plan and place. If the touch is now beyond the plan's
    // limit, the plan's numbers are stale; refuse rather than send an IOC that will not fill.
    const moved = raw.isBid ? touch.ask === 0n || touch.ask > raw.price : touch.bid === 0n || touch.bid < raw.price;
    if (moved) return refuse(deps, "stalePlan", `the ${raw.isBid ? "ask" : "bid"} moved to ${u.px(raw.isBid ? touch.ask : touch.bid)}, past the plan's limit ${u.px(raw.price)}`, "call plan_order again", { plan_id });
    // The plan's liquidation preview and exposure were computed for the position it saw; if that
    // changed (another client, a liquidation), its numbers no longer describe this order.
    if (pos.size !== raw.positionSize)
      return refuse(deps, "stalePlan", `the ${raw.symbol} position changed from ${u.qty(raw.positionSize)} to ${u.qty(pos.size)} since the plan`, "call plan_order again", { plan_id });
    // The position may have changed since the plan (another client, a liquidation): the
    // exposure cap is checked against the live one, at the highest price the order can fill at
    // (a sell: the live top bid, which can have risen since the plan; a buy: its limit).
    const capPx = raw.isBid || touch.bid < raw.price ? raw.price : touch.bid;
    const exposure = exposureUsd(u, pos.size, raw.isBid ? raw.quantity : -raw.quantity, capPx, raw.baseDecimals);
    if (exposure > policy.maxNotionalUsd)
      return refuse(deps, "maxNotionalUsd", `the live position makes this order's resulting notional $${exposure.toFixed(2)}, above the $${policy.maxNotionalUsd} cap`, "plan again against the current position (close_position always works)", { plan_id });
    // The plan's liquidation and margin previews are re-run on live state, read in parallel with
    // the touch: collateral can move during a plan's lifetime (a loss in another market, a
    // withdrawal), and the liquidation price moves with it.
    const mark = BigInt(liq?.markPrice ?? margin?.markPrice ?? raw.markPrice ?? 0);
    const live = [];
    const liveDist = liq?.priceable && mark !== 0n ? liquidationDistancePct(liq.projectedLiquidationPrice, mark) : null;
    if (!liq?.priceable || mark === 0n)
      live.push({ rule: "liquidationUnknown", detail: "the exchange could not price a liquidation preview for this order at send time", next: "call plan_order again shortly" });
    else live.push(...evaluate(policy, { market: raw.symbol, liquidationDistancePct: liveDist }));
    if (!margin?.priceable)
      live.push({ rule: "marginUnknown", detail: "the exchange could not price a margin preview for this order at send time", next: "call plan_order again shortly" });
    else if (margin.voucherBlocked)
      live.push({ rule: "voucherBlocked", detail: `${raw.symbol} is now closed to voucher (paper USDso) margin for this account`, next: "pick a market the voucher allows" });
    else if (!margin.meetsInitialMargin || !margin.hasCollateralForLock)
      live.push({ rule: "margin", detail: `live margin preview: initial margin ${margin.meetsInitialMargin ? "met" : "NOT met"}, collateral for lock ${margin.hasCollateralForLock ? "yes" : "NO"}`, next: "plan a smaller size or deposit USDso" });
    if (live.length) return refuseAll(deps, live, { plan_id });
    // The worst price is re-derived from the live touch and the live maxSlippagePct and only ever
    // tightens the plan's limit: a better touch, or a slippage limit cut since the plan, applies.
    const limitNow = limitPrice({ isBid: raw.isBid, ...touch, tick: raw.tick, slippagePct: policy.maxSlippagePct });
    const price = raw.isBid ? (limitNow < raw.price ? limitNow : raw.price) : limitNow > raw.price ? limitNow : raw.price;
    // Checked again inside the writer queue, immediately before the broadcast: a write on another
    // market may have held the writer, and the plan must not go out after its expiry or under a
    // policy the user tightened meanwhile. (The exposure and liquidation figures are the live ones
    // read above; within this server no other order can change this market's position.)
    const check = () => {
      let now;
      let found;
      if (deps.now() > p.expiresAt) found = [{ rule: "planExpired", detail: `plan ${plan_id} expired while it waited for the writer (another transaction was being sent first)`, next: "call plan_order again for fresh prices" }];
      else {
        try {
          now = deps.policy();
        } catch (e) {
          found = [{ rule: "policyUnreadable", detail: describeError(e), next: "fix the policy file, then plan again" }];
        }
        found ??= evaluate(now, { market: raw.symbol, notionalUsd: exposure, liquidationDistancePct: liveDist, ordersToday: ordersToday(deps) + s.opens - 1 });
      }
      if (found.length) throw Object.assign(new Error(found[0].detail), { pilotRefusals: found });
    };
    return await sendIoc(deps, { action: "open", raw: { ...raw, price }, plan_id, check, extra: price === raw.price ? {} : { planLimitPrice: u.px(raw.price) } });
  } finally {
    s.opens--;
    s.markets.delete(raw.symbol);
  }
};

// Closing reduces risk, so policy never blocks it (not the allowlist, not the daily cap, not an
// invalid policy file: the close then uses the default slippage bound and says so, while every
// opening tool still refuses until the file is fixed). The size comes from the live position
// (getPerpPosition), never from remembered fills.
export const closePosition = async (deps, { market }) => {
  let policy, note;
  try {
    policy = deps.policy();
  } catch (e) {
    policy = DEFAULT_POLICY;
    note = { policyUnreadable: `${e?.pilotUser ? e.message : describeError(e)}. Closing reduces risk, so this close went ahead at the default ${DEFAULT_POLICY.maxSlippagePct}% slippage bound; opening tools refuse until the file is fixed` };
  }
  const client = deps.client();
  const mk = await findMarket(client, market);
  const u = units(mk);
  const s = inflight(deps);
  if (s.markets.has(mk.baseSymbol)) return busy(deps, mk.baseSymbol, "close");
  s.markets.add(mk.baseSymbol);
  try {
    const r = await closeLocked(deps, { policy, client, mk, u, note });
    return note ? { ...r, ...note } : r;
  } finally {
    s.markets.delete(mk.baseSymbol);
  }
};

const closeLocked = async (deps, { policy, client, mk, u, note }) => {
  // Only the reads are caught here: once sendIoc runs, a tx may exist and sendIoc reports it.
  let pos, touch;
  try {
    pos = await client.getPerpPosition({ pool: mk.poolAddress, marginBank: mk.marginBank, account: deps.account() });
    if (pos.size !== 0n) touch = await readTouch(client, mk);
  } catch (e) {
    return failedBeforeSend(deps, e, { stage: "close", action: "close", market: mk.baseSymbol });
  }
  if (pos.size === 0n) return { ok: true, action: "close", market: mk.baseSymbol, status: "already flat", positionAfter: "0" };
  const isBid = pos.size < 0n; // a short closes with a buy
  if ((isBid && touch.ask === 0n) || (!isBid && touch.bid === 0n)) {
    const reason = `no ${isBid ? "asks" : "bids"} on the book to close against`;
    deps.journal.append({ kind: "refusal", refused_by: "pilot-policy", stage: "close", action: "close", market: mk.baseSymbol, rules: ["emptyBook"], reason, positionBefore: u.qty(pos.size) });
    return { ok: false, refused_by: "pilot-policy", rule: "emptyBook", action: "close", market: mk.baseSymbol, reason, next: "try again shortly", positionBefore: u.qty(pos.size) };
  }
  const price = limitPrice({ isBid, ...touch, tick: BigInt(mk.tickSize), slippagePct: policy.maxSlippagePct });
  const raw = { symbol: mk.baseSymbol, pool: mk.poolAddress, marginBank: mk.marginBank, id: mk.id, isBid, price, quantity: abs(pos.size), baseDecimals: mk.baseDecimals, quoteDecimals: mk.quoteDecimals ?? 18 };
  return sendIoc(deps, { action: "close", raw, extra: { positionBefore: u.qty(pos.size), ...note } });
};
