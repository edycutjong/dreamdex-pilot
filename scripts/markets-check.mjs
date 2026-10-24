// Read-only: every Hideki perp market's margin bank and stop registry (account assumes one shared margin bank;
// liveStops assumes one stop registry per market).
//   node scripts/markets-check.mjs > evidence/p8-r05-markets-check.txt
import { readMarkets } from "../src/client.mjs";
const mk = await readMarkets().client.listPerpMarkets();
const banks = new Set(mk.map((m) => String(m.marginBank).toLowerCase()));
const regs = new Set(mk.map((m) => String(m.stopRegistry).toLowerCase()));
console.log(JSON.stringify({ at: new Date().toISOString(), source: "client.listPerpMarkets() on Somnia Hideki testnet (read-only)", markets: mk.length, distinctMarginBanks: banks.size, marginBanks: [...banks], distinctStopRegistries: regs.size, rows: mk.map((m) => ({ market: m.baseSymbol, marginBank: m.marginBank, stopRegistry: m.stopRegistry })) }, null, 1));
process.exit(0);
