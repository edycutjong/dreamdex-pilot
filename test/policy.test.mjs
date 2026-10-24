import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, evaluate, loadPolicy } from "../src/policy.mjs";

const ok = { market: "SOL", notionalUsd: 10, liquidationDistancePct: 40, ordersToday: 0 };
const rules = (f) => evaluate(DEFAULT_POLICY, { ...ok, ...f }).map((v) => v.rule);

describe("evaluate", () => {
  it("passes an order inside every limit", () => expect(rules({})).toEqual([]));
  it("refuses a market off the allowlist", () => expect(rules({ market: "DOGE" })).toEqual(["allowedMarkets"]));
  it("refuses notional above the cap", () => expect(rules({ notionalUsd: 25.01 })).toEqual(["maxNotionalUsd"]));
  it("allows notional exactly at the cap", () => expect(rules({ notionalUsd: 25 })).toEqual([]));
  it("refuses a liquidation closer than the minimum", () => expect(rules({ liquidationDistancePct: 14.9 })).toEqual(["minLiquidationDistancePct"]));
  it("treats no reachable liquidation price as safe, never as distance 0", () => expect(rules({ liquidationDistancePct: null })).toEqual([]));
  it("refuses at the daily cap", () => expect(rules({ ordersToday: 20 })).toEqual(["dailyOrderCap"]));
  it("reports every broken rule at once, each with a next step", () => {
    const v = evaluate(DEFAULT_POLICY, { market: "DOGE", notionalUsd: 99, liquidationDistancePct: 2, ordersToday: 20 });
    expect(v.map((x) => x.rule)).toEqual(["allowedMarkets", "maxNotionalUsd", "minLiquidationDistancePct", "dailyOrderCap"]);
    expect(v.every((x) => x.next)).toBe(true);
  });
});

describe("loadPolicy", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-policy-"));
  it("falls back to defaults only when the file is missing, and says so", () => {
    const p = loadPolicy(join(dir, "missing.json"));
    expect(p.maxNotionalUsd).toBe(25);
    expect(p.source).toMatch(/defaults/);
  });
  it("merges a partial file over the defaults and upper-cases markets", () => {
    const f = join(dir, "p.json");
    writeFileSync(f, JSON.stringify({ maxNotionalUsd: 10, allowedMarkets: ["btc"] }));
    const p = loadPolicy(f);
    expect(p).toMatchObject({ maxNotionalUsd: 10, allowedMarkets: ["BTC"], minLiquidationDistancePct: 15, source: f });
  });
  it("rejects an invalid file instead of silently using defaults", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ maxNotionalUsd: -1 }));
    expect(() => loadPolicy(f)).toThrow();
  });
  it("rejects unknown keys (a typo must not silently drop a limit)", () => {
    const f = join(dir, "typo.json");
    writeFileSync(f, JSON.stringify({ maxNotional: 5 }));
    expect(() => loadPolicy(f)).toThrow();
  });
});
