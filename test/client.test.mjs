import { describe, it, expect } from "vitest";
import { ContractRevertError } from "@somnia-chain/markets-sdk";
import { createSender, createChain, assertAccountMatchesKey } from "../src/client.mjs";

// A fake SDK that emits the same debug span the real one does when a tx is broadcast.
const fakeMake = (outcome) => ({ debug }) => ({
  trader: {
    placePerpOrder: async () => {
      debug({ kind: "span", phase: "annotate", id: 1, name: "trade.execute", data: { hash: "0xabc" } });
      if (outcome === "revert") throw new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
      return { hash: "0xabc", fills: [] };
    },
  },
});

describe("createSender", () => {
  it("attaches the mined tx hash to an exchange revert", async () => {
    const send = createSender(fakeMake("revert"));
    const e = await send({}).catch((x) => x);
    expect(e.errorName).toBe("ImmediateOrCancelNoFill");
    expect(e.txHash).toBe("0xabc");
  });
  it("passes a success through untouched", async () => {
    expect((await createSender(fakeMake("ok"))({})).hash).toBe("0xabc");
  });
  it("does not carry an old hash into a failure that never broadcast", async () => {
    let n = 0;
    const send = createSender(({ debug }) => ({
      trader: {
        placePerpOrder: async () => {
          if (n++ === 0) { debug({ kind: "span", phase: "annotate", id: 1, name: "trade.execute", data: { hash: "0xold" } }); return { hash: "0xold", fills: [] }; }
          throw new Error("fetch failed");
        },
      },
    }));
    await send({});
    expect((await send({}).catch((x) => x)).txHash).toBeNull();
  });
  it("marks a failure before any send (no key) as not sent", async () => {
    const send = createSender(() => { throw new Error("PILOT_PRIVATE_KEY is not set"); });
    const e = await send({}).catch((x) => x);
    expect(e.pilotNotSent).toBe(true);
  });
  it("runs sends one at a time so each error keeps its own hash", async () => {
    let n = 0;
    const send = createSender(({ debug }) => ({
      trader: {
        placePerpOrder: async () => {
          const me = ++n;
          debug({ kind: "span", phase: "annotate", id: me, name: "trade.execute", data: { hash: `0x${me}` } });
          await new Promise((r) => setTimeout(r, me === 1 ? 20 : 0)); // first send is slower
          if (me === 1) throw new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" });
          return { hash: `0x${me}`, fills: [] };
        },
      },
    }));
    const [a, b] = await Promise.allSettled([send({}), send({})]);
    expect(a.reason.txHash).toBe("0x1");
    expect(b.value.hash).toBe("0x2");
  });
});

const hash = (c) => ({ kind: "span", phase: "annotate", id: 1, name: "trade.execute", data: { hash: `0x${c.repeat(64)}` } });

describe("createChain", () => {
  it("serializes every kind of signed write through one queue, in call order", async () => {
    const log = [];
    const slow = (name, ms) => async () => { log.push(`${name}:start`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name}:end`); return { hash: name }; };
    const chain = createChain(() => ({ trader: { placePerpOrder: slow("order", 20), placePerpStopOrder: slow("stops", 5), cancelPerpStopOrders: slow("cancel", 1), cancelAllOrders: slow("all", 1) } }));
    await Promise.all([chain.send({}), chain.placeStops({}), chain.cancelStops({}), chain.cancelAll("0xpool")]);
    expect(log).toEqual(["order:start", "order:end", "stops:start", "stops:end", "cancel:start", "cancel:end", "all:start", "all:end"]);
  });
  it("hands back every hash a stop placement sent (operator grant first) on success", async () => {
    const chain = createChain(({ debug }) => ({ trader: { placePerpStopOrder: async () => { debug(hash("1")); debug(hash("2")); return { hash: `0x${"2".repeat(64)}` }; } } }));
    expect((await chain.placeStops({})).txsSent).toEqual([`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`]);
  });
  it("after a failed stop placement reports every hash seen and never one as the failing tx", async () => {
    const chain = createChain(({ debug }) => ({ trader: { placePerpStopOrder: async () => { debug(hash("1")); throw new Error("simulation reverted"); } } }));
    const e = await chain.placeStops({}).catch((x) => x);
    expect(e.txHashes).toEqual([`0x${"1".repeat(64)}`]);
    expect(e.txHash).toBeUndefined();
  });
  it("a hash from an earlier call is never attached to a later error", async () => {
    let n = 0;
    const chain = createChain(({ debug }) => ({ trader: { cancelPerpStopOrders: async () => { if (n++ === 0) { debug(hash("1")); return {}; } throw new Error("boom"); } } }));
    await chain.cancelStops({});
    const e = await chain.cancelStops({}).catch((x) => x);
    expect(e.txHash).toBeNull();
  });
  it("keeps a thrown non-object intact instead of hiding it behind a TypeError", async () => {
    const chain = createChain(() => ({ trader: { cancelAllOrders: async () => { throw "plain string"; } } }));
    await expect(chain.cancelAll("0x")).rejects.toBe("plain string");
  });
});

describe("assertAccountMatchesKey", () => {
  const key = "0x" + "11".repeat(32);
  it("passes when PILOT_ACCOUNT is unset", () => expect(() => assertAccountMatchesKey({ PILOT_PRIVATE_KEY: key })).not.toThrow());
  it("refuses writes when PILOT_ACCOUNT is another address than the key's", () =>
    expect(() => assertAccountMatchesKey({ PILOT_PRIVATE_KEY: key, PILOT_ACCOUNT: "0x000000000000000000000000000000000000dEaD" })).toThrow(/read one account and trade another/));
});
