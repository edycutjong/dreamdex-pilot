import { describe, it, expect } from "vitest";
import { ContractRevertError } from "@somnia-chain/markets-sdk";
import { planOrder, placeOrder, closePosition, limitPrice, liquidationDistancePct, GAS, IOC, PLAN_MEMORY_MS } from "../src/trader.mjs";
import { makeDeps, px, sol } from "./fixtures.mjs";
import { DEFAULT_POLICY } from "../src/policy.mjs";

const plan = (deps, a = {}) => planOrder(deps, { market: "SOL", side: "long", size: "0.1", ...a });

describe("money math", () => {
  const tick = 10n ** 16n;
  it("prices a buy at ask + slippage, floored to the tick", () =>
    expect(limitPrice({ isBid: true, bid: px(102.5), ask: px(102.52), tick, slippagePct: 1 })).toBe(px(103.54)));
  it("prices a sell at bid - slippage, ceiled to the tick", () =>
    expect(limitPrice({ isBid: false, bid: px(102.5), ask: px(102.52), tick, slippagePct: 1 })).toBe(px(101.48)));
  it("never rounds the slippage budget up: sub-basis-point budgets floor to whole basis points", () => {
    // 0.015% used to round to 2 bp (0.02%), past the configured bound; it now floors to 1 bp
    expect(limitPrice({ isBid: true, bid: px(100), ask: px(100), tick: 1n, slippagePct: 0.015 })).toBe(px(100.01));
    expect(limitPrice({ isBid: false, bid: px(100), ask: px(100), tick: 1n, slippagePct: 0.015 })).toBe(px(99.99));
    expect(limitPrice({ isBid: true, bid: px(100), ask: px(100), tick: 1n, slippagePct: 0.005 })).toBe(px(100)); // below 1 bp: the touch itself
    expect(limitPrice({ isBid: true, bid: px(100), ask: px(100), tick: 1n, slippagePct: 0.29 })).toBe(px(100.29)); // 0.29 * 100 = 28.999999999999996 in floats: still 29 bp
  });
  it("keeps a sell limit at or above the exact slippage bound on a one-unit tick (no truncation below it)", () => {
    // 1001 * 0.99 = 990.99: truncating gave 990, below the bound; the limit is 991
    expect(limitPrice({ isBid: false, bid: 1001n, ask: 1002n, tick: 1n, slippagePct: 1 })).toBe(991n);
    expect(limitPrice({ isBid: true, bid: 1000n, ask: 1001n, tick: 1n, slippagePct: 1 })).toBe(1011n); // 1011.01 floors: never above the bound
  });
  it("reads a zero or missing liquidation price as unreachable", () => {
    expect(liquidationDistancePct(0n, px(100))).toBeNull();
    expect(liquidationDistancePct(null, px(100))).toBeNull();
    expect(liquidationDistancePct(px(90), px(100))).toBeCloseTo(10, 6);
    expect(liquidationDistancePct(px(110), px(100))).toBeCloseTo(10, 6); // a short's liq sits above mark
  });
});

