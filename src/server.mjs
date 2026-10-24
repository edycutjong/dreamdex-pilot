// Pilot MCP server: markets, plan_order, place_order, close_position, policy, journal.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMarkets } from "./markets.mjs";
import { json } from "./client.mjs";
import { planOrder, placeOrder, closePosition } from "./trader.mjs";
import { describeError } from "./exchange-errors.mjs";

export const VERSION = "0.1.0";
const NETWORK = "Somnia Hideki testnet (chain 50383)";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : json(v) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: typeof msg === "string" ? msg : json(msg) }] });
const guard = (label, fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e?.pilotUser ? e.message : `${label} failed: ${describeError(e)}`);
  }
};

// deps: client() SDK read client; account() trading address; send(order) the signed placePerpOrder;
// journal; policy(); plans (Map, optional); now() (optional). Tests pass stubs for all of them.
export const createServer = (deps) => {
  const d = { plans: new Map(), now: () => Date.now(), ...deps };
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
    guard("markets read", async ({ symbol }) => {
      const rows = await listMarkets(d.client(), { symbol });
      if (symbol && rows.length === 0) return fail(`No perp market named ${symbol.toUpperCase()}. Call markets with no symbol to see all of them.`);
      return text({ network: NETWORK, count: rows.length, markets: rows });
    }),
  );

  server.registerTool(
    "plan_order",
    {
      title: "Plan a perp order (no transaction)",
      description:
        "Plan a market-taking (IOC) perp order WITHOUT sending it: reads the exchange's max order size, margin preview and projected liquidation price, checks them against the user's policy (allowed markets, max notional, min liquidation distance, daily cap), and returns the numbers plus a verdict. An ok plan gets a short-lived one-shot plan_id for place_order. Give exactly one of size (base units, e.g. \"0.1\" SOL) or notional_usd. Show the user the liquidation price before placing.",
      inputSchema: {
        market: z.string().min(1).max(16).describe("Base symbol, e.g. BTC, ETH, SOL"),
        side: z.enum(["long", "short"]),
        size: z.string().regex(/^\d+(\.\d+)?$/).optional().describe("Size in base units, e.g. \"0.1\""),
        notional_usd: z.number().positive().max(1_000_000).optional().describe("Size as USD notional, e.g. 20"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard("plan_order", async ({ market, side, size, notional_usd }) => {
      if ((size == null) === (notional_usd == null)) return fail("Give exactly one of size or notional_usd.");
      try {
        return text({ network: NETWORK, ...(await planOrder(d, { market, side, size, notionalUsd: notional_usd })) });
      } catch (e) {
        // An unexpected failure is journaled too (a plan never sends, so it never counts toward the cap).
        if (!e?.pilotUser) d.journal.append({ kind: "error", stage: "plan", action: "open", sent: false, market, side, size: size ?? null, notionalUsd: notional_usd ?? null, error: describeError(e) });
        throw e;
      }
    }),
  );

  server.registerTool(
    "place_order",
    {
      title: "Send a planned perp order (real testnet transaction)",
      description:
        "Send the order from an ok plan_order result as a real IOC transaction on Somnia testnet. Refuses an unknown, expired, already-used or stale plan (the book moved past its limit) and re-checks the daily cap. Returns the tx hash, fill and the position read back from chain. If the exchange itself refuses, the result says refused_by \"exchange\" with the reason in plain words.",
      inputSchema: { plan_id: z.string().regex(/^plan_[0-9a-f]{12}$/).describe("plan_id from plan_order") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard("place_order", async ({ plan_id }) => {
      const r = await placeOrder(d, { plan_id });
      return r.ok ? text({ network: NETWORK, ...r }) : fail({ network: NETWORK, ...r });
    }),
  );

  server.registerTool(
    "close_position",
    {
      title: "Close a perp position (real testnet transaction)",
      description:
        "Close this account's whole position in one market with an IOC order sized from the live on-chain position. Never blocked by policy: closing reduces risk. Returns the tx hash and the position left after (0 = flat).",
      inputSchema: { market: z.string().min(1).max(16).describe("Base symbol, e.g. SOL") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard("close_position", async ({ market }) => {
      const r = await closePosition(d, { market });
      return r.ok ? text({ network: NETWORK, ...r }) : fail({ network: NETWORK, ...r });
    }),
  );

  server.registerTool(
    "policy",
    {
      title: "Show the trading policy",
      description:
        "Show the user's trading limits (max notional, min liquidation distance, allowed markets, daily order cap, slippage, plan lifetime), where they come from, and how many orders were sent today. Read-only: only the user changes the policy file, never the agent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard("policy", async () => {
      const p = d.policy();
      return text({ ...p, ordersSentTodayUtc: d.journal.ordersToday(new Date(d.now())), editableBy: "the user only (edit the file; there is no tool for it)" });
    }),
  );

  server.registerTool(
    "journal",
    {
      title: "Read the trade journal",
      description:
        "Read the append-only journal of every plan, refusal (by pilot's policy or by the exchange) and transaction, newest last. Optionally filter by kind.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("How many recent entries (default 20)"),
        kind: z.enum(["plan", "refusal", "order", "close", "error"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard("journal", async ({ limit = 20, kind }) => {
      const all = d.journal.read();
      const rows = kind ? all.filter((e) => e.kind === kind) : all;
      return text({ path: d.journal.path, total: rows.length, entries: rows.slice(-limit) });
    }),
  );

  return server;
};
