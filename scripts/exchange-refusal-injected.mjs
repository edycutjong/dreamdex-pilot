// Records an EXCHANGE refusal through the MCP tools, with the race injected and said so. pilot's
// freshness guard refuses a stale plan before sending, so a real "book moved" refusal is rare
// (see exchange-refusal-via-mcp.mjs: 12 of 12 filled). Here the real server runs in-process
// behind a real MCP client, plan_order and place_order are the real tools, and ONLY the sender
// is wrapped: it lowers the limit price of the one order by 5% (what a book that ticked away
// between check and mining looks like). The transaction, the revert, the decoded reason and the
// journal row are all real. A "note" row says the race was injected, and the refusal row itself
// carries injected: true and sentLimitPrice.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/exchange-refusal-injected.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.mjs";
import { readMarkets, createChain, accountAddress } from "../src/client.mjs";
import { createJournal } from "../src/journal.mjs";
import { loadPolicy } from "../src/policy.mjs";

const real = createJournal();
// Every row written from the injected send onward (the refusal itself) is tagged, so the journal
// row says it on its own and not only a neighbouring note.
let injected = false;
let sentLimitPrice = null;
const journal = { ...real, append: (e) => real.append(injected ? { ...e, injected: true, sentLimitPrice } : e) };
const chain = createChain();
const reader = readMarkets();
const fmt = (x) => (Number(x / 10_000_000_000_000_000n) / 100).toString();
const send = (order) => {
  const price = ((order.price * 95n) / 100n / 10_000_000_000_000_000n) * 10_000_000_000_000_000n;
  injected = true;
  sentLimitPrice = fmt(price);
  real.append({ kind: "note", text: `race injected by scripts/exchange-refusal-injected.mjs: the planned limit ${fmt(order.price)} was lowered 5% to ${fmt(price)} in the sender before sending, standing in for the book moving between place_order's freshness check and mining. The order was unfillable by construction; no natural race. Everything else is the real tool path.`, plannedLimitPrice: fmt(order.price), sentLimitPrice: fmt(price) });
  return chain.send({ ...order, price });
};
const server = createServer({ client: () => reader.client, account: accountAddress, send, chain, journal, policy: () => loadPolicy() });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "injected-race-demo", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const plan = await call("plan_order", { market: "SOL", side: "long", size: "0.1" });
console.log("plan", plan.verdict, plan.plan_id);
const placed = await call("place_order", { plan_id: plan.plan_id });
console.log(JSON.stringify({ ok: placed.ok, refused_by: placed.refused_by, code: placed.code, reason: placed.reason, tx: placed.tx }, null, 1));
process.exit(placed.refused_by === "exchange" ? 0 : 1);