describe("plan_order", () => {
  // A sell fills at the bids, from the top bid down to its limit: its limit understates the notional.
  const cap = (usd) => () => ({ ...DEFAULT_POLICY, maxNotionalUsd: usd, source: "test" });
  it("checks a short against the cap at the top bid, the highest price it can fill at, not at its lower limit", async () => {
    const { deps } = makeDeps({ policy: cap(24.5) });
    // 0.24 SOL: $24.36 at the 101.48 limit (under $24.5), $24.60 at the 102.5 top bid (over)
    const r = await plan(deps, { side: "short", size: "0.24" });
    expect(r).toMatchObject({ verdict: "refused", limitPrice: "101.48", positionNotionalAfterUsd: 24.6 });
    expect(r.refusals.map((x) => x.rule)).toEqual(["maxNotionalUsd"]);
    expect(r.refusals[0].next).toBe("reduce size to at most 0.23 SOL");
    // a long is still checked at its own limit, the most it can pay
    expect(await plan(makeDeps({ policy: cap(24.9) }).deps, { side: "long", size: "0.24" })).toMatchObject({ verdict: "ok", positionNotionalAfterUsd: 24.8496 });
  });
  it("returns a one-shot plan with the numbers a human needs", async () => {
    const { deps, journal } = makeDeps();
    const r = await plan(deps);
    expect(r.verdict).toBe("ok");
    expect(r.plan_id).toMatch(/^plan_[0-9a-f]{12}$/);
    expect(r).toMatchObject({ size: "0.1", limitPrice: "103.54", notionalUsd: 10.354, liquidationPrice: null, liquidationDistancePct: null, exchangeMaxSize: "7.8", limitedBy: "margin" });
    expect(deps.plans.has(r.plan_id)).toBe(true);
    expect(journal.read().at(-1)).toMatchObject({ kind: "plan", plan_id: r.plan_id });
  });
  it("sizes from a USD notional, floored to the lot", async () => {
    const { deps } = makeDeps();
    expect((await plan(deps, { size: undefined, notionalUsd: 20 })).size).toBe("0.19"); // 20 / 103.54 = 0.193
  });
  it("shows the liquidation distance when there is one", async () => {
    const { deps, state } = makeDeps();
    state.liq = { ...state.liq, projectedLiquidationPrice: px(51.255) };
    expect((await plan(deps)).liquidationDistancePct).toBe(50);
  });

  const refused = async (setup, a = {}) => {
    const { deps, state, journal } = makeDeps();
    setup?.(state, deps);
    const r = await plan(deps, a);
    expect(r.verdict).toBe("refused");
    expect(r.plan_id).toBeUndefined();
    expect(deps.plans.size).toBe(0);
    expect(journal.read().at(-1)).toMatchObject({ kind: "refusal", refused_by: "pilot-policy", stage: "plan" });
    return r.refusals.map((x) => x.rule);
  };
  it("refuses a market off the allowlist", async () => expect(await refused((s, d) => { d.policy().allowedMarkets = ["BTC"]; })).toEqual(["allowedMarkets"]));
  it("refuses notional above the cap and suggests the largest size under it", async () => {
    const { deps } = makeDeps();
    const r = await plan(deps, { size: "0.5" });
    expect(r.refusals.map((x) => x.rule)).toEqual(["maxNotionalUsd"]);
    expect(r.refusals[0].next).toMatch(/0\.24 SOL/); // 25 / 103.54 = 0.2414
  });
  it("refuses a liquidation closer than the policy minimum", async () =>
    expect(await refused((s) => { s.liq = { ...s.liq, projectedLiquidationPrice: px(95) }; })).toEqual(["minLiquidationDistancePct"]));
  it("refuses a market closed to voucher margin, from the chain's own preview (sieve report 006)", async () =>
    expect(await refused((s) => { s.margin = { ...s.margin, voucherBlocked: true }; })).toEqual(["voucherBlocked"]));
  it("refuses above the exchange's max size (sieve report 002)", async () =>
    expect(await refused((s) => { s.max = { ...s.max, maxQuantity: sol(0.05) }; })).toEqual(["exchangeMaxSize"]));
  it("refuses when the exchange says not placeable", async () =>
    expect(await refused((s) => { s.max = { ...s.max, placeable: false }; })).toEqual(["exchangeMaxSize"]));
  it("refuses when the margin preview fails", async () =>
    expect(await refused((s) => { s.margin = { ...s.margin, hasCollateralForLock: false }; })).toEqual(["margin"]));
  it("refuses when the liquidation preview is not priceable (unknown is not safe)", async () =>
    expect(await refused((s) => { s.liq = { priceable: false }; })).toEqual(["liquidationUnknown"]));
  it("refuses when the margin preview is not priceable", async () =>
    expect(await refused((s) => { s.margin = { priceable: false }; })).toEqual(["marginUnknown"]));
  it("caps the position the order leaves, not the order alone (no stacking)", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.2); // $20.7 long already
    const r = await plan(deps); // +0.1 -> 0.3 SOL = $31
    expect(r.refusals.map((x) => x.rule)).toEqual(["maxNotionalUsd"]);
    // 0.24 cap - 0.2 held = 0.04 SOL of room, under the 0.1 SOL minimum: no size is offered (a live run once offered 0.04).
    expect(r.refusals[0].next).toBe("no SOL order fits under the cap: the room left is 0.04 SOL, below the SOL minimum 0.1; close_position or a reducing order frees room");
    expect(r).toMatchObject({ positionNow: "0.2", positionAfter: "0.3" });
  });
  it("offers the room under the cap as the next size when it is at least the market minimum", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1); // 0.24 cap - 0.1 held = 0.14 SOL of room
    const r = await plan(deps, { size: "0.2" });
    expect(r.refusals.map((x) => x.rule)).toEqual(["maxNotionalUsd"]);
    expect(r.refusals[0].next).toBe("reduce size to at most 0.14 SOL");
  });
  it("says no order fits, without blaming a position, when the cap itself is below the market minimum", async () => {
    const { deps } = makeDeps();
    deps.policy().maxNotionalUsd = 5; // 5 / 103.54 = 0.048 SOL < 0.1 minimum
    const r = await plan(deps);
    expect(r.refusals.map((x) => x.rule)).toEqual(["maxNotionalUsd"]);
    expect(r.refusals[0].next).toMatch(/^no SOL order fits under the cap: the room left is 0\.04 SOL, below the SOL minimum 0\.1; pick another market or raise maxNotionalUsd/);
  });
  it("lets an order that reduces exposure through", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.2);
    const r = await plan(deps, { side: "short" });
    expect(r.verdict).toBe("ok");
    expect(r).toMatchObject({ positionAfter: "0.1", positionNotionalAfterUsd: 10.25 }); // valued at the 102.5 top bid a sell can fill at
  });
  it("sizes a tiny notional without parse errors and refuses it as below minimum", async () => {
    const { deps } = makeDeps();
    expect((await plan(deps, { size: undefined, notionalUsd: 1e-7 })).refusals.map((x) => x.rule)).toEqual(["minQuantity"]);
  });
  it("treats a missing mark price as unknown liquidation, not safe", async () => {
    const { deps, state } = makeDeps();
    state.liq = { ...state.liq, markPrice: undefined };
    state.margin = { ...state.margin, markPrice: undefined };
    const broken = { ...deps.client(), listPerpMarkets: async () => [{ ...(await deps.client().listPerpMarkets())[0], markPrice: undefined }] };
    const r = await planOrder({ ...deps, client: () => broken }, { market: "SOL", side: "long", size: "0.1" });
    expect(r.refusals.map((x) => x.rule)).toContain("liquidationUnknown");
  });
  it("remembers plans for 10 minutes after they expire (a repeat still reads planAlreadyUsed), then forgets them", async () => {
    const { deps, state } = makeDeps();
    const a = await plan(deps);
    await placeOrder(deps, { plan_id: a.plan_id });
    await closePosition(deps, { market: "SOL" });
    const b = await plan(deps);
    expect((await placeOrder(deps, { plan_id: a.plan_id })).rule).toBe("planAlreadyUsed");
    state.clock += 61_000;
    await plan(deps);
    expect((await placeOrder(deps, { plan_id: a.plan_id })).rule).toBe("planAlreadyUsed");
    expect(deps.plans.size).toBe(3);
    state.clock += PLAN_MEMORY_MS;
    await plan(deps);
    expect(deps.plans.has(a.plan_id)).toBe(false);
    expect(deps.plans.has(b.plan_id)).toBe(false);
    expect(deps.plans.size).toBe(2);
    const gone = await placeOrder(deps, { plan_id: a.plan_id });
    expect(gone.rule).toBe("unknownPlan");
    expect(gone.reason).toMatch(/forgotten 10 minutes after they expire/);
  });
  it("refuses below the market minimum", async () => expect(await refused(null, { size: "0.05" })).toEqual(["minQuantity"]));
  it("refuses a size that rounds to 0 before any preview, naming every broken rule (real run: 0.1 DOGE)", async () => {
    const { deps, previews, journal } = makeDeps();
    const r = await plan(deps, { market: "DOGE", size: "0.1" });
    expect(r.verdict).toBe("refused");
    expect(r.refusals.map((x) => x.rule)).toEqual(["allowedMarkets", "minQuantity"]);
    expect(r).toMatchObject({ size: "0", minSize: "120", lotSize: "10" });
    expect(previews).toHaveLength(0);
    expect(journal.read().at(-1)).toMatchObject({ kind: "refusal", refused_by: "pilot-policy", rules: ["allowedMarkets", "minQuantity"] });
  });
  it("refuses at the daily order cap", async () =>
    expect(await refused((s, d) => { for (let i = 0; i < 20; i++) d.journal.append({ kind: "order", sent: true, action: "open", at: new Date(s.clock).toISOString() }); })).toEqual(["dailyOrderCap"]));
  it("refuses on an empty book", async () => {
    const { deps, state } = makeDeps();
    state.ask = 0n;
    expect((await plan(deps)).refusals[0].rule).toBe("emptyBook");
  });
  it("errors on an unknown market", async () => {
    const { deps } = makeDeps();
    await expect(plan(deps, { market: "NOPE" })).rejects.toThrow(/No perp market named NOPE/);
  });
});

