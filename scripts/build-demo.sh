#!/bin/sh
# Re-reads every tx in the journals below from the RPC into evidence/p3-receipts-refetch.txt, then renders DEMO.md from them.
set -e
cd "$(dirname "$0")/.."
J="evidence/p2-mcp-run-cc-journal.jsonl evidence/p2-mcp-run-cc-2-journal.jsonl evidence/p2-mcp-run-cc-3-journal.jsonl evidence/p2-mcp-run-cc-4-journal.jsonl evidence/p3-mcp-run-cc-journal.jsonl evidence/p3-mcp-run-cc-2-journal.jsonl evidence/p3-mcp-run-codex-journal.jsonl evidence/p3-mcp-cli-client-journal.jsonl evidence/p3-exchange-refusal-injected-journal.jsonl evidence/p3-notes-journal.jsonl evidence/p6-stacking-refusal-cc-journal.jsonl evidence/p6-plan-expired-journal.jsonl evidence/p6-liquidation-rule-journal.jsonl"
node scripts/refetch.mjs $J > evidence/p3-receipts-refetch.txt
node bin/pilot.mjs journal --md --journal "$(echo $J | tr ' ' ',')" --receipts evidence/p3-receipts-refetch.txt --legend "cc = Claude Code (Anthropic); codex = Codex CLI (OpenAI, not Anthropic); mcp-cli-client = MCP Inspector CLI (read-only, no signing key); injected = in-process MCP client with the race injected; the tight-slippage attempts in the Notes = a scripted MCP stdio client (no LLM), counted in the Notes only; plan-expired = a scripted MCP stdio client (no LLM) that waits out a plan; liquidation-rule = a scripted MCP stdio client (no LLM), plans only, under a policy file with maxNotionalUsd 1000 (see Notes)" --out DEMO.md
