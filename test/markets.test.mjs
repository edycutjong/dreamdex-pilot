import { describe, it, expect } from "vitest";
import { formatMarket, listMarkets } from "../src/markets.mjs";

// Shape copied from a live listPerpMarkets() SOL row (2026-10-24).
const SOL = {
  baseSymbol: "SOL", poolAddress: "0xb483ec1fb34996638677c20ab087b16f1896fa53", marginBank: "0x478769e1177c0773c43a593dccc4ad15f15f1394",
  markPrice: "102509386279672500000", indexPrice: "102564359184071500000", lastPrice: "102510000000000000000",
  initialMarginBps: 500, baseDecimals: 9, quoteDecimals: 18, minQuantity: "100000000", lotSize: "10000000",
  tickSize: "10000000000000000", fundingRate: "104234061889228", fundingWindowSec: 28800, openInterest: "21462810000000",
};
const BTC = { ...SOL, baseSymbol: "BTC", poolAddress: "0x0000000000000000000000000000000000000001", initialMarginBps: 1000 };

describe("quote decimals", () => {
  it("formats prices in the market's quote decimals, not a fixed 18", () => {
    const six = { ...SOL, quoteDecimals: 6, markPrice: "102509386", indexPrice: "102564359", lastPrice: "102510000", tickSize: "10000" };
    expect(formatMarket(six)).toMatchObject({ markPrice: 102.509386, indexPrice: 102.564359, lastPrice: 102.51, tickSize: "0.01" });
  });
});

describe("formatMarket", () => {
  it("converts raw units to human units", () => {
    const r = formatMarket(SOL);
    expect(r.symbol).toBe("SOL");
    expect(r.markPrice).toBeCloseTo(102.5094, 3);
    expect(r.minQuantity).toBe("0.1");
    expect(r.lotSize).toBe("0.01");
    expect(r.tickSize).toBe("0.01");
    expect(r.maxLeverage).toBe(20);
    expect(r.fundingWindowHours).toBe(8);
    expect(r.fundingRatePerWindowPct).toBeCloseTo(0.0104, 4);
    expect(r.openInterest).toBe("21462.81");
  });
  it("derives max leverage from initial margin", () => {
    expect(formatMarket(BTC).maxLeverage).toBe(10);
    expect(formatMarket({ ...SOL, initialMarginBps: 0 }).maxLeverage).toBeNull();
  });
});

describe("listMarkets", () => {
  const client = { listPerpMarkets: async () => [SOL, BTC] };
  it("sorts by symbol", async () => {
    expect((await listMarkets(client)).map((r) => r.symbol)).toEqual(["BTC", "SOL"]);
  });
  it("filters by symbol case-insensitively", async () => {
    expect((await listMarkets(client, { symbol: "sol" })).map((r) => r.symbol)).toEqual(["SOL"]);
    expect(await listMarkets(client, { symbol: "NOPE" })).toEqual([]);
  });
});
