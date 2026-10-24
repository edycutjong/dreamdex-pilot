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
    expect(a.positions[0]).toMatchObject({ market: "SOL", side: "long", size: "0.3", avgEntryPrice: "100", markPrice: "102.51", notionalUsd: 15.5, unrealizedPnlUsd: 1.5 });
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
  const stopsOn = (state, ids = ["11", "12"]) => { state.stops = ids.map((id) => ({ orderIdRaw: id, registry: SOL.stopRegistry, isBid: false })); };
  it("cancels the pending bracket, then reports it", async () => {
    const { deps, state, journal } = longSol();
    stopsOn(state);
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r).toMatchObject({ ok: true, nothingToCancel: false });
    expect(r.cancelledStops).toEqual([{ market: "SOL", id: "11" }, { market: "SOL", id: "12" }]);
    expect(state.cancelCalls[0]).toEqual(["stops", { registry: SOL.stopRegistry, orderIds: ["11", "12"], gas: 20_000_000n }]);
    expect(journal.read().at(-1)).toMatchObject({ kind: "cancel", sent: true });
  });
  it("says so when there is nothing to cancel, names what it checked, and still looks for resting orders", async () => {
    const { deps, state, journal } = makeDeps();
    const r = await cancelAll(deps, {});
    expect(r).toMatchObject({ ok: true, nothingToCancel: true, txs: [] });
    expect(r.checked).toMatch(/confirmed on chain/);
    expect(state.cancelCalls.every(([kind]) => kind === "orders")).toBe(true);
    expect(state.cancelCalls).toHaveLength(3); // one resting-order look per market, none sent
    expect(journal.read().at(-1)).toMatchObject({ kind: "cancel", sent: false });
  });
  it("finds a just-armed bracket the indexer has not caught up with, from this journal, confirmed on chain", async () => {
    const { deps, state } = longSol();
    await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    state.indexLag = true;
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.nothingToCancel).toBe(false);
    expect(r.cancelledStops.map((s) => s.id).sort()).toEqual(["11", "12"]);
  });
  it("does not cancel a journaled stop that is no longer live on chain", async () => {
    const { deps, state } = longSol();
    await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    state.indexLag = true;
    state.onChain.clear(); // it fired or was cancelled elsewhere
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.cancelledStops).toEqual([]);
    expect(state.cancelCalls.some(([k]) => k === "stops")).toBe(false);
  });
  it("never claims 'nothing to cancel' when the stop read failed", async () => {
    const { deps, state, journal } = longSol();
    state.listError = new Error("indexer down");
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(r.nothingToCancel).toBeUndefined();
    expect(state.cancelCalls).toEqual([]);
    expect(journal.read().at(-1)).toMatchObject({ kind: "error", stage: "cancel" });
  });
  it("cancels resting orders on a named market and on a market with no position", async () => {
    const { deps, state } = makeDeps();
    state.resting = [7n];
    const r = await cancelAll(deps, {});
    expect(r.cancelledOrders).toEqual([{ market: "SOL", id: "7" }]);
    expect(r.txs[0].what).toMatch(/resting orders on SOL/);
  });
  it("reports a failed cancel as not ok with the exchange's reason, and the journal row is not sent:false", async () => {
    const { deps, state, journal } = longSol();
    stopsOn(state);
    state.cancelStopsError = Object.assign(new Error("x"), { name: "ContractRevertError", errorName: "NothingToClaim" });
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ refused_by: "exchange", code: "NothingToClaim" });
    expect(journal.read().at(-1)).toMatchObject({ kind: "cancel", sent: "unknown" });
  });
  it("keeps going to resting orders after a failed stop cancel (partial success)", async () => {
    const { deps, state } = longSol();
    stopsOn(state);
    state.resting = [9n];
    state.cancelStopsError = Object.assign(new Error("rpc"), { name: "RpcError" });
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.ok).toBe(false);
    expect(r.cancelledOrders).toEqual([{ market: "SOL", id: "9" }]);
    expect(r.failures).toHaveLength(1);
  });
  it("treats a cancel tx that did not succeed as a failure, not a cancel", async () => {
    const { deps, state } = longSol();
    stopsOn(state);
    deps.chain.cancelStops = async () => ({ hash: "0x" + "9".repeat(64), receipt: { status: "reverted" } });
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.ok).toBe(false);
    expect(r.cancelledStops).toEqual([]);
    expect(r.failures[0].tx).toBe("0x" + "9".repeat(64));
  });
  it("refuses while an order on the same market is in flight", async () => {
    const { deps } = longSol();
    deps.inflight = { opens: 0, markets: new Set(["SOL"]) };
    expect(await cancelAll(deps, { market: "SOL" })).toMatchObject({ ok: false, reason: expect.stringMatching(/already in flight/) });
  });
});

