// A plan's lifetime, checked through the public MCP tools with no LLM in the loop: plan_order, wait
// past the plan's lifetime (policy planTtlSec), place_order (refused planExpired, nothing sent), then place_order
// again with the same plan_id (told what became of it). Sends no transaction.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/plan-expiry-via-mcp.mjs [market] [size]
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [market = "SOL", size = "0.1"] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: "node", args: [fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url))], env: process.env, stderr: "ignore",
});
const client = new Client({ name: "plan-expiry-via-mcp", version: "0" });
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
    console.log(`# waiting ${plan.expiresInSec + 2} s (the plan's lifetime + 2)`);
    await sleep((plan.expiresInSec + 2) * 1000);
    const late = await call("place_order", { plan_id: plan.plan_id });
    const again = await call("place_order", { plan_id: plan.plan_id });
    if (late.rule !== "planExpired" || again.ok !== false) process.exitCode = 1;
  }
} finally {
  await client.close();
}
