// P2 wiring check: send one IOC buy priced BELOW the best ask (it cannot fill), straight through
// pilot's sender, to prove an exchange refusal comes back decoded and with its mined tx hash.
// Bypasses plan_order on purpose: plan_order's freshness guard refuses such an order before it
// is sent. Testnet only; costs gas, opens nothing.
// Usage: PILOT_PRIVATE_KEY=0x... node scripts/exchange-refusal-check.mjs
import { writeFileSync } from "node:fs";
import { readMarkets, createSender, accountAddress, json } from "../src/client.mjs";
import { explainExchangeError, isExchangeRefusal } from "../src/exchange-errors.mjs";
import { GAS, IOC } from "../src/trader.mjs";

const c = readMarkets().client;
const mk = (await c.listPerpMarkets()).find((p) => p.baseSymbol === "SOL");
const t = (await c.getBookTopsOnchain([{ id: mk.id, poolAddress: mk.poolAddress }])).tops[mk.poolAddress];
const tick = BigInt(mk.tickSize);
const price = ((BigInt(t.bestAsk) * 95n) / 100n / tick) * tick; // 5% under the ask
const send = createSender();
const out = { at: new Date().toISOString(), account: accountAddress(), market: "SOL", ask: t.bestAsk, limit: price, quantity: mk.minQuantity };
try {
  const r = await send({ pool: mk.poolAddress, isBid: true, price, quantity: BigInt(mk.minQuantity), orderType: IOC, gas: GAS });
  out.unexpected = { hash: r.hash, fills: r.fills.length, orderId: r.orderId ?? null };
} catch (e) {
  out.exchangeRefusal = isExchangeRefusal(e);
  out.errorName = e.errorName ?? null;
  out.rawReason = e.reason ?? null;
  out.tx = e.txHash ?? null;
  out.explained = explainExchangeError(e);
}
const file = `evidence/p2-exchange-refusal-${out.at.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, json(out) + "\n");
console.log(json(out));
process.exit(out.exchangeRefusal && out.tx ? 0 : 1);
