import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.mjs";

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
});
