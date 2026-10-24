// Live testnet check, off by default: PILOT_INTEGRATION=1 npx vitest run test/integration.test.mjs
// Spawns the real server over stdio against Somnia Hideki and calls the read-only tools plus plan_order
// (which sends nothing). Needs no key: PILOT_ACCOUNT is a public address. Real orders are exercised by
// the recorded MCP client runs in evidence/, not by CI.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const live = process.env.PILOT_INTEGRATION === "1";
const ACCOUNT = process.env.PILOT_ACCOUNT ?? "0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b";

describe.skipIf(!live)("live testnet over stdio", () => {
  const connect = async () => {
    const env = { ...process.env, PILOT_ACCOUNT: ACCOUNT, PILOT_JOURNAL: join(mkdtempSync(join(tmpdir(), "pilot-it-")), "journal.jsonl") };
    delete env.PILOT_PRIVATE_KEY;
    const c = new Client({ name: "integration", version: "0" });
    await c.connect(new StdioClientTransport({ command: "node", args: [new URL("../bin/pilot.mjs", import.meta.url).pathname], env, stderr: "ignore" }));
    return c;
  };
  const call = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

  it("lists the nine tools and answers markets, account and a plan without sending anything", async () => {
    const c = await connect();
    try {
      expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["account", "bracket", "cancel_all", "close_position", "journal", "markets", "place_order", "plan_order", "policy"]);
      const m = await call(c, "markets", { symbol: "SOL" });
      expect(m.markets[0]).toMatchObject({ symbol: "SOL" });
      expect(m.markets[0].markPrice).toBeGreaterThan(0);
      const a = await call(c, "account");
      expect(a.account.toLowerCase()).toBe(ACCOUNT.toLowerCase());
      expect(typeof a.collateralUsdso.equity).toBe("number");
      const p = await call(c, "plan_order", { market: "SOL", side: "long", size: "0.1" });
      expect(["ok", "refused"]).toContain(p.verdict);
      if (p.verdict === "ok") expect(p.plan_id).toMatch(/^plan_[0-9a-f]{12}$/);
      const refused = await call(c, "plan_order", { market: "DOGE", side: "long", size: "200" });
      expect(refused.refusals.map((r) => r.rule)).toContain("allowedMarkets");
    } finally {
      await c.close();
    }
  }, 60_000);
});