describe("place_order", () => {
  it("re-checks a short against the cap at the live top bid: a bid that rose since the plan can push it over", async () => {
    const { deps, state } = makeDeps({ policy: () => ({ ...DEFAULT_POLICY, maxNotionalUsd: 24.5, source: "test" }) });
    state.bid = px(100);
    state.ask = px(100.02);
    const p = await plan(deps, { side: "short", size: "0.24" }); // $24.00 at the 100 bid
    expect(p.verdict).toBe("ok");
    state.bid = px(102.5); // the bid rose: still fillable, but the short now fills at up to 102.5
    state.ask = px(102.52);
    const r = await placeOrder(deps, { plan_id: p.plan_id });
    expect(r).toMatchObject({ ok: false, refused_by: "pilot-policy", rule: "maxNotionalUsd" });
    expect(r.refusals[0].detail).toMatch(/\$24\.60, above the \$24\.5 cap/);
    expect(state.sends).toHaveLength(0);
  });
  it("sends an IOC with the safe gas limit and reads the position back", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    const r = await placeOrder(deps, { plan_id });
    expect(r).toMatchObject({ ok: true, action: "open", market: "SOL", side: "buy", filled: "0.1", requested: "0.1", positionAfter: "0.1", status: "success" });
    expect(r.tx).toMatch(/^0x[a]{63}1$/);
    expect(state.sends[0]).toMatchObject({ orderType: IOC, gas: GAS, isBid: true, price: px(103.54), quantity: sol(0.1) });
    expect(journal.read().at(-1)).toMatchObject({ kind: "order", sent: true, action: "open", plan_id, tx: r.tx });
  });

  const placeRefused = async (deps, state, plan_id, rule) => {
    const before = state.sends.length;
    const r = await placeOrder(deps, { plan_id });
    expect(r).toMatchObject({ ok: false, refused_by: "pilot-policy", rule });
    expect(state.sends.length).toBe(before); // nothing sent
    expect(deps.journal.read().at(-1)).toMatchObject({ kind: "refusal", refused_by: "pilot-policy", stage: "place", rules: [rule] });
  };
  it("refuses an unknown plan", async () => {
    const { deps, state } = makeDeps();
    await placeRefused(deps, state, "plan_000000000000", "unknownPlan");
  });
  it("refuses to send the same plan twice", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    await placeOrder(deps, { plan_id });
    await placeRefused(deps, state, plan_id, "planAlreadyUsed");
  });
  it("refuses an expired plan", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    state.clock += 61_000;
    await placeRefused(deps, state, plan_id, "planExpired");
    // Asking again is told what became of it, not "no plan" (a live run got unknownPlan here).
    const again = await placeOrder(deps, { plan_id });
    expect(again.rule).toBe("planAlreadyUsed");
    expect(again.reason).toMatch(/refused it \(planExpired\) and sent nothing/);
  });
  it("accepts a plan just inside its lifetime", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    state.clock += 60_000;
    expect((await placeOrder(deps, { plan_id })).ok).toBe(true);
  });
  it("refuses a stale plan when the ask moved past the limit", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    state.ask = px(103.55);
    await placeRefused(deps, state, plan_id, "stalePlan");
  });
  it("refuses a stale short plan when the bid fell past the limit", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps, { side: "short" });
    state.bid = px(101.47);
    await placeRefused(deps, state, plan_id, "stalePlan");
  });
  it("re-checks the daily cap at send time", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    for (let i = 0; i < 20; i++) deps.journal.append({ kind: "order", sent: true, action: "open" });
    await placeRefused(deps, state, plan_id, "dailyOrderCap");
  });
  it("reports an exchange refusal with the decoded reason, tagged refused_by exchange", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    state.sendError = Object.assign(new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" }), { txHash: "0xdead" });
    const r = await placeOrder(deps, { plan_id });
    expect(r).toMatchObject({ ok: false, refused_by: "exchange", code: "ImmediateOrCancelNoFill", tx: "0xdead" });
    expect(r.reason).toMatch(/found nothing to fill/);
    expect(journal.read().at(-1)).toMatchObject({ kind: "refusal", refused_by: "exchange", sent: true, tx: "0xdead", action: "open" });
    expect(journal.ordersToday(new Date(state.clock))).toBe(1); // a reverted send still counts
    expect((await placeOrder(deps, { plan_id })).rule).toBe("planAlreadyUsed"); // never resent
  });
  it("journals a landed order even when the position read-back fails", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    const c = deps.client();
    let calls = 0;
    const flaky = { ...c, getPerpPosition: async (a) => { if (++calls > 1) throw new Error("socket closed"); return c.getPerpPosition(a); } };
    const r = await placeOrder({ ...deps, client: () => flaky }, { plan_id });
    expect(r).toMatchObject({ ok: true, positionAfter: null });
    expect(r.tx).toMatch(/^0x/);
    expect(r.readBack).toMatch(/read-back failed/);
    expect(journal.read().at(-1)).toMatchObject({ kind: "order", sent: true, tx: r.tx });
    expect(journal.ordersToday(new Date(state.clock))).toBe(1);
  });
  it("counts an exchange revert with no captured hash as possibly sent", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    state.sendError = new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
    expect(await placeOrder(deps, { plan_id })).toMatchObject({ refused_by: "exchange", tx: null });
    expect(journal.read().at(-1)).toMatchObject({ sent: "unknown" });
    expect(journal.ordersToday(new Date(state.clock))).toBe(1);
  });
  it("refuses as stale when the position changed since the plan (its previews no longer apply)", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    state.pos = sol(0.2); // another client opened in between
    await placeRefused(deps, state, plan_id, "stalePlan");
  });
  it("re-previews liquidation at send time: collateral that moved since the plan can bring it under the minimum", async () => {
    const { deps, state } = makeDeps();
    state.liq = { ...state.liq, projectedLiquidationPrice: px(82) }; // 20% from mark at plan time
    const { plan_id } = await plan(deps);
    state.liq = { ...state.liq, projectedLiquidationPrice: px(92) }; // ~10% after a loss elsewhere
    await placeRefused(deps, state, plan_id, "minLiquidationDistancePct");
    expect(deps.journal.read().at(-1).refusals[0].detail).toMatch(/10\.\d\d% from mark/);
  });
  it("refuses at send time when the live liquidation or margin preview cannot be priced", async () => {
    for (const [change, rule] of [
      [(s) => { s.liq = { ...s.liq, priceable: false }; }, "liquidationUnknown"],
      [(s) => { s.margin = { ...s.margin, priceable: false }; }, "marginUnknown"],
    ]) {
      const { deps, state } = makeDeps();
      const { plan_id } = await plan(deps);
      change(state);
      await placeRefused(deps, state, plan_id, rule);
    }
  });
  it("refuses at send time when the market turned voucher-blocked or the margin no longer covers the order", async () => {
    for (const [change, rule] of [
      [(s) => { s.margin = { ...s.margin, voucherBlocked: true }; }, "voucherBlocked"],
      [(s) => { s.margin = { ...s.margin, hasCollateralForLock: false }; }, "margin"],
    ]) {
      const { deps, state } = makeDeps();
      const { plan_id } = await plan(deps);
      change(state);
      await placeRefused(deps, state, plan_id, rule);
    }
  });
  it("refuses as stale when a short position appeared since the plan", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps, { side: "short" });
    state.pos = -sol(0.2);
    await placeRefused(deps, state, plan_id, "stalePlan");
  });
  it("releases the market lock after a refusal, an exchange refusal and a send", async () => {
    const { deps, state } = makeDeps();
    const a = await plan(deps);
    state.ask = px(110);
    await placeRefused(deps, state, a.plan_id, "stalePlan");
    state.ask = px(102.52);
    const b = await plan(deps);
    state.sendError = new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
    expect((await placeOrder(deps, { plan_id: b.plan_id })).refused_by).toBe("exchange");
    state.sendError = null;
    const c = await plan(deps);
    expect((await placeOrder(deps, { plan_id: c.plan_id })).ok).toBe(true);
    expect((await closePosition(deps, { market: "SOL" })).ok).toBe(true);
    expect(deps.inflight.markets.size).toBe(0);
  });
  it("keeps the tx when the fill row is malformed or the journal write fails after a send", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    const send = async (o) => { state.sends.push(o); return { hash: "0xfeed", receipt: { blockNumber: 1n, status: "success" }, fills: [{ quantityFilled: "not-a-number" }] }; };
    const journal = { ...deps.journal, append: (e) => { if (e.sent === true) throw new Error("disk full"); return deps.journal.append(e); } };
    const r = await placeOrder({ ...deps, send, journal }, { plan_id });
    expect(r).toMatchObject({ ok: true, tx: "0xfeed", filled: null });
    expect(r.journalError).toMatch(/disk full/);
  });
  it("tells a reused plan_id what became of it: refused and nothing sent, or sent as a tx", async () => {
    const { deps, state } = makeDeps();
    const a = await plan(deps);
    state.ask = px(110);
    await placeRefused(deps, state, a.plan_id, "stalePlan");
    const again = await placeOrder(deps, { plan_id: a.plan_id });
    expect(again).toMatchObject({ ok: false, rule: "planAlreadyUsed" });
    expect(again.reason).toMatch(/refused it \(stalePlan\) and sent nothing/);
    state.ask = px(102.52);
    const b = await plan(deps);
    const sent = await placeOrder(deps, { plan_id: b.plan_id });
    expect((await placeOrder(deps, { plan_id: b.plan_id })).reason).toMatch(new RegExp(`sent as tx ${sent.tx}`));
  });
  it("re-derives the limit from the live touch and maxSlippagePct, and only ever tightens it", async () => {
    const { deps, state, policy } = makeDeps();
    const tick = 10n ** 16n;
    const a = await plan(deps); // ask 102.52, 1% -> limit 103.54
    policy.maxSlippagePct = 0.1;
    const tight = await placeOrder(deps, { plan_id: a.plan_id });
    expect(state.sends.at(-1).price).toBe(limitPrice({ isBid: true, bid: state.bid, ask: state.ask, tick, slippagePct: 0.1 }));
    expect(tight).toMatchObject({ ok: true, planLimitPrice: "103.54" });
    policy.maxSlippagePct = 1;
    const b = await plan(deps);
    state.ask = px(103); // worse, still inside the plan's limit: the plan's limit stands
    const kept = await placeOrder(deps, { plan_id: b.plan_id });
    expect(state.sends.at(-1).price).toBe(px(103.54));
    expect(kept.planLimitPrice).toBeUndefined();
  });
  it("tightens a sell's limit upward only (a sell's worst price is the lowest it accepts)", async () => {
    const { deps, state, policy } = makeDeps();
    state.pos = sol(0.2); // a short that only reduces: stays under the cap
    const a = await plan(deps, { side: "short" });
    policy.maxSlippagePct = 0.1;
    const r = await placeOrder(deps, { plan_id: a.plan_id });
    expect(state.sends.at(-1).price).toBe(limitPrice({ isBid: false, bid: state.bid, ask: state.ask, tick: 10n ** 16n, slippagePct: 0.1 }));
    expect(state.sends.at(-1).price > px(101.47)).toBe(true);
    expect(r.planLimitPrice).toBe(a.limitPrice);
  });
  it("a reused plan_id names the real outcome: nothing sent (no key), or the exchange's refusal", async () => {
    const { deps, state } = makeDeps();
    const a = await plan(deps);
    state.sendError = Object.assign(new Error("PILOT_PRIVATE_KEY is not set"), { pilotNotSent: true });
    expect(await placeOrder(deps, { plan_id: a.plan_id })).toMatchObject({ ok: false, sent: false });
    expect((await placeOrder(deps, { plan_id: a.plan_id })).reason).toMatch(/stopped before sending \(.*PILOT_PRIVATE_KEY.*\); nothing was sent/);
    const b = await plan(deps);
    state.sendError = new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
    await placeOrder(deps, { plan_id: b.plan_id });
    expect((await placeOrder(deps, { plan_id: b.plan_id })).reason).toMatch(/the exchange refused it .*tx hash not captured/);
  });
  it("a journal write failing after an exchange refusal still answers with the refusal and counts toward the cap", async () => {
    const { deps, state, policy } = makeDeps();
    policy.dailyOrderCap = 1;
    const journal = { ...deps.journal, append: (e) => { if (e.refused_by === "exchange") throw new Error("disk full"); return deps.journal.append(e); } };
    const d = { ...deps, journal };
    const a = await plan(d);
    state.sendError = Object.assign(new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" }), { txHash: "0xbeef" });
    const r = await placeOrder(d, { plan_id: a.plan_id });
    expect(r).toMatchObject({ ok: false, refused_by: "exchange", tx: "0xbeef" });
    expect(r.journalError).toMatch(/disk full/);
    state.sendError = null;
    expect((await plan(d)).refusals.map((x) => x.rule)).toContain("dailyOrderCap");
  });
  it("a live preview that throws at send time is a failed read: nothing sent", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    deps.client().previewPerpLiquidationPrice = async () => { throw new Error("rpc 502"); };
    expect(await placeOrder(deps, { plan_id })).toMatchObject({ ok: false, sent: false });
    expect(state.sends).toHaveLength(0);
  });
  it("still counts an open toward the daily cap when its journal row failed to write", async () => {
    const { deps, state, policy } = makeDeps();
    policy.dailyOrderCap = 1;
    const journal = { ...deps.journal, append: (e) => { if (e.sent === true) throw new Error("disk full"); return deps.journal.append(e); } };
    const d = { ...deps, journal };
    const first = await placeOrder(d, { plan_id: (await plan(d)).plan_id });
    expect(first).toMatchObject({ ok: true });
    expect(first.journalError).toMatch(/disk full/);
    const second = await plan(d);
    expect(second.verdict).toBe("refused");
    expect(second.refusals.map((r) => r.rule)).toContain("dailyOrderCap");
    expect(state.sends).toHaveLength(1);
  });
  it("journals a failed read before the send and sends nothing", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    const broken = { ...deps.client(), getBookTopsOnchain: async () => { throw new Error("socket closed"); } };
    const r = await placeOrder({ ...deps, client: () => broken }, { plan_id });
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(state.sends).toHaveLength(0);
    expect(journal.read().at(-1)).toMatchObject({ kind: "error", stage: "place", sent: false });
  });
  it("refuses an open while an order on the same market is in flight, keeping the plan usable", async () => {
    const { deps, state } = makeDeps();
    const a = await plan(deps);
    const b = await plan(deps, { side: "short" });
    const rs = await Promise.all([placeOrder(deps, { plan_id: a.plan_id }), placeOrder(deps, { plan_id: b.plan_id })]);
    expect(state.sends).toHaveLength(1);
    expect(rs[1].reason).toMatch(/already in flight/);
    // Not burned by the busy refusal (not planAlreadyUsed); now stale, since the first order moved the position.
    expect((await placeOrder(deps, { plan_id: b.plan_id })).rule).toBe("stalePlan");
  });
  it("keeps an RPC failure distinct from an exchange refusal", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    state.sendError = Object.assign(new Error("fetch failed"), { name: "RpcError" });
    const r = await placeOrder(deps, { plan_id });
    expect(r.ok).toBe(false);
    expect(r.refused_by).toBeUndefined();
    expect(r.error).toMatch(/RpcError: fetch failed/);
    // No hash does not prove nothing went out: status unknown, counted toward the cap, no "retry".
    expect(r).toMatchObject({ sent: "unknown" });
    expect(r.next).toMatch(/status unknown/);
    expect(journal.read().at(-1)).toMatchObject({ kind: "error", sent: "unknown" });
    expect(journal.ordersToday(new Date(state.clock))).toBe(1);
  });
  it("says nothing was sent only when the sender proved it", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    state.sendError = Object.assign(new Error("PILOT_PRIVATE_KEY is not set"), { pilotNotSent: true });
    expect(await placeOrder(deps, { plan_id })).toMatchObject({ ok: false, sent: false });
    expect(journal.ordersToday(new Date(state.clock))).toBe(0);
  });
  it("sends a plan once even when two place_order calls race", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    const rs = await Promise.all([placeOrder(deps, { plan_id }), placeOrder(deps, { plan_id })]);
    expect(state.sends).toHaveLength(1);
    expect(rs.map((r) => r.ok ? "sent" : r.rule).sort()).toEqual(["planAlreadyUsed", "sent"]);
  });
  it("counts in-flight sends toward the daily cap", async () => {
    const { deps, state, policy } = makeDeps();
    const a = await plan(deps);
    const b = await plan(deps, { market: "ETH" });
    policy.dailyOrderCap = 1;
    const rs = await Promise.all([placeOrder(deps, { plan_id: a.plan_id }), placeOrder(deps, { plan_id: b.plan_id })]);
    expect(state.sends).toHaveLength(1);
    expect(rs.find((r) => !r.ok).rule).toBe("dailyOrderCap");
  });
  it("applies a policy the user tightened after the plan", async () => {
    const { deps, state, policy } = makeDeps();
    const a = await plan(deps);
    const b = await plan(deps);
    policy.allowedMarkets = ["BTC"];
    await placeRefused(deps, state, a.plan_id, "allowedMarkets");
    policy.allowedMarkets = ["SOL"];
    policy.maxNotionalUsd = 5;
    await placeRefused(deps, state, b.plan_id, "maxNotionalUsd");
  });
  it("re-applies the liquidation minimum from the plan's own preview", async () => {
    const { deps, state, policy } = makeDeps();
    state.liq = { ...state.liq, projectedLiquidationPrice: px(82) }; // 20% from mark: ok at 15%
    const { plan_id } = await plan(deps);
    policy.minLiquidationDistancePct = 25;
    await placeRefused(deps, state, plan_id, "minLiquidationDistancePct");
  });
  it("refuses as stale when the book emptied", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    state.ask = 0n;
    await placeRefused(deps, state, plan_id, "stalePlan");
  });
});

