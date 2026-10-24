#!/bin/sh
# Regenerates evidence/p3-receipts-refetch.txt (every tx re-read from the RPC) and DEMO.md from the journals.
set -e
cd "$(dirname "$0")/.."
J="evidence/p2-mcp-run-cc-journal.jsonl evidence/p2-mcp-run-cc-2-journal.jsonl evidence/p2-mcp-run-cc-3-journal.jsonl evidence/p2-mcp-run-cc-4-journal.jsonl evidence/p3-mcp-run-cc-journal.jsonl evidence/p3-mcp-run-cc-2-journal.jsonl evidence/p3-mcp-run-codex-journal.jsonl evidence/p3-mcp-cli-client-journal.jsonl evidence/p3-exchange-refusal-injected-journal.jsonl evidence/p3-notes-journal.jsonl"
node scripts/refetch.mjs $J > evidence/p3-receipts-refetch.txt
node bin/pilot.mjs journal --md --journal "$(echo $J | tr ' ' ',')" --receipts evidence/p3-receipts-refetch.txt --out DEMO.md
