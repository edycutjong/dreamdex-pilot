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

// Reads may be pointed at any address with PILOT_ACCOUNT, but the key signs for its own account:
// a different PILOT_ACCOUNT would make pilot read one account and trade another.
export const assertAccountMatchesKey = (env = process.env) => {
  const derived = privateKeyToAccount(env.PILOT_PRIVATE_KEY).address;
  if (env.PILOT_ACCOUNT && env.PILOT_ACCOUNT.toLowerCase() !== derived.toLowerCase())
    throw new Error(`PILOT_ACCOUNT ${env.PILOT_ACCOUNT} is not the address of PILOT_PRIVATE_KEY (${derived}): pilot would read one account and trade another. Unset PILOT_ACCOUNT for writes.`);
};

export const writeMarkets = (opts = {}) => {
  key();
  assertAccountMatchesKey();
  return new SomniaMarkets({ chain: CHAIN, indexerUrl: INDEXER_URL, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey: key(), ...opts });
};

// The account address is derived from the key; the key itself never leaves this function.
export const accountAddress = () => process.env.PILOT_ACCOUNT ?? privateKeyToAccount(key()).address;

// JSON-safe for bigint-heavy SDK rows.
export const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

// The signed writes, built on first use: one writer, one queue, so every transaction pilot
// sends (orders, stops, cancels) is serialized and `lastHash` cannot be swapped by an overlap.
// The SDK's debug sink is the only place a REVERTED order's tx hash surfaces (the thrown
// ContractRevertError carries none), so it is kept and attached to the error as `txHash`: an
// exchange refusal still leaves a receipt anyone can look up.
export const createChain = (make = writeMarkets) => {
  let writer;
  let lastHash = null;
  let seen = []; // every tx hash the SDK reported during the current call, in order
  const debug = (e) => {
    if (e.kind === "span" && e.phase === "annotate" && e.name === "trade.execute" && e.data?.hash) {
      lastHash = e.data.hash;
      seen.push(e.data.hash);
    }
  };
  let queue = Promise.resolve();
  // `multi`: the SDK call can send more than one tx (a stop placement first grants the registry its
  // operator right), so after a failure it is not knowable WHICH hash belongs to the failing tx:
  // the error carries all of them as `txHashes` and no single `txHash`.
  const sendOne = async (fn, multi) => {
    try {
      writer ??= make({ debug });
    } catch (e) {
      if (e && typeof e === "object") e.pilotNotSent = true; // e.g. no key configured: nothing can have been broadcast
      throw e;
    }
    lastHash = null;
    seen = [];
    try {
      const res = await fn(writer.trader);
      if (multi && res && typeof res === "object") res.txsSent = [...seen];
      return res;
    } catch (e) {
      if (e && typeof e === "object") {
        if (multi) e.txHashes = [...seen];
        else e.txHash ??= lastHash;
      }
      throw e;
    }
  };
  const run = (fn, multi = false) => {
    const r = queue.then(() => sendOne(fn, multi));
    queue = r.catch(() => {});
    return r;
  };
  return {
    send: (order) => run((t) => t.placePerpOrder(order)),
    placeStops: (params) => run((t) => t.placePerpStopOrder(params), true),
    cancelStops: (params) => run((t) => t.cancelPerpStopOrders(params)),
    cancelAll: (pool) => run((t) => t.cancelAllOrders(pool)),
  };
};

// place_order/close_position only need the order send.
export const createSender = (make = writeMarkets) => createChain(make).send;
