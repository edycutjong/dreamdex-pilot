#!/usr/bin/env node
// stdio entry point: `node bin/pilot.mjs` (what `claude mcp add` and MCP Inspector launch).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.mjs";
import { readMarkets, writeMarkets, accountAddress } from "../src/client.mjs";
import { createJournal } from "../src/journal.mjs";
import { loadPolicy } from "../src/policy.mjs";

// Reads need no key. The signing client is built on first write only, so markets/plan work
// with PILOT_ACCOUNT alone.
let reader, writer, lastHash = null;
const client = () => (reader ??= readMarkets()).client;
// The SDK's debug sink is the only place a REVERTED order's tx hash surfaces (the thrown
// ContractRevertError carries none); keep it so exchange refusals still leave a receipt.
const debug = (e) => {
  if (e.kind === "span" && e.phase === "annotate" && e.name === "trade.execute" && e.data?.hash) lastHash = e.data.hash;
};
const send = async (order) => {
  writer ??= writeMarkets({ debug });
  lastHash = null;
  try {
    const r = await writer.trader.placePerpOrder(order);
    return r;
  } catch (e) {
    e.txHash = lastHash;
    throw e;
  }
};

const server = createServer({ client, account: accountAddress, send, journal: createJournal(), policy: () => loadPolicy() });
await server.connect(new StdioServerTransport());
// stdout is the MCP channel; logs go to stderr only.
console.error("pilot MCP server ready on stdio (Somnia Hideki testnet)");
