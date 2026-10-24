import { describe, it, expect } from "vitest";
import { ContractRevertError } from "@somnia-chain/markets-sdk";
import { planOrder, placeOrder, closePosition, limitPrice, liquidationDistancePct, GAS, IOC } from "../src/trader.mjs";
import { makeDeps, px, sol } from "./fixtures.mjs";

const plan = (deps, a = {}) => planOrder(deps, { market: "SOL", side: "long", size: "0.1", ...a });

describe("money math", () => {
  const tick = 10n ** 16n;
  it("prices a buy at ask + slippage, floored to the tick", () =>
    expect(limitPrice({ isBid: true, bid: px(102.5), ask: px(102.52), tick, slippagePct: 1 })).toBe(px(103.54)));
  it("prices a sell at bid - slippage, ceiled to the tick", () =>
    expect(limitPrice({ isBid: false, bid: px(102.5), ask: px(102.52), tick, slippagePct: 1 })).toBe(px(101.48)));
  it("reads a zero or missing liquidation price as unreachable", () => {
    expect(liquidationDistancePct(0n, px(100))).toBeNull();
    expect(liquidationDistancePct(null, px(100))).toBeNull();
    expect(liquidationDistancePct(px(90), px(100))).toBeCloseTo(10, 6);
    expect(liquidationDistancePct(px(110), px(100))).toBeCloseTo(10, 6); // a short's liq sits above mark
  });
});

describe("plan_order", () => {
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
  it("refuses a market off the allowlist", async () => expect(await refused(null, { market: "DOGE" })).toEqual(["allowedMarkets"]));
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
  it("refuses below the market minimum", async () => expect(await refused(null, { size: "0.05" })).toEqual(["minQuantity"]));
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
  it("keeps an RPC failure distinct from an exchange refusal", async () => {
    const { deps, state, journal } = makeDeps();
    const { plan_id } = await plan(deps);
    state.sendError = Object.assign(new Error("fetch failed"), { name: "RpcError" });
    const r = await placeOrder(deps, { plan_id });
    expect(r.ok).toBe(false);
    expect(r.refused_by).toBeUndefined();
    expect(r.error).toMatch(/RpcError: fetch failed/);
    expect(journal.read().at(-1)).toMatchObject({ kind: "error", sent: false });
  });
});

describe("close_position", () => {
  it("does nothing when already flat", async () => {
    const { deps, state } = makeDeps();
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: true, status: "already flat" });
    expect(state.sends).toHaveLength(0);
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
  it("reports an exchange refusal on close", async () => {
    const { deps, state } = makeDeps();
    state.pos = sol(0.1);
    state.sendError = new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
    expect(await closePosition(deps, { market: "SOL" })).toMatchObject({ ok: false, refused_by: "exchange", action: "close", tx: null });
  });
});
