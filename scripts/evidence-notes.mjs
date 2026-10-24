// Writes evidence/p3-notes-journal.jsonl: note rows for DEMO.md whose numbers are COUNTED from
// the evidence files, not typed: the tight-slippage attempts (all through the MCP tools), the
// earlier harness refusal (a direct SDK call, outside the tools), and the cap refusal whose next
// step was below the market minimum, before and after the fix.
import { readFileSync, writeFileSync } from "node:fs";

const rows = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const t = rows("evidence/p3-tight-slippage-attempts-journal.jsonl");
const n = (k) => t.filter((e) => e.kind === k).length;
const exch = t.filter((e) => e.refused_by === "exchange").length;
const h = JSON.parse(readFileSync("evidence/p2-exchange-refusal-2026-10-24T02-18-19-265Z.json", "utf8"));
const out = [
  { at: t.at(-1).at, kind: "note", text: `Attempt to provoke a natural exchange refusal through the tools: with a 0.01% (1 bp) slippage bound, the smallest that leaves any room above the touch, scripts/exchange-refusal-via-mcp.mjs made ${n("plan")} plan_order and ${n("order")} place_order calls on SOL over stdio MCP; ${n("order")} orders filled (each closed again: ${n("close")} closes) and ${exch} were refused by the exchange. No natural exchange refusal is recorded (evidence/p3-tight-slippage-attempts-journal.jsonl).` },
  { at: h.at, kind: "note", tx: h.tx, text: `Earlier exchange refusal, outside the tools: scripts/exchange-refusal-check.mjs sent one IOC buy 5% under the ask straight through pilot's sender (limit ${Number(BigInt(h.limit) / 10n ** 16n) / 100}, ask ${Number(BigInt(h.ask) / 10n ** 16n) / 100}); the exchange reverted it as ${h.errorName}, tx ${h.tx} (evidence/p2-exchange-refusal-2026-10-24T02-18-19-265Z.json).` },
];
const cap = (f) => rows(f).filter((e) => e.kind === "refusal" && e.rules?.includes("maxNotionalUsd"));
const [before] = cap("evidence/p3-mcp-run-cc-journal.jsonl");
const tried = rows("evidence/p3-mcp-run-cc-journal.jsonl").find((e) => e.kind === "refusal" && e.at > before.at && e.rules?.includes("minQuantity"));
const [after] = cap("evidence/p6-stacking-refusal-cc-journal.jsonl");
out.push({ at: after.at, kind: "note", text: `A wrong next step, fixed: the ${before.at} cap refusal (${before.size} ${before.market} on top of ${before.positionNow} held) answered "${before.refusals[0].next}", a size under the ${before.market} minimum, and the agent's plan for ${tried.size} ${tried.market} was then refused on minQuantity ("${tried.refusals[0].next}"). plan_order now checks the room against the minimum; the same request on the fixed code (${after.at}, ${after.positionNow} ${after.market} held) answered "${after.refusals[0].next}", and the agent planned nothing.` });
const liq = rows("evidence/p6-liquidation-rule-journal.jsonl");
const okPlans = liq.filter((e) => e.kind === "plan" && e.liquidationPrice != null);
const liqRefused = liq.find((e) => e.kind === "refusal" && e.rules?.includes("minLiquidationDistancePct"));
out.push({ at: liqRefused.at, kind: "note", text: `The liquidation rule did not bind in the runs above: at the default $25 cap this account (about 49.5 USDso) stays under 1x leverage, where the exchange reports no reachable liquidation price for a long. scripts/liquidation-rule-via-mcp.mjs planned SOL longs under a policy file that raises maxNotionalUsd to $1000, every other limit default (minLiquidationDistancePct 15). ${okPlans.map((e) => `${e.size} SOL (${e.projectedLeverageX}x) planned ok, liquidation ${Number(e.liquidationPrice).toFixed(2)}, ${e.liquidationDistancePct}% from mark`).join("; ")}; ${liqRefused.size} SOL (${liqRefused.projectedLeverageX}x) refused: ${liqRefused.refusals[0].detail}. Plans only, nothing was sent.` });
writeFileSync("evidence/p3-notes-journal.jsonl", out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(out.map((r) => r.text).join("\n"));
