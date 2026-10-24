// Launch bin/pilot.mjs over stdio exactly as an MCP client would, call tools/list and markets.
// Usage: node scripts/stdio-check.mjs [SYMBOL]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url));
const client = new Client({ name: "pilot-stdio-check", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: "inherit" }));
const { tools } = await client.listTools();
const r = await client.callTool({ name: "markets", arguments: process.argv[2] ? { symbol: process.argv[2] } : {} });
const body = r.isError ? r.content[0].text : JSON.parse(r.content[0].text);
console.log(JSON.stringify({ at: new Date().toISOString(), server: client.getServerVersion(), tools: tools.map((t) => t.name), markets: r.isError ? { error: body } : { count: body.count, first: body.markets[0] } }, null, 2));
await client.close();
