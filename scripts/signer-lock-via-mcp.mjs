// Two real pilot servers for one key at once (as when Claude Code and Codex CLI both run pilot),
// over stdio, no LLM in the loop: server A opens a small long, so it holds the signer lock; server B
// can still plan (reads work) but its place_order is refused with nothing sent; A closes. Prints
// each tool's JSON answer, labelled A or B.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/signer-lock-via-mcp.mjs [market] [size]
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [market = "SOL", size = "0.1"] = process.argv.slice(2);
const start = async (label) => {
  const transport = new StdioClientTransport({
    command: "node", args: [fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url))], env: process.env, stderr: "ignore",
  });
  const client = new Client({ name: `signer-lock-${label}`, version: "0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    let body = r.content[0].text;
    try {
      body = JSON.parse(body);
    } catch {
      // a plain-text error stays a string
    }
    console.log(JSON.stringify({ server: label, tool: name, args, isError: !!r.isError, body }, null, 2));
    return body;
  };
  return { call, close: () => client.close() };
};

const a = await start("A");
const b = await start("B");
try {
  const planA = await a.call("plan_order", { market, side: "long", size });
  const placedA = planA.verdict === "ok" ? await a.call("place_order", { plan_id: planA.plan_id }) : null;
  if (!placedA?.ok) process.exitCode = 1;
  const planB = await b.call("plan_order", { market, side: "long", size });
  if (planB.verdict === "ok") {
    const placedB = await b.call("place_order", { plan_id: planB.plan_id });
    if (placedB.ok || placedB.sent !== false) process.exitCode = 1; // B must not have sent
  }
  if (placedA && (placedA.ok || placedA.sent !== false)) await a.call("close_position", { market });
} finally {
  await b.close();
  await a.close();
}
