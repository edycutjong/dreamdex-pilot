// policy.json: the user's limits. The agent can read the policy (the `policy` tool) but no tool
// can change it; it lives outside the repo in ~/.pilot/policy.json (or $PILOT_POLICY).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const DEFAULT_POLICY = Object.freeze({
  maxNotionalUsd: 25, // per market, on the position an order leaves (orders cannot stack past it)
  minLiquidationDistancePct: 15,
  allowedMarkets: ["BTC", "ETH", "SOL"],
  dailyOrderCap: 20,
  maxSlippagePct: 1,
  planTtlSec: 60,
});

export const PolicySchema = z
  .object({
    maxNotionalUsd: z.number().positive(),
    minLiquidationDistancePct: z.number().min(0).max(100),
    allowedMarkets: z.array(z.string().min(1)).min(1),
    dailyOrderCap: z.number().int().min(0),
    maxSlippagePct: z.number().positive().max(10),
    planTtlSec: z.number().int().min(5).max(600),
  })
  .strict();

export const pilotHome = () => process.env.PILOT_HOME ?? join(homedir(), ".pilot");
export const policyPath = () => process.env.PILOT_POLICY ?? join(pilotHome(), "policy.json");

// Missing file = defaults (said so in `source`); a present but invalid file is an error, never a
// silent fallback to defaults the user did not choose.
export const loadPolicy = (path = policyPath()) => {
  if (!existsSync(path)) return { ...DEFAULT_POLICY, source: "defaults (no policy file)" };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const p = PolicySchema.parse({ ...DEFAULT_POLICY, ...raw });
  return { ...p, allowedMarkets: p.allowedMarkets.map((s) => s.toUpperCase()), source: path };
};

// Pure: facts in, violations out. Each violation names the rule and the next safe action.
// `facts.liquidationDistancePct` null = no reachable liquidation price (a tiny long on cross margin).
export const evaluate = (policy, facts) => {
  const v = [];
  if (!policy.allowedMarkets.includes(facts.market))
    v.push({ rule: "allowedMarkets", detail: `${facts.market} is not on the allowed list (${policy.allowedMarkets.join(", ")})`, next: `pick one of ${policy.allowedMarkets.join(", ")}` });
  if (facts.notionalUsd > policy.maxNotionalUsd)
    v.push({ rule: "maxNotionalUsd", detail: `the position this order leaves would be $${facts.notionalUsd.toFixed(2)} notional, above the $${policy.maxNotionalUsd} cap per market`, next: `reduce size to at most ${facts.maxSizeUnderCap ?? "the cap"}` });
  if (facts.liquidationDistancePct != null && facts.liquidationDistancePct < policy.minLiquidationDistancePct)
    v.push({ rule: "minLiquidationDistancePct", detail: `liquidation would sit ${facts.liquidationDistancePct.toFixed(2)}% from mark, closer than the ${policy.minLiquidationDistancePct}% minimum`, next: "use a smaller size (less leverage)" });
  if (facts.ordersToday >= policy.dailyOrderCap)
    v.push({ rule: "dailyOrderCap", detail: `${facts.ordersToday} orders already sent today (UTC), cap ${policy.dailyOrderCap}`, next: "wait for the next UTC day or raise the cap in policy.json yourself" });
  return v;
};
