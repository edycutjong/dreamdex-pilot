#!/bin/sh
# Regenerates evidence/p3-receipts-refetch.txt (every tx re-read from the RPC) and DEMO.md from the journals.
set -e
cd "$(dirname "$0")/.."
J="evidence/p2-mcp-run-cc-journal.jsonl evidence/p2-mcp-run-cc-2-journal.jsonl evidence/p2-mcp-run-cc-3-journal.jsonl evidence/p2-mcp-run-cc-4-journal.jsonl evidence/p3-mcp-run-cc-journal.jsonl evidence/p3-mcp-run-cc-2-journal.jsonl evidence/p3-mcp-run-codex-journal.jsonl evidence/p3-mcp-cli-client-journal.jsonl evidence/p3-exchange-refusal-injected-journal.jsonl evidence/p3-notes-journal.jsonl"
node scripts/refetch.mjs $J > evidence/p3-receipts-refetch.txt
node bin/pilot.mjs journal --md --journal "$(echo $J | tr ' ' ',')" --receipts evidence/p3-receipts-refetch.txt --legend "cc = Claude Code (Anthropic); codex = Codex CLI (OpenAI, not Anthropic); mcp-cli-client = MCP Inspector CLI (read-only, no signing key); injected = in-process MCP client with the race injected; the tight-slippage attempts in the Notes = a scripted MCP stdio client (no LLM), counted in the Notes only" --out DEMO.md
