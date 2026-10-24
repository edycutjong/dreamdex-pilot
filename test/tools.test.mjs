import { describe, it, expect } from "vitest";
import { accountInfo, bracket, cancelAll } from "../src/tools.mjs";
import { renderDemo, parseReceipts } from "../src/demo.mjs";
import { makeDeps, px, sol, SOL } from "./fixtures.mjs";

const longSol = () => { const t = makeDeps(); t.state.pos = sol(0.3); return t; };

describe("account", () => {
  it("reports collateral, margin status, positions and policy headroom from chain reads", async () => {
    const { deps } = longSol();
    const a = await accountInfo(deps);
    expect(a.collateralUsdso).toEqual({ equity: 42, unlocked: 40, lockedAsMargin: 2, withdrawable: 40 });
    expect(a.marginStatus).toBe("Healthy");
    expect(a.sttForGas).toBe(5);
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0]).toMatchObject({ market: "SOL", side: "long", size: "0.3", avgEntryPrice: "100", markPrice: "102.51" });
    expect(a.policy.ordersSentTodayUtc).toBe(0);
  });
  it("lists no position when flat and says when pending brackets cannot be read", async () => {
    const { deps } = makeDeps();
    deps.client().listPerpStopOrders = async () => { throw new Error("indexer down"); };
    const a = await accountInfo(deps);
    expect(a.positions).toEqual([]);
    expect(a.pendingBrackets.unavailable).toMatch(/indexer down/);
  });
  it("lists a pending bracket with its market and trigger", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "11", registry: SOL.stopRegistry, isBid: false, triggerPrice: px(105.5).toString(), triggerOperator: 0 }];
    const a = await accountInfo(deps);
    expect(a.pendingBrackets).toEqual([{ id: "11", market: "SOL", closes: "long (sells)", triggerPrice: "105.5", when: "mark >= trigger" }]);
  });
});

describe("bracket", () => {
  it("arms a linked reduce-only TP/SL pair covering the whole long position, journaled", async () => {
    const { deps, state, journal } = longSol();
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r).toMatchObject({ ok: true, side: "long", size: "0.3", entryPrice: "100", takeProfitTrigger: "105.59", stopLossTrigger: "100.46", takeProfitStopId: "11", stopLossStopId: "12" });
    const [call] = state.stopCalls;
    expect(call).toMatchObject({ registry: SOL.stopRegistry, pool: SOL.poolAddress, isBid: false, quantity: 0n, triggerOperator: 0, stopOrderType: 1, somiPayment: 15n * 10n ** 16n });
    expect(call.pair).toMatchObject({ isBid: false, quantity: 0n, triggerOperator: 1, stopOrderType: 1 });
    expect(call.triggerPrice).toBeGreaterThan(call.pair.triggerPrice);
    expect(journal.read().at(-1)).toMatchObject({ kind: "bracket", sent: true, tx: r.tx });
  });
  it("arms a short with the exit side and operators reversed", async () => {
    const { deps, state } = makeDeps();
    state.pos = -sol(0.3);
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r.ok).toBe(true);
    const [call] = state.stopCalls;
    expect(call).toMatchObject({ isBid: true, triggerOperator: 1 });
    expect(call.pair).toMatchObject({ isBid: true, triggerOperator: 0 });
    expect(call.triggerPrice).toBeLessThan(call.pair.triggerPrice);
  });
  it("shows an estimated PnL at each trigger from the entry price", async () => {
    const { deps } = longSol();
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r.approxPnlAtTakeProfitUsd).toBeCloseTo(0.3 * 5.59, 3);
    expect(r.approxPnlAtStopLossUsd).toBeCloseTo(0.3 * 0.46, 3);
  });
  it("refuses with no position, sending nothing", async () => {
    const { deps, state, journal } = makeDeps();
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r).toMatchObject({ ok: false, refused_by: "pilot-policy", rule: "noPosition" });
    expect(state.stopCalls).toEqual([]);
    expect(journal.read().at(-1)).toMatchObject({ kind: "refusal", stage: "bracket" });
  });
  it("refuses a second bracket while one is pending", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "11", registry: SOL.stopRegistry, isBid: false, triggerPrice: "1", triggerOperator: 0 }];
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, rule: "bracketExists" });
    expect(state.stopCalls).toEqual([]);
  });
  it("refuses when the account cannot fund the STT the registry holds", async () => {
    const { deps, state } = longSol();
    state.native = 3n * 10n ** 17n;
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, rule: "insufficientNative" });
  });
  it("rejects trigger distances outside 0.1-50 percent as a user error", async () => {
    const { deps } = longSol();
    await expect(bracket(deps, { market: "SOL", take_profit_pct: 0.01, stop_loss_pct: 2 })).rejects.toMatchObject({ pilotUser: true });
    await expect(bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 80 })).rejects.toMatchObject({ pilotUser: true });
  });
  it("reports an exchange revert as refused_by exchange with the decoded reason", async () => {
    const { deps, state } = longSol();
    state.stopError = Object.assign(new Error("reverted"), { name: "ContractRevertError", errorName: "TooManyRestingOrders", txHash: "0x" + "e".repeat(64) });
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r).toMatchObject({ ok: false, refused_by: "exchange", code: "TooManyRestingOrders", tx: "0x" + "e".repeat(64) });
  });
  it("keeps an unknown send status when no hash was captured", async () => {
    const { deps, state } = longSol();
    state.stopError = Object.assign(new Error("timeout"), { name: "RpcError" });
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, sent: "unknown" });
  });
  it("sends nothing when a read before the send fails", async () => {
    const { deps, state } = longSol();
    deps.client().listPerpStopOrders = async () => { throw new Error("indexer down"); };
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, sent: false });
    expect(state.stopCalls).toEqual([]);
  });
});

