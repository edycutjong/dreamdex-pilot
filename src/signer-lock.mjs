// One signing server per account and chain on this machine. Every MCP client session starts its own
// pilot server, and what keeps orders apart inside one server (the per-market lock, the in-flight
// count the daily cap adds, the writer queue) does not reach a second one: two servers signing for
// one key could both pass the same checks. So the first server to send takes this lock for its
// lifetime; any other server keeps its read tools but refuses to send until that process exits.
// A lock left behind by a process that is gone is taken over. Its place is ~/.pilot/locks whatever
// PILOT_HOME or PILOT_JOURNAL say, so a different journal is not a second signing lane.
import { linkSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const lockDir = () => join(homedir(), ".pilot", "locks");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by another user
  }
};

const holderOf = (path) => {
  try {
    return Number(readFileSync(path, "utf8").trim());
  } catch {
    return null; // gone between the failed create and this read
  }
};

export const acquireSignerLock = ({ account, chainId, dir = lockDir(), pid = process.pid, alive = isAlive }) => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `signer-${chainId}-${account.toLowerCase()}.lock`);
  const held = {
    path,
    release: () => {
      try {
        if (holderOf(path) === pid) unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    // Written aside, then linked into place: the lock never exists without its pid in it.
    const tmp = `${path}.${pid}.tmp`;
    writeFileSync(tmp, String(pid));
    try {
      linkSync(tmp, path);
      return held;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    } finally {
      unlinkSync(tmp);
    }
    const holder = holderOf(path);
    if (holder === pid) return held;
    if (holder == null) continue;
    if (Number.isInteger(holder) && holder > 0 && alive(holder))
      throw Object.assign(
        new Error(`another pilot server (pid ${holder}) is already signing for ${account} on chain ${chainId}; end that MCP session (or stop that process) to send from this one. Read tools still work here`),
        { pilotUser: true, pilotNotSent: true, code: "signerBusy" },
      );
    try {
      unlinkSync(path); // its process is gone (or the file holds no pid): take it over
    } catch {
      // someone else removed it first
    }
  }
  throw Object.assign(new Error(`could not take the signer lock ${path}; try again`), { pilotNotSent: true });
};
