// Pilot MCP server. P1: the `markets` tool only; planning and placing come next.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMarkets } from "./markets.mjs";
import { json } from "./client.mjs";

export const VERSION = "0.1.0";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : json(v) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

// `deps.client` is the SDK read client; tests pass a stub.
export const createServer = (deps) => {
  const server = new McpServer({ name: "pilot", version: VERSION });

  server.registerTool(
    "markets",
    {
      title: "List dreamDEX perp markets",
      description:
        "List the dreamDEX perpetual markets on Somnia testnet with mark/index price, max leverage, minimum size, lot and tick size, funding and open interest. Optionally filter by symbol (e.g. BTC).",
      inputSchema: { symbol: z.string().min(1).max(16).optional().describe("Base symbol, e.g. BTC, ETH, SOL") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        const rows = await listMarkets(deps.client(), { symbol });
        if (symbol && rows.length === 0) return fail(`No perp market named ${symbol.toUpperCase()}. Call markets with no symbol to see all of them.`);
        return text({ network: "Somnia Hideki testnet (chain 50383)", count: rows.length, markets: rows });
      } catch (e) {
        return fail(`markets read failed: ${e?.name ?? "Error"}: ${e?.message ?? e}`);
      }
    },
  );

  return server;
};