describe("cancel_all", () => {
  it("cancels the pending bracket, then reports it", async () => {
    const { deps, state, journal } = longSol();
    state.stops = [{ orderIdRaw: "11", registry: SOL.stopRegistry, isBid: false }, { orderIdRaw: "12", registry: SOL.stopRegistry, isBid: false }];
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r).toMatchObject({ ok: true, nothingToCancel: false });
    expect(r.cancelledStops).toEqual([{ market: "SOL", id: "11" }, { market: "SOL", id: "12" }]);
    expect(state.cancelCalls[0]).toEqual(["stops", { registry: SOL.stopRegistry, orderIds: ["11", "12"], gas: 20_000_000n }]);
    expect(journal.read().at(-1)).toMatchObject({ kind: "cancel", sent: true });
  });
  it("says so when there is nothing to cancel and sends no transaction", async () => {
    const { deps, state, journal } = makeDeps();
    const r = await cancelAll(deps, {});
    expect(r).toMatchObject({ ok: true, nothingToCancel: true, txs: [] });
    expect(state.cancelCalls).toEqual([]);
    expect(journal.read().at(-1)).toMatchObject({ kind: "cancel", sent: false });
  });
  it("cancels resting orders on a named market", async () => {
    const { deps, state } = makeDeps();
    state.resting = [7n];
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.cancelledOrders).toEqual([{ market: "SOL", id: "7" }]);
  });
  it("reports a failed cancel as not ok, with the exchange's reason", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "11", registry: SOL.stopRegistry }];
    deps.chain.cancelStops = async () => { throw Object.assign(new Error("x"), { name: "ContractRevertError", errorName: "NothingToClaim" }); };
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ refused_by: "exchange", code: "NothingToClaim" });
  });
});

describe("DEMO.md", () => {
  const rows = [
    { at: "2026-10-24T03:00:00.000Z", kind: "order", direction: "long", size: "0.1", market: "SOL", limitPrice: "103", filled: "0.1", positionAfter: "0.1", tx: "0x" + "1".repeat(64) },
    { at: "2026-10-24T03:01:00.000Z", kind: "close", direction: "close long", size: "0.1", market: "SOL", limitPrice: "101", positionAfter: "0", tx: "0x" + "2".repeat(64) },
    { at: "2026-10-24T03:02:00.000Z", kind: "refusal", refused_by: "pilot-policy", stage: "plan", market: "DOGE", side: "long", size: "100", rules: ["allowedMarkets"], refusals: [{ rule: "allowedMarkets", detail: "DOGE is not on the allowed list", next: "pick BTC" }] },
    { at: "2026-10-24T03:03:00.000Z", kind: "refusal", refused_by: "exchange", stage: "chain", market: "SOL", code: "ImmediateOrCancelNoFill", reason: "the IOC order found nothing to fill", next: "plan again", tx: "0x" + "3".repeat(64) },
  ];
  const receipts = parseReceipts(`0x${"1".repeat(64)} success 100 0xabc 1500000\n0x${"2".repeat(64)} success 101 0xabc 1400000\n0x${"3".repeat(64)} reverted 102 0xabc 80000\nnoise`);
  it("counts only what the journal holds and shows the receipts", () => {
    const md = renderDemo(rows, { receipts, sources: ["j.jsonl"] });
    expect(md).toMatch(/Real orders opened through the MCP tools: \*\*1\*\*/);
    expect(md).toMatch(/refusals by pilot's policy: \*\*1\*\*; refusals by the exchange: \*\*1\*\*/i);
    expect(md).toContain(`\`0x${"1".repeat(64)}\` | success @ block 100, 1500000 gas`);
    expect(md).toContain("ImmediateOrCancelNoFill");
    expect(md).toContain("reverted @ block 102");
    expect(md).toContain("DOGE is not on the allowed list");
  });
  it("marks a tx that was not re-fetched instead of inventing a receipt", () => {
    expect(renderDemo(rows)).toContain("not re-fetched");
  });
  it("renders brackets and cancels that sent transactions", () => {
    const md = renderDemo([
      { at: "2026-10-24T04:00:00.000Z", kind: "bracket", side: "long", size: "0.3", market: "SOL", takeProfitTrigger: "105", takeProfitStopId: "1", stopLossTrigger: "99", stopLossStopId: "2", tx: "0x" + "4".repeat(64) },
      { at: "2026-10-24T04:01:00.000Z", kind: "cancel", txs: [{ what: "2 stop(s) on SOL", tx: "0x" + "5".repeat(64) }] },
      { at: "2026-10-24T04:02:00.000Z", kind: "cancel", txs: [] },
    ]);
    expect(md).toContain("Brackets armed (take-profit + stop-loss): **1**");
    expect(md).toContain("Cancels that sent a transaction: **1**");
    expect(md).toContain("2 stop(s) on SOL");
  });
});
