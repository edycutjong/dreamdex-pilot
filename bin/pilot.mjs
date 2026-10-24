#!/usr/bin/env node
// stdio entry point: `node bin/pilot.mjs` (what `claude mcp add` and MCP Inspector launch).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.mjs";
import { readMarkets } from "../src/client.mjs";

let markets;
const client = () => (markets ??= readMarkets()).client;

const server = createServer({ client });
await server.connect(new StdioServerTransport());
// stdout is the MCP channel; logs go to stderr only.
console.error("pilot MCP server ready on stdio (Somnia Hideki testnet)");
