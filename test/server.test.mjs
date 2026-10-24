import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.mjs";
import { makeDeps } from "./fixtures.mjs";

const SOL = {
  baseSymbol: "SOL", poolAddress: "0xb483ec1fb34996638677c20ab087b16f1896fa53", marginBank: "0x478769e1177c0773c43a593dccc4ad15f15f1394",
  markPrice: "102509386279672500000", indexPrice: "102564359184071500000", lastPrice: "102510000000000000000",
  initialMarginBps: 500, baseDecimals: 9, quoteDecimals: 18, minQuantity: "100000000", lotSize: "10000000",
  tickSize: "10000000000000000", fundingRate: "104234061889228", fundingWindowSec: 28800, openInterest: "21462810000000",
};

const connect = async (stub) => {
  const server = createServer({ client: () => stub });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

describe("MCP server", () => {
  it("lists the markets tool", async () => {
    const c = await connect({ listPerpMarkets: async () => [SOL] });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain("markets");
    expect(tools.find((t) => t.name === "markets").annotations.readOnlyHint).toBe(true);
  });
  it("answers markets with human units", async () => {
    const c = await connect({ listPerpMarkets: async () => [SOL] });
    const r = await c.callTool({ name: "markets", arguments: { symbol: "SOL" } });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(1);
    expect(body.markets[0].minQuantity).toBe("0.1");
  });
  it("returns a tool error for an unknown symbol", async () => {
    const c = await connect({ listPerpMarkets: async () => [SOL] });
    const r = await c.callTool({ name: "markets", arguments: { symbol: "NOPE" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No perp market named NOPE/);
  });
  it("returns a tool error when the read fails", async () => {
    const c = await connect({ listPerpMarkets: async () => { throw Object.assign(new Error("socket closed"), { name: "RpcError" }); } });
    const r = await c.callTool({ name: "markets", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/RpcError: socket closed/);
  });

  it("lists all six tools with honest annotations", async () => {
    const { deps } = makeDeps();
    const c = await connectDeps(deps);
    const { tools } = await c.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(["close_position", "journal", "markets", "place_order", "plan_order", "policy"]);
    expect(by.place_order.annotations.destructiveHint).toBe(true);
    expect(by.close_position.annotations.destructiveHint).toBe(true);
    expect(by.plan_order.annotations.readOnlyHint).toBe(true);
  });
  it("plan_order wants exactly one of size or notional_usd", async () => {
    const c = await connectDeps(makeDeps().deps);
    const both = await c.callTool({ name: "plan_order", arguments: { market: "SOL", side: "long", size: "0.1", notional_usd: 10 } });
    const none = await c.callTool({ name: "plan_order", arguments: { market: "SOL", side: "long" } });
    expect(both.isError).toBe(true);
    expect(none.content[0].text).toMatch(/exactly one/);
  });
  it("runs plan -> place -> close -> journal over MCP", async () => {
    const { deps, state } = makeDeps();
    const c = await connectDeps(deps);
    const call = async (name, args) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
    const p = await call("plan_order", { market: "sol", side: "long", size: "0.1" });
    expect(p.verdict).toBe("ok");
    const o = await call("place_order", { plan_id: p.plan_id });
    expect(o).toMatchObject({ ok: true, positionAfter: "0.1" });
    const x = await call("close_position", { market: "SOL" });
    expect(x).toMatchObject({ ok: true, positionAfter: "0" });
    const j = await call("journal", {});
    expect(j.entries.map((e) => e.kind)).toEqual(["plan", "order", "close"]);
    expect(state.sends).toHaveLength(2);
    const pol = await call("policy", {});
    expect(pol).toMatchObject({ maxNotionalUsd: 25, ordersSentTodayUtc: 1 });
  });
  it("returns a refused place_order as a tool error the agent can read", async () => {
    const c = await connectDeps(makeDeps().deps);
    const r = await c.callTool({ name: "place_order", arguments: { plan_id: "plan_000000000000" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ refused_by: "pilot-policy", rule: "unknownPlan" });
  });
  it("rejects a malformed plan_id at the schema", async () => {
    const c = await connectDeps(makeDeps().deps);
    const r = await c.callTool({ name: "place_order", arguments: { plan_id: "anything" } });
    expect(r.isError).toBe(true);
  });
});

const connectDeps = async (deps) => {
  const server = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};
