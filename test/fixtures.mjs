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
  id: `${sym}-id`, baseSymbol: sym, poolAddress: pool, stopRegistry: `0x${sym.toLowerCase().padEnd(40, "5").slice(0, 40)}`, marginBank: "0x478769e1177c0773c43a593dccc4ad15f15f1394",
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
    stops: [], onChain: new Map(), indexLag: false, stopCalls: [], cancelCalls: [], native: 5n * E18, stopError: null, resting: [], avgEntry: px(100),
  };
  const previews = [];
  const client = {
    listPerpMarkets: async () => [SOL, ETH, DOGE],
    getBookTopsOnchain: async ([{ poolAddress }]) => ({ tops: { [poolAddress]: { bestBid: state.bid, bestAsk: state.ask } } }),
    // The real SDK throws on quantity 0 ("quantity must be > 0"); so does the stub.
    getMaxPerpOrderSize: async () => state.max,
    previewPerpOrderMargin: async (a) => { if (a.quantity <= 0n) throw new Error("quantity must be > 0"); previews.push(a); return state.margin; },
    previewPerpLiquidationPrice: async (a) => { if (a.quantity <= 0n) throw new Error("quantity must be > 0"); return state.liq; },
    getPerpPosition: async () => ({ size: state.pos, avgEntryPrice: state.avgEntry }),
    getPerpPositionAnalytics: async () => ({ priceable: true, markPrice: px(102.51), avgEntryPrice: state.avgEntry, size: state.pos, unrealizedPnl: 3n * E18 / 2n, notional: 31n * E18 / 2n }),
    getMarginAccount: async () => ({ unlockedCollateralBalance: 40n * E18, lockedCollateral: 2n * E18, equity: 42n * E18, withdrawable: 40n * E18, imReq: E18, mmReq: E18 / 2n, cmReq: E18 / 4n, marginStatus: "Healthy", asOfBlock: 31555000n, activePerpPools: state.pos === 0n ? [] : [SOL.poolAddress.toUpperCase()] }),
    listPerpStopOrders: async () => { if (state.listError) throw state.listError; return state.indexLag ? [] : state.stops; },
    // Live on chain = a row in state.onChain, or any pending indexer row (owned by the account).
    getPerpStopOrder: async ({ registry, orderId }) => {
      if (state.stopReadError) throw state.stopReadError;
      const id = String(orderId);
      const row = state.onChain.get(id) ?? state.stops.find((s) => String(s.orderIdRaw) === id);
      // Honours the registry the id was asked of, like the chain: ids are per registry.
      if (!row || (row.registry && String(row.registry).toLowerCase() !== String(registry).toLowerCase())) return null;
      return { owner: row.owner ?? "0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b", isBid: row.isBid ?? false, triggerPrice: BigInt(row.triggerPrice ?? 1), triggerOperator: row.triggerOperator ?? 0 };
    },
    getPerpStopOrderSomiPayment: async () => 15n * 10n ** 16n,
  };
  const send = async (order) => {
    state.sends.push(order);
    if (state.sendError) throw state.sendError;
    state.pos += order.isBid ? order.quantity : -order.quantity;
    return { hash: `0x${String(state.sends.length).padStart(64, "a")}`, receipt: { blockNumber: 31555711n + BigInt(state.sends.length), status: "success", gasUsed: 1_234_567n }, fills: [{ quantityFilled: order.quantity }] };
  };
  const chain = {
    placeStops: async (p) => {
      state.stopCalls.push(p);
      if (state.stopError) throw state.stopError;
      state.onChain.set("11", { registry: p.registry, isBid: p.isBid }); state.onChain.set("12", { registry: p.registry, isBid: p.isBid });
      return { hash: `0x${"b".repeat(64)}`, receipt: { blockNumber: 31556000n, status: "success", gasUsed: 2_000_000n }, stopOrderId: 11n, pairedStopOrderId: 12n, txsSent: state.grantTx ? [state.grantTx, `0x${"b".repeat(64)}`] : [`0x${"b".repeat(64)}`] };
    },
    cancelStops: async (p) => { state.cancelCalls.push(["stops", p]); if (state.cancelStopsError) throw state.cancelStopsError; state.stops = []; state.onChain.clear(); return { hash: `0x${"c".repeat(64)}`, receipt: { blockNumber: 31556100n, status: "success" } }; },
    cancelAll: async (pool) => {
      state.cancelCalls.push(["orders", pool]);
      if (state.cancelOrdersError) throw state.cancelOrdersError;
      if (!state.resting.length || pool !== SOL.poolAddress) return { sent: false, orderIds: [], outcomes: [] };
      return { sent: true, orderIds: state.resting, hash: `0x${"d".repeat(64)}`, receipt: { blockNumber: 31556200n, status: "success" } };
    },
  };
  const journal = createJournal(join(mkdtempSync(join(tmpdir(), "pilot-test-")), "journal.jsonl"));
  const policy = { ...DEFAULT_POLICY, source: "test" };
  const deps = {
    client: () => client, account: () => "0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b", send, journal,
    policy: () => policy, plans: new Map(), now: () => state.clock, chain, native: async () => state.native, ...over,
  };
  return { deps, state, policy, journal, previews };
};
