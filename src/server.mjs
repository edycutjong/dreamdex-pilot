// Pilot MCP server: markets, account, plan_order, place_order, close_position, bracket, cancel_all, policy, journal.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMarkets } from "./markets.mjs";
import { json } from "./client.mjs";
import { planOrder, placeOrder, closePosition, ordersToday } from "./trader.mjs";
import { accountInfo, armedBrackets, bracket, cancelAll } from "./tools.mjs";
import { describeError } from "./exchange-errors.mjs";

export const VERSION = "0.1.0";
const NETWORK = "Somnia Hideki testnet (chain 50383)";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : json(v) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: typeof msg === "string" ? msg : json(msg) }] });
// A JSON number as a plain decimal string (1e-7 would not parse as a size).
const decimalString = (n) => (typeof n === "string" ? n : /e/i.test(String(n)) ? n.toFixed(18).replace(/0+$/, "") : String(n));
const guard = (label, fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e?.pilotUser ? e.message : `${label} failed: ${describeError(e)}`);
  }
};

// deps: client() SDK read client; account() trading address; send(order) the signed placePerpOrder;
// chain {placeStops, cancelStops, cancelAll} the other signed writes; native() the STT balance;
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
    "account",
    {
      title: "Show the trading account",
      description:
        "Show this account's state read live from chain: STT for gas, USDso collateral (equity, unlocked, locked as margin), margin status, open positions with entry, mark and unrealized PnL, pending take-profit/stop-loss brackets, and your policy limits with today's order count. Call it before sizing an order and after any trade.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard("account", async () => text({ network: NETWORK, ...(await accountInfo(d)) })),
  );

  server.registerTool(
    "plan_order",
    {
      title: "Plan a perp order (no transaction)",
      description:
        "Plan a market-taking (IOC) perp order WITHOUT sending it: reads the exchange's max order size, margin preview and projected liquidation price, checks them against the user's policy (allowed markets, max notional of the position the order leaves in that market, min liquidation distance, daily cap), and returns the numbers plus a verdict. An ok plan gets a short-lived one-shot plan_id for place_order. Give exactly one of size (base units, e.g. \"0.1\" SOL) or notional_usd. Show the user the liquidation price before placing, or liquidationNote when there is none (small sizes have no reachable liquidation).",
      inputSchema: {
        market: z.string().min(1).max(16).describe("Base symbol, e.g. BTC, ETH, SOL"),
        side: z.enum(["long", "short"]),
        // Some clients (MCP Inspector's CLI) JSON-parse "0.1" into a number before sending it.
        size: z.union([z.string().max(40).regex(/^\d+(\.\d+)?$/), z.number().positive().max(1e12)]).optional().describe("Size in base units, e.g. \"0.1\""),
        notional_usd: z.number().positive().max(1_000_000).optional().describe("Size as USD notional, e.g. 20"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard("plan_order", async ({ market, side, size: rawSize, notional_usd }) => {
      const size = rawSize == null ? rawSize : decimalString(rawSize);
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
        "Send the order from an ok plan_order result as a real IOC transaction on Somnia testnet. Refuses an unknown, expired, already-used or stale plan (the book moved past its limit, or the position changed), re-checks the policy, and re-runs the liquidation and margin previews on live state (refusals: minLiquidationDistancePct, liquidationUnknown, marginUnknown, voucherBlocked, margin). The limit price is re-derived from the live touch and maxSlippagePct and only ever tightens. Returns the tx hash, fill and the position read back from chain. If the exchange itself refuses, the result says refused_by \"exchange\" with the reason in plain words.",
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
      if (r.ok) {
        // A bracket outlives the position it protected: say so, never cancel it behind the user's back.
        try {
          const armed = await armedBrackets(d, market);
          if (armed.length)
            r.bracketStillArmed = { stopIds: armed.map((x) => x.id), note: `this ${r.market} bracket stays armed and will act on your next ${r.market} position at its old trigger prices`, next: `cancel_all with market ${r.market} removes it` };
        } catch (e) {
          r.bracketCheck = `could not read the ${r.market} brackets (${describeError(e)}); account lists them`;
        }
      }
      return r.ok ? text({ network: NETWORK, ...r }) : fail({ network: NETWORK, ...r });
    }),
  );

  server.registerTool(
    "bracket",
    {
      title: "Arm take-profit + stop-loss on a position (real testnet transaction)",
      description:
        "Arm a linked take-profit and stop-loss (one cancels the other) on this account's open position in one market. Triggers are percentages away from the current mark; both legs close the WHOLE position at trigger time as reduce-only market orders held on chain, so a bracket can only reduce risk. Needs an existing position and no pending bracket on that market; holds 0.15 STT per leg until it fires or is cancelled (cancel_all refunds it). Only this key's own account can arm stops.",
      inputSchema: {
        market: z.string().min(1).max(16).describe("Base symbol of the market with the open position, e.g. SOL"),
        take_profit_pct: z.number().min(0.1).max(50).describe("Take-profit distance from the current mark, in percent (e.g. 3)"),
        stop_loss_pct: z.number().min(0.1).max(50).describe("Stop-loss distance from the current mark, in percent (e.g. 2)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard("bracket", async (args) => {
      const r = await bracket(d, args);
      return r.ok ? text({ network: NETWORK, ...r }) : fail({ network: NETWORK, ...r });
    }),
  );

  server.registerTool(
    "cancel_all",
    {
      title: "Cancel brackets and resting orders (real testnet transaction)",
      description:
        "Cancel this account's pending take-profit/stop-loss brackets (their STT is refunded) and any resting orders, in one market or in all of them (brackets are confirmed on chain, not only from the indexer, which lags). pilot's own orders are immediate-or-cancel and never rest, so this mostly tears down brackets. Never blocked by policy: cancelling reduces risk. Says so when there is nothing to cancel.",
      inputSchema: { market: z.string().min(1).max(16).optional().describe("Base symbol to limit the cancel to; omit for every market") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard("cancel_all", async (args) => {
      const r = await cancelAll(d, args);
      return r.ok ? text({ network: NETWORK, ...r }) : fail({ network: NETWORK, ...r });
    }),
  );

  server.registerTool(
    "policy",
    {
      title: "Show the trading policy",
      description:
        "Show the user's trading limits (max position notional per market, min liquidation distance, allowed markets, daily order cap, slippage, plan lifetime), where they come from, and how many orders were sent today. Read-only: only the user changes the policy file, never the agent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard("policy", async () => {
      const p = d.policy();
      return text({ ...p, ordersSentTodayUtc: ordersToday(d), editableBy: "the user only (edit the file; there is no tool for it)" });
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
        kind: z.enum(["plan", "refusal", "order", "close", "bracket", "cancel", "error", "note"]).optional(),
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
