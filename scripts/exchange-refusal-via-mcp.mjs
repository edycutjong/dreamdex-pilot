// Tries to provoke a REAL exchange refusal through the public MCP tools only: a policy with a
// 0.01% (1 bp) slippage bound (the smallest that leaves any room above the touch) leaves almost
// no room, so if the book ticks away between place_order's freshness check and mining, the IOC finds nothing to fill and the
// exchange reverts it. Nothing is faked: every attempt is plan_order -> place_order over stdio
// to the real server; a filled attempt is closed again. Stops at the first exchange refusal.
// Result 2026-10-24 (SOL, 12 attempts): all 12 filled and none was refused, so no natural exchange refusal occurred (evidence/p3-tight-slippage-attempts-journal.jsonl).
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/exchange-refusal-via-mcp.mjs [market] [attempts]
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [market = "SOL", attempts = "12"] = process.argv.slice(2);
const policy = join(tmpdir(), "pilot-tight-policy.json");
writeFileSync(policy, JSON.stringify({ maxSlippagePct: 0.01 }));
const transport = new StdioClientTransport({
  command: "node", args: [new URL("../bin/pilot.mjs", import.meta.url).pathname],
  env: { ...process.env, PILOT_POLICY: policy }, stderr: "ignore",
});
const client = new Client({ name: "exchange-refusal-probe", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};
let outcome = "no exchange refusal in the attempts made";
for (let i = 1; i <= Number(attempts); i++) {
  const plan = await call("plan_order", { market, side: "long", size: "0.1" });
  if (plan.body.verdict !== "ok") { console.log(i, "plan refused", plan.body.refusals?.map((r) => r.rule)); continue; }
  const placed = await call("place_order", { plan_id: plan.body.plan_id });
  console.log(i, placed.body.ok ? `filled ${placed.body.filled} tx ${placed.body.tx}` : `${placed.body.refused_by ?? "error"}: ${placed.body.code ?? placed.body.rule ?? placed.body.error} ${placed.body.tx ?? ""}`);
  if (placed.body.ok) {
    const closed = await call("close_position", { market });
    console.log(i, "closed", closed.body.ok ? closed.body.tx : JSON.stringify(closed.body).slice(0, 200));
  } else if (placed.body.refused_by === "exchange") {
    outcome = `exchange refusal on attempt ${i}: ${placed.body.code}`;
    break;
  }
}
console.log(outcome);
await client.close();
process.exit(0);
