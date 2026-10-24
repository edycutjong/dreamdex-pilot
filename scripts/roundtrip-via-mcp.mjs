// One real round trip through the public MCP tools, no LLM in the loop: plan_order -> place_order
// -> close_position over stdio to the real server, printing each tool's JSON answer. Use it to
// check a change to the send path on testnet (with your own burner key and journal). With
// --bracket it also arms a bracket before the close (close_position then reports it still armed)
// and removes it with cancel_all afterwards.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/roundtrip-via-mcp.mjs [market] [size] [--bracket]
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const withBracket = args.includes("--bracket");
const [market = "SOL", size = "0.1"] = args.filter((a) => a !== "--bracket");
const transport = new StdioClientTransport({
  command: "node", args: [fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url))], env: process.env, stderr: "ignore",
});
const client = new Client({ name: "roundtrip-via-mcp", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  console.log(JSON.stringify({ tool: name, args, isError: !!r.isError, body }, null, 2));
  return body;
};
try {
  const plan = await call("plan_order", { market, side: "long", size });
  if (plan.verdict !== "ok") process.exitCode = 1;
  else {
    const placed = await call("place_order", { plan_id: plan.plan_id });
    if (!placed.ok) process.exitCode = 1;
    if (placed.ok && withBracket) await call("bracket", { market, take_profit_pct: 3, stop_loss_pct: 2 });
    if (placed.ok || placed.sent !== false) await call("close_position", { market });
    if (withBracket) await call("cancel_all", { market });
  }
} finally {
  await client.close();
}
