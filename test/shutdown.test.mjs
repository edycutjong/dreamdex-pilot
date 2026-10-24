import { describe, it, expect } from "vitest";
import { onShutdown } from "../src/shutdown.mjs";

describe("shutdown", () => {
  it("waits for the writes in flight before exiting, once, and gives up after the limit", () => {
    let clock = 0;
    const timers = [];
    const exits = [];
    let held = 1; // a market is held: a send is between its broadcast and its journal row
    const stop = onShutdown({ busy: () => held > 0, exit: (c) => exits.push(c), now: () => clock, wait: (fn) => timers.push(fn), limitMs: 1000 });
    stop();
    stop(); // stdin end and a signal can both arrive
    expect(exits).toEqual([]);
    clock += 100;
    timers.shift()();
    expect(exits).toEqual([]);
    held = 0; // journaled
    timers.shift()();
    expect(exits).toEqual([0]);
    expect(timers).toHaveLength(0);
    const late = [];
    const stuck = onShutdown({ busy: () => true, exit: (c) => late.push(c), now: () => clock, wait: (fn) => { clock += 600; fn(); }, limitMs: 1000 });
    stuck();
    expect(late).toEqual([0]); // bounded
  });
});
