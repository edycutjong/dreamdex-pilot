// Writes evidence/p3-notes-journal.jsonl: two note rows for DEMO.md whose numbers are COUNTED from
// the evidence files, not typed: the tight-slippage attempts (all through the MCP tools) and the
// P2 harness refusal (a direct SDK call, outside the tools).
import { readFileSync, writeFileSync } from "node:fs";

const rows = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const t = rows("evidence/p3-tight-slippage-attempts-journal.jsonl");
const n = (k) => t.filter((e) => e.kind === k).length;
const exch = t.filter((e) => e.refused_by === "exchange").length;
const h = JSON.parse(readFileSync("evidence/p2-exchange-refusal-2026-10-24T02-18-19-265Z.json", "utf8"));
const out = [
  { at: t.at(-1).at, kind: "note", text: `Natural exchange refusals through the tools: with the tightest slippage pilot allows (0.01%), scripts/exchange-refusal-via-mcp.mjs made ${n("plan")} plan_order and ${n("order")} place_order calls on SOL over stdio MCP; ${n("order")} orders filled (each closed again: ${n("close")} closes) and ${exch} were refused by the exchange. No natural exchange refusal is recorded (evidence/p3-tight-slippage-attempts-journal.jsonl).` },
  { at: h.at, kind: "note", tx: h.tx, text: `Earlier exchange refusal, outside the tools: scripts/exchange-refusal-check.mjs sent one IOC buy 5% under the ask straight through pilot's sender (limit ${Number(BigInt(h.limit) / 10n ** 16n) / 100}, ask ${Number(BigInt(h.ask) / 10n ** 16n) / 100}); the exchange reverted it as ${h.errorName}, tx ${h.tx} (evidence/p2-exchange-refusal-2026-10-24T02-18-19-265Z.json).` },
];
writeFileSync("evidence/p3-notes-journal.jsonl", out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(out.map((r) => r.text).join("\n"));