describe("close_position", () => {
  it("an empty book refuses the close with refused_by pilot-policy, in the answer as in the journal", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1);
    state.bid = 0n;
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: false, refused_by: "pilot-policy", rule: "emptyBook" });
    expect(state.sends).toHaveLength(0);
  });
  it("says so when the close flipped the position (something else reduced it while the close was in flight)", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1);
    const send = async (o) => { state.pos = 0n; return deps.send(o); }; // a bracket fired first
    const r = await closePosition({ ...deps, send }, { market: "SOL" });
    expect(r).toMatchObject({ ok: true, positionAfter: "-0.1" });
    expect(r.flipped).toMatch(/opened a short of 0\.1/);
    const plain = makeDeps();
    plain.state.pos = sol(0.1);
    expect((await closePosition(plain.deps, { market: "SOL" })).flipped).toBeUndefined();
  });
  it("does nothing when already flat", async () => {
    const { deps, state } = makeDeps();
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: true, status: "already flat" });
    expect(state.sends).toHaveLength(0);
  });
  it("an invalid policy file does not block a close: it closes at the default slippage bound and says so", async () => {
    const bad = () => { throw Object.assign(new Error("policy file /tmp/p.json is invalid (maxSlippagePct: Too big)"), { pilotUser: true }); };
    const { deps, state, journal } = makeDeps({ policy: bad });
    state.pos = sol(0.13);
    const r = await closePosition(deps, { market: "SOL" });
    expect(state.sends[0]).toMatchObject({ isBid: false, quantity: sol(0.13), price: px(101.48) }); // default 1%, as with a valid default policy
    expect(r).toMatchObject({ ok: true, action: "close", positionAfter: "0" });
    expect(r.policyUnreadable).toMatch(/^policy file \/tmp\/p\.json is invalid .*\. Closing reduces risk, so this close went ahead at the default 1% slippage bound; opening tools refuse until the file is fixed$/);
    expect(journal.read().at(-1)).toMatchObject({ kind: "close", sent: true, policyUnreadable: r.policyUnreadable });
    // the same note when nothing is sent
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ status: "already flat", policyUnreadable: r.policyUnreadable });
    // opening still refuses until the file is fixed
    await expect(plan(deps)).rejects.toThrow(/is invalid/);
  });
  it("closes a long with a sell sized from the live position", async () => {
    const { deps, state, journal } = makeDeps();
    state.pos = sol(0.13); // e.g. a partial fill elsewhere: size comes from chain, not memory
    const r = await closePosition(deps, { market: "SOL" });
    expect(state.sends[0]).toMatchObject({ isBid: false, quantity: sol(0.13), price: px(101.48), orderType: IOC, gas: GAS });
    expect(r).toMatchObject({ ok: true, action: "close", positionBefore: "0.13", positionAfter: "0" });
    expect(journal.read().at(-1)).toMatchObject({ kind: "close", sent: true, action: "close" });
  });
  it("closes a short with a buy", async () => {
    const { deps, state } = makeDeps();
    state.pos = -sol(0.2);
    await closePosition(deps, { market: "SOL" });
    expect(state.sends[0]).toMatchObject({ isBid: true, quantity: sol(0.2) });
  });
  it("is never blocked by policy: off-allowlist market and daily cap reached", async () => {
    const { deps, state, journal } = makeDeps();
    for (let i = 0; i < 20; i++) journal.append({ kind: "order", sent: true, action: "open" });
    state.pos = sol(0.1);
    expect((await closePosition(deps, { market: "DOGE" })).ok).toBe(true);
  });
  it("runs one close per market at a time", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1);
    const rs = await Promise.all([closePosition(deps, { market: "SOL" }), closePosition(deps, { market: "SOL" })]);
    expect(state.sends).toHaveLength(1);
    expect(rs.find((r) => !r.ok).reason).toMatch(/already in flight/);
    expect(state.pos).toBe(0n); // never flipped short
  });
  it("journals a close that failed in the send with unknown status", async () => {
    const { deps, state, journal } = makeDeps();
    state.pos = sol(0.1);
    state.sendError = Object.assign(new Error("fetch failed"), { name: "RpcError" });
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: false, sent: "unknown", action: "close" });
    expect(journal.read().at(-1)).toMatchObject({ kind: "error", sent: "unknown", action: "close" });
  });
  it("journals a failed position read on close and sends nothing", async () => {
    const { deps, state, journal } = makeDeps();
    const broken = { ...deps.client(), getPerpPosition: async () => { throw new Error("socket closed"); } };
    expect(await closePosition({ ...deps, client: () => broken }, { market: "SOL" })).toMatchObject({ ok: false, sent: false });
    expect(state.sends).toHaveLength(0);
    expect(journal.read().at(-1)).toMatchObject({ kind: "error", stage: "close", sent: false });
  });
  it("refuses to close into an empty book, and journals it", async () => {
    const { deps, state, journal } = makeDeps();
    state.pos = sol(0.1);
    state.bid = 0n;
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: false, positionBefore: "0.1" });
    expect(state.sends).toHaveLength(0);
    expect(journal.read().at(-1)).toMatchObject({ kind: "refusal", stage: "close", rules: ["emptyBook"] });
  });
  it("refuses a close while an open on the same market is in flight", async () => {
    const { deps, state } = makeDeps();
    const { plan_id } = await plan(deps);
    const [o, c] = await Promise.all([placeOrder(deps, { plan_id }), closePosition(deps, { market: "SOL" })]);
    expect(o.ok).toBe(true);
    expect(c.reason).toMatch(/already in flight/);
    expect(state.sends).toHaveLength(1);
  });
  it("reports a landed close as landed even if the journal write then fails", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1);
    const journal = { ...deps.journal, append: (e) => { if (e.sent === true) throw new Error("disk full"); return deps.journal.append(e); } };
    const r = await closePosition({ ...deps, journal }, { market: "SOL" });
    expect(r).toMatchObject({ ok: true, positionAfter: "0" });
    expect(r.tx).toMatch(/^0x/);
    expect(r.sent).toBeUndefined(); // never "nothing was sent"
  });
  it("errors on an unknown market", async () => {
    await expect(closePosition(makeDeps().deps, { market: "NOPE" })).rejects.toThrow(/No perp market named NOPE/);
  });
  it("reports an exchange refusal on close", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1);
    state.sendError = new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: false, refused_by: "exchange", action: "close", tx: null });
  });
});
