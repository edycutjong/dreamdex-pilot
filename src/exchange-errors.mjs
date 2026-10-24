// The exchange's own refusals, in plain words. A singular placeOrder REVERTS on these and the
// SDK decodes the custom error (ContractRevertError.errorName). listPerpOrderRejections only
// carries rows for BATCH placements (SDK perp/history.d.ts: "a singular placement leaves no row
// here"), so for pilot's one-order sends the decoded revert is the source.
const PLAIN = {
  ImmediateOrCancelNoFill: ["the IOC order found nothing to fill at its limit price, so the exchange refused it; no position was opened", "plan again: a fresh plan prices from the current touch"],
  FillOrKillNotFillable: ["the fill-or-kill order could not fill completely, so the exchange refused it", "plan a smaller size"],
  InsufficientMargin: ["the margin account does not have enough collateral for this order", "plan a smaller size or deposit USDso"],
  InsufficientMarginForOrder: ["the margin account does not have enough collateral for this order", "plan a smaller size or deposit USDso"],
  InsufficientMarginAtCreation: ["the order would leave the account below initial margin", "plan a smaller size"],
  MaxPositionSizeExceeded: ["the order would push this account's position above the market's per-account cap", "plan a smaller size; markets shows the limits"],
  OpenInterestCapExceeded: ["the market's open-interest cap is full on this side", "try another market or a smaller size"],
  VoucherMarketNotAllowed: ["voucher (paper USDso) margin cannot trade this market", "pick a market the voucher allows"],
  VoucherAccountLeverageLocked: ["a voucher-funded account is capped at a lower leverage on this market", "plan a smaller size"],
  PriceNotAlignedToTickSize: ["the limit price is not on the market's tick grid", "plan again (pilot rounds to the tick)"],
  QuantityNotAlignedToLotSize: ["the size is not a multiple of the market's lot size", "plan again (pilot rounds to the lot)"],
  QuantityBelowMinimum: ["the size is below the market's minimum", "plan at least the minimum size"],
  FillPriceOutsideBand: ["the fill price fell outside the exchange's price band", "plan again when the market is calmer"],
  CircuitBreakerTriggered: ["the market's circuit breaker is tripped", "wait and plan again later"],
  MarkPriceUnavailable: ["the market has no usable mark price right now", "wait and plan again later"],
  OraclePriceStale: ["the oracle price is stale, so the exchange refuses new risk", "wait and plan again later"],
  StalePrice: ["the price feed is stale, so the exchange refuses new risk", "wait and plan again later"],
  MarketRestricted: ["the market is restricted (reduce-only or winding down)", "pick another market"],
  TooManyRestingOrders: ["this account has too many resting orders on the market", "cancel some orders first"],
  GasLimitExceeded: ["the transaction ran out of the gas pilot gave it", "plan again; report it if it repeats"],
};

// Report 015 (sieve): the SDK can report its own failed eth_call replay as the revert reason.
const REPLAY_FAILED = /rpc eth_call failed|RPC Request failed/i;

export const explainExchangeError = (e) => {
  const name = e?.errorName;
  if (name && PLAIN[name]) return { code: name, reason: PLAIN[name][0], next: PLAIN[name][1] };
  if (name) return { code: name, reason: `the exchange refused the order with ${name}`, next: "plan again; check markets and your margin" };
  if (typeof e?.reason === "string" && REPLAY_FAILED.test(e.reason))
    return { code: "unknown", reason: "the transaction reverted, but the SDK's replay to read the reason failed, so the exchange's reason is unknown (SDK reports its replay failure as the reason, sieve report 015)", next: "check the tx on the explorer; plan again" };
  if (typeof e?.reason === "string" && e.reason) return { code: "unknown", reason: `the exchange reverted the order: ${e.reason}`, next: "plan again; check markets and your margin" };
  return { code: "unknown", reason: "the transaction reverted with no readable reason", next: "check the tx on the explorer; plan again" };
};

// A ContractRevertError is the exchange saying no; anything else (RPC down, timeout) is not a refusal.
export const isExchangeRefusal = (e) => e?.name === "ContractRevertError" || e?.constructor?.name === "ContractRevertError";

// Report 004 (sieve): the real network cause can sit only on error.cause.
export const describeError = (e) => {
  const head = `${e?.name ?? "Error"}: ${e?.shortMessage ?? e?.message ?? e}`;
  const cause = e?.cause?.message ? ` (cause: ${e.cause.message})` : "";
  return head + cause;
};
