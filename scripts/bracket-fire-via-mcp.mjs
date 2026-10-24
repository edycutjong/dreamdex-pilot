// A bracket that fires on chain, through the public MCP tools, no LLM in the loop: from flat, open a
// small long, arm a tight bracket (take-profit and stop-loss 0.1% from mark), then poll `account`
// until the registry has closed the position (one leg fired, its sibling cancelled with it) or the
// wait runs out (then close_position + cancel_all). Ends with cancel_all over every market, timed.
//   PILOT_PRIVATE_KEY=... PILOT_JOURNAL=... node scripts/bracket-fire-via-mcp.mjs [market] [size] [minutes]
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [market = "SOL", size = "0.1", minutes = "15"] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: "node", args: [fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url))], env: process.env, stderr: "ignore",
});
const client = new Client({ name: "bracket-fire-via-mcp", version: "0" });
await client.connect(transport);
const call = async (name, args, quiet = false) => {
  const r = await client.callTool({ name, arguments: args });
  let body = r.content[0].text;
  try {
    body = JSON.parse(body);
  } catch {
    // a plain-text error stays a string
  }
  if (!quiet) console.log(JSON.stringify({ at: new Date().toISOString(), tool: name, args, isError: !!r.isError, body }, null, 2));
  return body;
};
const mine = (xs) => (Array.isArray(xs) ? xs.filter((x) => x.market === market.toUpperCase()) : null);
try {
  const before = await call("account", {});
  if (mine(before.positions)?.length !== 0 || mine(before.pendingBrackets)?.length !== 0)
    throw new Error(`stopping: the account already holds a ${market} position or bracket (or account could not list them); this script starts from flat`);
  const plan = await call("plan_order", { market, side: "long", size });
  if (plan.verdict !== "ok") throw new Error("plan refused");
  const placed = await call("place_order", { plan_id: plan.plan_id });
  if (!placed.ok) throw new Error("order not placed");
  const armed = await call("bracket", { market, take_profit_pct: 0.1, stop_loss_pct: 0.1 });
  let fired = false;
  if (armed.ok) {
    const until = Date.now() + Number(minutes) * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10_000));
      const a = await call("account", {}, true);
      if (mine(a.positions)?.length === 0) {
        fired = true;
        console.log(JSON.stringify({ at: new Date().toISOString(), note: `the ${market} position is flat without a close from this script: a bracket leg fired` }));
        await call("account", {}); // the position and the brackets after the fire, printed
        break;
      }
    }
  }
  if (!fired) {
    console.log(JSON.stringify({ at: new Date().toISOString(), note: `no leg fired within ${minutes} minutes: closing and cancelling` }));
    await call("close_position", { market });
    await call("cancel_all", { market });
  }
  const t0 = Date.now();
  await call("cancel_all", {});
  console.log(JSON.stringify({ at: new Date().toISOString(), note: `cancel_all over every market took ${Date.now() - t0} ms` }));
} finally {
  await client.close();
}
