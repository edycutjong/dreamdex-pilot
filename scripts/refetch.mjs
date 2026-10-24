// Re-fetch every transaction named in one or more pilot journals from the RPC and print
// "hash status block from gasUsed" (the format src/demo.mjs reads back as receipts).
//   node scripts/refetch.mjs journal.jsonl [more.jsonl ...] > evidence/receipts-refetch.txt
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { CHAIN } from "../src/client.mjs";

const hashes = new Set();
for (const f of process.argv.slice(2)) {
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const e = JSON.parse(l);
    for (const h of [e.tx, ...(e.txs ?? []).map((t) => t.tx), ...(e.operatorGrantTxs ?? []), ...(e.txsSeen ?? [])]) if (/^0x[0-9a-f]{64}$/.test(h ?? "")) hashes.add(h);
  }
}
const pc = createPublicClient({ chain: CHAIN, transport: http() });
let bad = 0;
for (const hash of hashes) {
  try {
    const r = await pc.getTransactionReceipt({ hash });
    console.log(hash, r.status, r.blockNumber.toString(), r.from, r.gasUsed.toString());
  } catch (e) {
    bad++;
    console.log(hash, "NOT-FOUND", "-", "-", "-");
  }
}
console.error(`${hashes.size} tx, ${bad} not found`);
process.exit(bad ? 1 : 0);
