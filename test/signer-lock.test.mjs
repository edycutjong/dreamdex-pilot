import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireSignerLock } from "../src/signer-lock.mjs";

const account = "0x440E03bb3AAdBE65D5Bf2Ad7f84A64c509ff438b";
const fresh = () => mkdtempSync(join(tmpdir(), "pilot-lock-"));

describe("signer lock", () => {
  it("one live server per account and chain: a second one is refused as not sent, and takes over once the first is gone", () => {
    const dir = fresh();
    const live = new Set([111]);
    const a = acquireSignerLock({ account, chainId: 50383, dir, pid: 111, alive: (p) => live.has(p) });
    expect(readFileSync(a.path, "utf8")).toBe("111");
    expect(a.path).toMatch(/signer-50383-0x440e03bb3aadbe65d5bf2ad7f84a64c509ff438b\.lock$/);
    let err;
    try { acquireSignerLock({ account, chainId: 50383, dir, pid: 222, alive: (p) => live.has(p) }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: "signerBusy", pilotNotSent: true, pilotUser: true });
    expect(err.message).toMatch(/another pilot server \(pid 111\) is already signing for 0x440E.* on chain 50383/);
    expect(acquireSignerLock({ account, chainId: 50383, dir, pid: 111, alive: () => true }).path).toBe(a.path); // its own lock again: fine
    live.delete(111); // the first server died without releasing
    acquireSignerLock({ account, chainId: 50383, dir, pid: 222, alive: (p) => live.has(p) });
    expect(readFileSync(a.path, "utf8")).toBe("222");
    expect(readdirSync(dir)).toEqual([a.path.split("/").pop()]); // no temp files left behind
  });
  it("other accounts and chains are separate lanes; release removes only its own lock", () => {
    const dir = fresh();
    const a = acquireSignerLock({ account, chainId: 50383, dir, pid: 1, alive: () => true });
    expect(() => acquireSignerLock({ account: "0x0d6D4dd4125477f5f0E380eDE951B37a395Fa036", chainId: 50383, dir, pid: 2, alive: () => true })).not.toThrow();
    expect(() => acquireSignerLock({ account, chainId: 1, dir, pid: 2, alive: () => true })).not.toThrow();
    const b = { ...a, release: acquireSignerLock({ account, chainId: 50383, dir, pid: 1, alive: () => true }).release };
    writeFileSync(a.path, "9"); // taken over by someone else meanwhile
    b.release();
    expect(readFileSync(a.path, "utf8")).toBe("9");
    writeFileSync(a.path, "1");
    a.release();
    expect(existsSync(a.path)).toBe(false);
  });
  it("a lock file without a pid (or garbage) is taken over", () => {
    const dir = fresh();
    const path = join(dir, `signer-50383-${account.toLowerCase()}.lock`);
    writeFileSync(path, "");
    expect(acquireSignerLock({ account, chainId: 50383, dir, pid: 7, alive: () => true }).path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("7");
  });
  it("two servers that saw the same dead holder: only one takes the lock (the takeover is serialized)", () => {
    const dir = fresh();
    const path = join(dir, `signer-50383-${account.toLowerCase()}.lock`);
    writeFileSync(path, "999"); // left by a server that died
    let bResult;
    let calls = 0;
    // A's second liveness check runs while A holds the takeover file: B tries right then.
    const aliveA = (p) => {
      if (p === 999 && ++calls === 2) {
        try { bResult = acquireSignerLock({ account, chainId: 50383, dir, pid: 222, alive: (q) => q === 111 }); } catch (e) { bResult = e; }
      }
      return p === 111;
    };
    const a = acquireSignerLock({ account, chainId: 50383, dir, pid: 111, alive: aliveA });
    expect(readFileSync(a.path, "utf8")).toBe("111");
    expect(bResult).toBeInstanceOf(Error);
    expect(bResult.message).toMatch(/could not take the signer lock/);
    expect(bResult.pilotNotSent).toBe(true);
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });
  it("a takeover file left by a server that died mid-takeover is cleared once it is stale", () => {
    const dir = fresh();
    const path = join(dir, `signer-50383-${account.toLowerCase()}.lock`);
    writeFileSync(path, "999");
    writeFileSync(`${path}.takeover`, "");
    expect(() => acquireSignerLock({ account, chainId: 50383, dir, pid: 7, alive: () => false })).toThrow(/could not take/); // fresh: someone may be mid-takeover
    expect(acquireSignerLock({ account, chainId: 50383, dir, pid: 7, alive: () => false, now: () => Date.now() + 60_000 }).path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("7");
  });
  it.skipIf(process.getuid?.() === 0)("a pid this user cannot signal (EPERM: another user's process, e.g. pid 1) is a reused pid, not a holder", () => {
    const dir = fresh();
    const path = join(dir, `signer-50383-${account.toLowerCase()}.lock`);
    writeFileSync(path, "1"); // left by a server that died; pid 1 is now root's init
    expect(readFileSync(acquireSignerLock({ account, chainId: 50383, dir }).path, "utf8")).toBe(String(process.pid));
  });
  it("across real processes: a live child holding the lock refuses this process; after it exits, this process takes it", async () => {
    const dir = fresh();
    const mod = fileURLToPath(new URL("../src/signer-lock.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `const { acquireSignerLock } = await import(${JSON.stringify(mod)}); const l = acquireSignerLock({ account: ${JSON.stringify(account)}, chainId: 50383, dir: ${JSON.stringify(dir)} }); process.on("exit", l.release); console.log("locked"); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`]);
    await new Promise((res, rej) => { child.stdout.on("data", (d) => String(d).includes("locked") && res()); child.on("error", rej); child.on("exit", (c) => rej(new Error(`child exited ${c}`))); });
    expect(() => acquireSignerLock({ account, chainId: 50383, dir })).toThrow(new RegExp(`pid ${child.pid}`));
    const exited = new Promise((res) => child.on("exit", res));
    child.stdin.end();
    await exited;
    expect(readFileSync(acquireSignerLock({ account, chainId: 50383, dir }).path, "utf8")).toBe(String(process.pid));
  });
});
