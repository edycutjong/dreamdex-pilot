// P1 spike: the whole write path once, by hand, before any MCP code.
// list markets -> plan (max size, margin preview, liquidation preview) -> place a tiny IOC buy
// -> read it back -> close with an IOC sell -> read back flat. Testnet only.
// Usage: PILOT_PRIVATE_KEY=0x... [MARKET=SOL] node scripts/spike.mjs
import { writeFileSync } from "node:fs";
import { formatUnits, createPublicClient, http } from "viem";
import { writeMarkets, accountAddress, json, CHAIN } from "../src/client.mjs";

const SYMBOL = process.env.MARKET ?? "SOL";
// Report 009 (sieve): successful IOC orders used up to 13.4M gas, above the documented ~1.56M.
const GAS = 20_000_000n;
const IOC = 2;

const m = writeMarkets();
const account = accountAddress();
const rpc = createPublicClient({ chain: CHAIN, transport: http() });
const fmt = (x) => (x == null ? null : formatUnits(x, 18)); // prices + USDso: 18 decimals
const t0 = Date.now();

const all = await m.client.listPerpMarkets();
const mk = all.find((p) => p.baseSymbol === SYMBOL);
if (!mk) throw new Error(`no ${SYMBOL} market`);
const ref = { pool: mk.poolAddress, marginBank: mk.marginBank, account };
const touch = async () => {
  const t = (await m.client.getBookTopsOnchain([{ id: mk.id, poolAddress: mk.poolAddress }])).tops[mk.poolAddress];
  return { bid: BigInt(t.bestBid), ask: BigInt(t.bestAsk) };
};
const tick = BigInt(mk.tickSize);
const qty = (x) => (x == null ? null : formatUnits(x, mk.baseDecimals)); // sizes: base decimals (SOL: 9)
const quantity = BigInt(mk.minQuantity);

// --- plan ---
let t = await touch();
const buyPrice = ((t.ask * 101n) / 100n / tick) * tick;
const [max, margin, liq] = await Promise.all([
  m.client.getMaxPerpOrderSize({ ...ref, isBid: true, price: buyPrice }),
  m.client.previewPerpOrderMargin({ ...ref, isBid: true, quantity, price: buyPrice }),
  m.client.previewPerpLiquidationPrice({ ...ref, isBid: true, quantity, price: buyPrice }),
]);
const plan = {
  market: SYMBOL, pool: mk.poolAddress, side: "buy", quantity: qty(quantity), limitPrice: fmt(buyPrice), touch: { bid: fmt(t.bid), ask: fmt(t.ask) },
  max: max.priceable ? { maxQuantity: qty(max.maxQuantity), limitedBy: max.limitedBy, placeable: max.placeable } : { priceable: false },
  margin: margin.priceable ? { lockAmount: fmt(margin.lockAmount), meetsInitialMargin: margin.meetsInitialMargin, hasCollateralForLock: margin.hasCollateralForLock, voucherBlocked: margin.voucherBlocked, markPrice: fmt(margin.markPrice) } : { priceable: false },
  liquidation: liq.priceable ? { projectedLiquidationPrice: fmt(liq.projectedLiquidationPrice), projectedEntryPrice: fmt(liq.projectedEntryPrice), markPrice: fmt(liq.markPrice), fee: fmt(liq.fee) } : { priceable: false },
};
if (!max.priceable || !max.placeable || max.maxQuantity < quantity) throw new Error(`not placeable: ${json(plan.max)}`);

// --- place ---
const open = await m.trader.placePerpOrder({ pool: mk.poolAddress, isBid: true, price: buyPrice, quantity, orderType: IOC, gas: GAS });
const openFilled = open.fills.reduce((s, f) => s + BigInt(f.quantityFilled), 0n);
// Report 016 (sieve): margin/equity reads can lag the caller's own receipt; getPerpPosition reads at latest.
const posAfterOpen = await m.client.getPerpPosition(ref);
const openRefetch = await rpc.getTransactionReceipt({ hash: open.hash });

// --- close ---
t = await touch();
const sellPrice = ((t.bid * 99n) / 100n / tick) * tick;
const close = await m.trader.placePerpOrder({ pool: mk.poolAddress, isBid: false, price: sellPrice, quantity: openFilled, orderType: IOC, gas: GAS });
const posAfterClose = await m.client.getPerpPosition(ref);
const closeRefetch = await rpc.getTransactionReceipt({ hash: close.hash });

const out = {
  at: new Date().toISOString(), sdk: "0.32.1", chainId: CHAIN.id, account, plan,
  open: { hash: open.hash, block: Number(open.receipt.blockNumber), status: openRefetch.status, gasUsed: openRefetch.gasUsed, orderId: open.orderId ?? null, filled: qty(openFilled), positionAfter: qty(posAfterOpen.size) },
  close: { hash: close.hash, block: Number(close.receipt.blockNumber), status: closeRefetch.status, gasUsed: closeRefetch.gasUsed, orderId: close.orderId ?? null, filled: qty(close.fills.reduce((s, f) => s + BigInt(f.quantityFilled), 0n)), limitPrice: fmt(sellPrice), positionAfter: qty(posAfterClose.size) },
  ms: Date.now() - t0,
};
const file = `evidence/spike-${out.at.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, json(out) + "\n");
console.log(json(out));
console.error(`wrote ${file}`);
process.exit(0);
