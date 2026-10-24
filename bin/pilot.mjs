#!/usr/bin/env node
// stdio entry point: `node bin/pilot.mjs` (what `claude mcp add` and MCP Inspector launch).
// `node bin/pilot.mjs journal --md [--journal a.jsonl,b.jsonl] [--receipts file] [--out DEMO.md]`
// renders the journal(s) as DEMO.md instead of starting the server.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.mjs";
import { readMarkets, createChain, accountAddress, CHAIN } from "../src/client.mjs";
import { createJournal } from "../src/journal.mjs";
import { loadPolicy } from "../src/policy.mjs";
import { renderDemo, parseReceipts } from "../src/demo.mjs";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "journal") {
  const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  if (!rest.includes("--md")) {
    console.error("usage: pilot journal --md [--journal a.jsonl,b.jsonl] [--receipts refetch.txt] [--out DEMO.md]");
    process.exit(2);
  }
  const files = (opt("--journal") ?? createJournal().path).split(",");
  const entries = files.flatMap((f) => createJournal(f).read());
  const receipts = opt("--receipts") ? parseReceipts(readFileSync(opt("--receipts"), "utf8")) : new Map();
  const md = renderDemo(entries, { receipts, sources: files.map((f) => f.split("/").pop()) });
  if (opt("--out")) writeFileSync(opt("--out"), md);
  else process.stdout.write(md);
  process.exit(0);
}

// Reads need no key; the signing client is built on the first write only.
let reader;
const client = () => (reader ??= readMarkets()).client;
const chain = createChain();
const rpc = createPublicClient({ chain: CHAIN, transport: http() });

const server = createServer({
  client, account: accountAddress, send: chain.send, chain, native: () => rpc.getBalance({ address: accountAddress() }),
  journal: createJournal(), policy: () => loadPolicy(),
});
await server.connect(new StdioServerTransport());
// stdout is the MCP channel; logs go to stderr only.
console.error("pilot MCP server ready on stdio (Somnia Hideki testnet)");
