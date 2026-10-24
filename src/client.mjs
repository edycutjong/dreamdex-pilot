// One place that builds the SDK client. Reads need no key; writes read the key from the
// environment only (PILOT_PRIVATE_KEY), never from a file in this repo.
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { privateKeyToAccount } from "viem/accounts";

export const INDEXER_URL = process.env.PILOT_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
export const CHAIN = hidekiTestnet;

const key = () => {
  const k = process.env.PILOT_PRIVATE_KEY;
  if (!k) throw new Error("PILOT_PRIVATE_KEY is not set: writes need a testnet burner key in the environment");
  return k;
};

export const readMarkets = () =>
  new SomniaMarkets({ chain: CHAIN, indexerUrl: INDEXER_URL, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });

export const writeMarkets = (opts = {}) =>
  new SomniaMarkets({ chain: CHAIN, indexerUrl: INDEXER_URL, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey: key(), ...opts });

// The account address is derived from the key; the key itself never leaves this function.
export const accountAddress = () => process.env.PILOT_ACCOUNT ?? privateKeyToAccount(key()).address;

// JSON-safe for bigint-heavy SDK rows.
export const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

// The signed send for place_order/close_position, built on first use. The SDK's debug sink is
// the only place a REVERTED order's tx hash surfaces (the thrown ContractRevertError carries
// none), so the sender keeps it and attaches it as `txHash`: an exchange refusal still leaves
// a receipt anyone can look up.
export const createSender = (make = writeMarkets) => {
  let writer;
  let lastHash = null;
  const debug = (e) => {
    if (e.kind === "span" && e.phase === "annotate" && e.name === "trade.execute" && e.data?.hash) lastHash = e.data.hash;
  };
  return async (order) => {
    writer ??= make({ debug });
    lastHash = null;
    try {
      return await writer.trader.placePerpOrder(order);
    } catch (e) {
      e.txHash = lastHash;
      throw e;
    }
  };
};
