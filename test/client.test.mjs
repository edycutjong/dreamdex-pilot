import { describe, it, expect } from "vitest";
import { ContractRevertError } from "@somnia-chain/markets-sdk";
import { createSender } from "../src/client.mjs";

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
});
