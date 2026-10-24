#!/usr/bin/env node
// stdio entry point: `node bin/pilot.mjs` (what `claude mcp add` and MCP Inspector launch).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.mjs";
import { readMarkets, createSender, accountAddress } from "../src/client.mjs";
import { createJournal } from "../src/journal.mjs";
import { loadPolicy } from "../src/policy.mjs";

// Reads need no key; the signing client is built on the first write only.
let reader;
const client = () => (reader ??= readMarkets()).client;

const server = createServer({ client, account: accountAddress, send: createSender(), journal: createJournal(), policy: () => loadPolicy() });
await server.connect(new StdioServerTransport());
// stdout is the MCP channel; logs go to stderr only.
console.error("pilot MCP server ready on stdio (Somnia Hideki testnet)");
