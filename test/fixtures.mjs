// Stub chain for unit tests: one SOL book and a position that real sends move.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../src/journal.mjs";
import { DEFAULT_POLICY } from "../src/policy.mjs";

const E18 = 10n ** 18n;
export const px = (x) => BigInt(Math.round(x * 100)) * 10n ** 16n; // 2-decimal price -> 18-decimal raw
export const sol = (x) => BigInt(Math.round(x * 100)) * 10n ** 7n; // 2-decimal size -> 9-decimal raw

const market = (sym, pool) => ({
  id: `${sym}-id`, baseSymbol: sym, poolAddress: pool, marginBank: "0x478769e1177c0773c43a593dccc4ad15f15f1394",
  markPrice: px(102.51).toString(), indexPrice: px(102.5).toString(), lastPrice: px(102.51).toString(),
  initialMarginBps: 500, baseDecimals: 9, quoteDecimals: 18, minQuantity: sol(0.1).toString(), lotSize: sol(0.01).toString(),
  tickSize: (10n ** 16n).toString(), fundingRate: "0", fundingWindowSec: 28800, openInterest: "0",
});
export const SOL = market("SOL", "0xb483ec1fb34996638677c20ab087b16f1896fa53");
export const ETH = market("ETH", "0x00000000000000000000000000000000000000e0"); // SOL's numbers, own pool
// DOGE as on chain 2026-10-24: 8 decimals, minimum 120, lot 10, ~$0.0788.
export const DOGE = { ...market("DOGE", "0x00000000000000000000000000000000000000d0"), baseDecimals: 8, minQuantity: "12000000000", lotSize: "1000000000", markPrice: "78757972421000000" };

export const makeDeps = (over = {}) => {
  const state = {
    bid: px(102.5), ask: px(102.52), pos: 0n, sends: [], clock: Date.parse("2026-10-24T03:00:00Z"),
    max: { priceable: true, placeable: true, maxQuantity: sol(7.8), limitedBy: "margin" },
    margin: { priceable: true, lockAmount: E18, meetsInitialMargin: true, hasCollateralForLock: true, voucherBlocked: false, markPrice: px(102.51) },
    liq: { priceable: true, projectedLiquidationPrice: 0n, markPrice: px(102.51), projectedPositionLeverageBps: 2000n },
    sendError: null,
  };
  const previews = [];
  const client = {
    listPerpMarkets: async () => [SOL, ETH, DOGE],
    getBookTopsOnchain: async ([{ poolAddress }]) => ({ tops: { [poolAddress]: { bestBid: state.bid, bestAsk: state.ask } } }),
    // The real SDK throws on quantity 0 ("quantity must be > 0"); so does the stub.
    getMaxPerpOrderSize: async () => state.max,
    previewPerpOrderMargin: async (a) => { if (a.quantity <= 0n) throw new Error("quantity must be > 0"); previews.push(a); return state.margin; },
    previewPerpLiquidationPrice: async (a) => { if (a.quantity <= 0n) throw new Error("quantity must be > 0"); return state.liq; },
    getPerpPosition: async () => ({ size: state.pos, avgEntryPrice: 0n }),
  };
  const send = async (order) => {
    state.sends.push(order);
    if (state.sendError) throw state.sendError;
    state.pos += order.isBid ? order.quantity : -order.quantity;
    return { hash: `0x${String(state.sends.length).padStart(64, "a")}`, receipt: { blockNumber: 31555711n + BigInt(state.sends.length), status: "success", gasUsed: 1_234_567n }, fills: [{ quantityFilled: order.quantity }] };
  };
  const journal = createJournal(join(mkdtempSync(join(tmpdir(), "pilot-test-")), "journal.jsonl"));
  const policy = { ...DEFAULT_POLICY, source: "test" };
  const deps = {
    client: () => client, account: () => "0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b", send, journal,
    policy: () => policy, plans: new Map(), now: () => state.clock, ...over,
  };
  return { deps, state, policy, journal, previews };
};