describe("bracket guards (round 1)", () => {
  it("two parallel brackets on one market send only one", async () => {
    const { deps, state } = longSol();
    const [a, b] = await Promise.all([
      bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 }),
      bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(state.stopCalls).toHaveLength(1);
  });
  it("refuses a second bracket right after the first even while the indexer lags (journal + chain)", async () => {
    const { deps, state } = longSol();
    expect((await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).ok).toBe(true);
    state.indexLag = true;
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, rule: "bracketExists" });
    expect(state.stopCalls).toHaveLength(1);
  });
  it("reports the one-time operator grant tx the SDK sent before the stop", async () => {
    const { deps, state, journal } = longSol();
    state.grantTx = "0x" + "a".repeat(64);
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r.operatorGrantTxs).toEqual(["0x" + "a".repeat(64)]);
    expect(journal.read().at(-1).operatorGrantTxs).toEqual(["0x" + "a".repeat(64)]);
  });
  it("after a failure never names one hash as the failing tx when the SDK may have sent two", async () => {
    const { deps, state } = longSol();
    state.stopError = Object.assign(new Error("rpc"), { name: "RpcError", txHashes: ["0x" + "a".repeat(64)] });
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r).toMatchObject({ ok: false, sent: true, tx: null, txsSeen: ["0x" + "a".repeat(64)] });
  });
  it("refuses triggers that round onto or across the mark", async () => {
    const { deps, state } = longSol();
    deps.client().listPerpMarkets = async () => [{ ...SOL, tickSize: (1000n * 10n ** 18n).toString() }]; // a $1000 tick: both triggers round to 0
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 0.1, stop_loss_pct: 0.1 })).toMatchObject({ ok: false, rule: "triggersTooTight" });
    expect(state.stopCalls).toEqual([]);
  });
  it("refuses a market with no stop registry", async () => {
    const { deps } = longSol();
    deps.client().listPerpMarkets = async () => [{ ...SOL, stopRegistry: undefined }];
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, rule: "noStopRegistry" });
  });
  it("sends nothing and journals an error when the mark cannot be priced", async () => {
    const { deps, state } = longSol();
    deps.client().getPerpPositionAnalytics = async () => ({ priceable: false });
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, rule: "markUnknown" });
    expect(state.stopCalls).toEqual([]);
  });
  it("still reports a landed bracket when the journal write fails", async () => {
    const { deps } = longSol();
    const real = deps.journal.append;
    deps.journal.append = (e) => { if (e.kind === "bracket") throw new Error("disk full"); return real(e); };
    const r = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    expect(r.ok).toBe(true);
    expect(r.journalError).toMatch(/disk full/);
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
    expect(md).toMatch(/refusals by pilot's policy: \*\*1\*\* rows \(\*\*1\*\* distinct rules\); refusals by the exchange: \*\*1\*\*/i);
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

describe("DEMO.md notes", () => {
  it("prints a journal note (an injected race says so in the journal itself)", () => {
    const md = renderDemo([{ at: "2026-10-24T05:00:00.000Z", kind: "note", text: "race injected by the demo script" }]);
    expect(md).toContain("## Notes recorded in the journal");
    expect(md).toContain("race injected by the demo script");
  });
});

describe("DEMO.md honesty", () => {
  const refusal = { at: "2026-10-24T05:00:00.000Z", kind: "refusal", refused_by: "exchange", stage: "chain", market: "SOL", side: "buy", size: "0.1", code: "ImmediateOrCancelNoFill", reason: "found nothing to fill", next: "plan again: the book moved", tx: "0x" + "7".repeat(64) };
  it("marks an injected exchange refusal in the summary, the row and the section text, and drops 'the book moved'", () => {
    const md = renderDemo([{ ...refusal, injected: true, sentLimitPrice: "98.4" }]);
    expect(md).toMatch(/refusals by the exchange: \*\*1\*\* \(1 of them with the race injected/);
    expect(md).toContain("**(race injected, sent at 98.4)**");
    expect(md).toContain("no natural race");
    expect(md).not.toContain("the book moved");
  });
  it("keeps a natural exchange refusal as it is", () => {
    const md = renderDemo([refusal]);
    expect(md).not.toContain("race injected, sent");
    expect(md).toContain("plan again: the book moved");
  });
  it("shows which journal each transaction came from", () => {
    const md = renderDemo([{ at: "2026-10-24T05:00:00.000Z", kind: "order", direction: "long", size: "0.1", market: "SOL", limitPrice: "1", filled: "0.1", positionAfter: "0.1", tx: "0x" + "8".repeat(64), _src: "run-a.jsonl" }]);
    expect(md).toContain("| journal |");
    expect(md).toContain("| run-a.jsonl |");
  });
});

describe("stop ownership and failed reads (round 2)", () => {
  it("never cancels a stop that the chain says another account owns, even if the indexer lists it", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "55", registry: SOL.stopRegistry, isBid: false }, { orderIdRaw: "56", registry: SOL.stopRegistry, isBid: false }];
    state.onChain.set("55", { registry: SOL.stopRegistry, owner: "0x000000000000000000000000000000000000dEaD" });
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.cancelledStops.map((s) => s.id)).toEqual(["56"]);
  });
  it("asks the chain about an id on the registry it belongs to, not any registry", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "70", registry: "0xdeadbeef00000000000000000000000000000000", isBid: false }];
    expect((await cancelAll(deps, { market: "SOL" })).cancelledStops).toEqual([]);
  });
  it("bracket sends nothing when the on-chain stop read throws", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "11", registry: SOL.stopRegistry }];
    state.stopReadError = new Error("rpc 502");
    expect(await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 })).toMatchObject({ ok: false, sent: false });
    expect(state.stopCalls).toEqual([]);
  });
  it("cancel_all reports a failed on-chain stop read instead of 'nothing to cancel'", async () => {
    const { deps, state } = longSol();
    state.stops = [{ orderIdRaw: "11", registry: SOL.stopRegistry }];
    state.stopReadError = new Error("rpc 502");
    const r = await cancelAll(deps, { market: "SOL" });
    expect(r.ok).toBe(false);
    expect(r.nothingToCancel).toBe(false);
    expect(r.failures[0]).toMatchObject({ stage: "read stops" });
  });
  it("a corrupt journal line stops bracket and cancel_all before anything is sent", async () => {
    const { deps, state, journal } = longSol();
    const { appendFileSync } = await import("node:fs");
    appendFileSync(journal.path, "not json\n");
    const b = await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 }).catch((e) => e);
    expect(b instanceof Error ? b.message : b.error).toMatch(/not valid JSON/);
    expect(state.stopCalls).toEqual([]);
  });
  it("account shows a just-armed bracket the indexer has not listed, and says when it cannot read", async () => {
    const { deps, state } = longSol();
    await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    state.indexLag = true;
    expect((await accountInfo(deps)).pendingBrackets.map((b) => b.id).sort()).toEqual(["11", "12"]);
    state.stopReadError = new Error("rpc 502");
    expect((await accountInfo(deps)).pendingBrackets.unavailable).toMatch(/rpc 502/);
  });
  it("skips journaled stop ids that a later cancel already removed (no endless chain reads)", async () => {
    const { deps, state } = longSol();
    await bracket(deps, { market: "SOL", take_profit_pct: 3, stop_loss_pct: 2 });
    await cancelAll(deps, { market: "SOL" });
    let reads = 0;
    const orig = deps.client().getPerpStopOrder;
    deps.client().getPerpStopOrder = async (a) => { reads++; return orig(a); };
    state.indexLag = true;
    await cancelAll(deps, { market: "SOL" });
    expect(reads).toBe(0);
  });
});
