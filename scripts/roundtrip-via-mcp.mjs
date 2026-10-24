// One real round trip through the public MCP tools, no LLM in the loop: plan_order -> place_order
// -> close_position over stdio to the real server, printing each tool's JSON answer. Use it to
// check a change to the send path on testnet (with your own burner key and journal). With
// --bracket it also arms a bracket before the close (close_position then reports it still armed)
// and removes it with cancel_all afterwards. With --bad-policy-close it opens under a valid policy
// file (a temp one, defaults) and makes that file invalid just before the close: close_position
// must still close, and say so in policyUnreadable. --short opens a short instead of a long.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/roundtrip-via-mcp.mjs [market] [size] [--short] [--bracket] [--bad-policy-close]
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const withBracket = args.includes("--bracket");
const badPolicyClose = args.includes("--bad-policy-close");
const side = args.includes("--short") ? "short" : "long";
const [market = "SOL", size = "0.1"] = args.filter((a) => !a.startsWith("--"));
const policyFile = badPolicyClose ? join(mkdtempSync(join(tmpdir(), "pilot-policy-")), "policy.json") : null;
if (policyFile) writeFileSync(policyFile, "{}\n"); // valid: every key at its default
const transport = new StdioClientTransport({
  command: "node", args: [fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url))], env: { ...process.env, ...(policyFile ? { PILOT_POLICY: policyFile } : {}) }, stderr: "ignore",
});
const client = new Client({ name: "roundtrip-via-mcp", version: "0" });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  let body = r.content[0].text;
  try {
    body = JSON.parse(body);
  } catch {
    // a plain-text error (e.g. an invalid policy file) stays a string
  }
  console.log(JSON.stringify({ tool: name, args, isError: !!r.isError, body }, null, 2));
  return body;
};
try {
  const plan = await call("plan_order", { market, side, size });
  if (plan.verdict !== "ok") process.exitCode = 1;
  else {
    const placed = await call("place_order", { plan_id: plan.plan_id });
    if (!placed.ok) process.exitCode = 1;
    if (placed.ok && withBracket) await call("bracket", { market, take_profit_pct: 3, stop_loss_pct: 2 });
    if (policyFile) {
      writeFileSync(policyFile, JSON.stringify({ maxSlippagePct: 50 }) + "\n"); // above the schema's 10: invalid
      await call("policy", {}); // shows the error every opening tool now returns
    }
    if (placed.ok || placed.sent !== false) await call("close_position", { market });
    if (withBracket) await call("cancel_all", { market });
  }
} finally {
  await client.close();
}
