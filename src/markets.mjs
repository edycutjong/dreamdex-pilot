// `markets` tool: the perp market list in human units. Pure formatting lives here so it can be
// tested without the chain; the SDK call is injected.
import { formatUnits } from "viem";

const fraction = (x) => Number(formatUnits(BigInt(x), 18));
// Prices are in the market's quote decimals, like tickSize below and trader.mjs units().
const price = (x, p) => Number(formatUnits(BigInt(x), p.quoteDecimals ?? 18));

export const formatMarket = (p) => ({
  symbol: p.baseSymbol,
  pool: p.poolAddress,
  marginBank: p.marginBank,
  markPrice: price(p.markPrice, p),
  indexPrice: price(p.indexPrice, p),
  lastPrice: price(p.lastPrice, p),
  // initialMarginBps 500 = 5% initial margin = 20x max leverage.
  maxLeverage: p.initialMarginBps > 0 ? 10_000 / p.initialMarginBps : null,
  minQuantity: formatUnits(BigInt(p.minQuantity), p.baseDecimals),
  lotSize: formatUnits(BigInt(p.lotSize), p.baseDecimals),
  tickSize: formatUnits(BigInt(p.tickSize), p.quoteDecimals),
  // fundingRate is per funding window (fundingWindowSec, 8 h) as an 18-decimal fraction.
  fundingRatePerWindowPct: fraction(p.fundingRate) * 100,
  fundingWindowHours: p.fundingWindowSec / 3600,
  openInterest: formatUnits(BigInt(p.openInterest), p.baseDecimals),
});

export const listMarkets = async (client, { symbol } = {}) => {
  const rows = (await client.listPerpMarkets()).map(formatMarket);
  const want = symbol?.toUpperCase();
  const out = want ? rows.filter((r) => r.symbol === want) : rows;
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
};
