import { describe, it, expect } from "vitest";
import { ContractRevertError, RpcError } from "@somnia-chain/markets-sdk";
import { explainExchangeError, isExchangeRefusal, describeError } from "../src/exchange-errors.mjs";

describe("explainExchangeError", () => {
  it("turns ImmediateOrCancelNoFill into plain words and a next step", () => {
    const x = explainExchangeError(new ContractRevertError({ errorName: "ImmediateOrCancelNoFill" }));
    expect(x.code).toBe("ImmediateOrCancelNoFill");
    expect(x.reason).toMatch(/found nothing to fill/);
    expect(x.next).toMatch(/plan again/);
  });
  it("names an unmapped custom error rather than guessing", () => {
    expect(explainExchangeError(new ContractRevertError({ errorName: "SomethingNew" })).reason).toMatch(/SomethingNew/);
  });
  it("does not present the SDK's failed replay as the exchange's reason (sieve report 015)", () => {
    const x = explainExchangeError(new ContractRevertError({ reason: "@somnia-chain/markets-sdk: rpc eth_call failed: RPC Request failed." }));
    expect(x.code).toBe("unknown");
    expect(x.reason).toMatch(/reason is unknown/);
    expect(x.reason).not.toMatch(/^the exchange reverted the order: @somnia/);
  });
  it("passes a plain require string through", () => {
    expect(explainExchangeError(new ContractRevertError({ reason: "ERC20: transfer amount exceeds balance" })).reason).toMatch(/transfer amount exceeds balance/);
  });
  it("handles a revert with no data", () => {
    expect(explainExchangeError(new ContractRevertError({})).reason).toMatch(/no readable reason/);
  });
});

describe("isExchangeRefusal / describeError", () => {
  it("only a contract revert is an exchange refusal", () => {
    expect(isExchangeRefusal(new ContractRevertError({ errorName: "X" }))).toBe(true);
    expect(isExchangeRefusal(new Error("socket hang up"))).toBe(false);
  });
  it("surfaces error.cause (sieve report 004)", () => {
    const e = new Error("genesis check failed", { cause: new Error("connect ECONNREFUSED") });
    expect(describeError(e)).toMatch(/cause: connect ECONNREFUSED/);
  });
  it("is exported by the SDK under the names we branch on", () => {
    expect(typeof RpcError).toBe("function");
  });
});
