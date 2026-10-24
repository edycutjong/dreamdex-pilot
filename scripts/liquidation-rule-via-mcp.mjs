// The liquidation-distance rule, checked through the public MCP tools with no LLM in the loop. Under
// the default policy the $25 cap keeps every order far below 1x leverage, where the exchange reports
// no reachable liquidation price, so this run uses a policy file that raises maxNotionalUsd to $1000
// (every other limit stays default, including minLiquidationDistancePct 15) and plans growing SOL
// longs until one is refused on liquidation distance. Plans only: no place_order, nothing is sent.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/liquidation-rule-via-mcp.mjs
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const policyFile = join(mkdtempSync(join(tmpdir(), "pilot-liq-")), "policy.json");
writeFileSync(policyFile, JSON.stringify({ maxNotionalUsd: 1000 }));
const transport = new StdioClientTransport({
  command: "node", args: [fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url))],
  env: { ...process.env, PILOT_POLICY: policyFile }, stderr: "ignore",
});
const client = new Client({ name: "liquidation-rule-via-mcp", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  console.log(JSON.stringify({ tool: name, args, isError: !!r.isError, body }, null, 2));
  return body;
};
try {
  await call("policy", {});
  let priced = false, refused = false;
  for (const size of ["1", "2", "3", "4", "5", "6", "7"]) {
    const plan = await call("plan_order", { market: "SOL", side: "long", size });
    if (plan.verdict === "ok" && plan.liquidationPrice != null) priced = true;
    if (plan.refusals?.some((r) => r.rule === "minLiquidationDistancePct")) { refused = true; break; }
  }
  if (!priced || !refused) process.exitCode = 1;
} finally {
  await client.close();
}
