// One signing server per account and chain on this machine. Every MCP client session starts its own
// pilot server, and what keeps orders apart inside one server (the per-market lock, the in-flight
// count the daily cap adds, the writer queue) does not reach a second one: two servers signing for
// one key could both pass the same checks. So the first server to send takes this lock for its
// lifetime; any other server keeps its read tools but refuses to send until that process exits.
// A lock left behind by a process that is gone is taken over. Its place is ~/.pilot/locks whatever
// PILOT_HOME or PILOT_JOURNAL say, so a different journal is not a second signing lane.
import { linkSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const lockDir = () => join(homedir(), ".pilot", "locks");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: a process of another user, which is never a pilot server signing from this
    // user's ~/.pilot, so a pid reused after a crash or a reboot (e.g. by a root daemon) is not a holder.
    return false;
  }
};

const holderOf = (path) => {
  try {
    return Number(readFileSync(path, "utf8").trim());
  } catch {
    return null; // gone between the failed create and this read
  }
};

export const acquireSignerLock = ({ account, chainId, dir = lockDir(), pid = process.pid, alive = isAlive, now = Date.now, takeoverStaleMs = 10_000 }) => {
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
  // Written aside, then linked into place: the lock never exists without its pid in it.
  const place = () => {
    const tmp = `${path}.${pid}.tmp`;
    writeFileSync(tmp, String(pid));
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      return false;
    } finally {
      unlinkSync(tmp);
    }
  };
  const busy = (holder) =>
    Object.assign(
      new Error(`another pilot server (pid ${holder}) is already signing for ${account} on chain ${chainId}; end that MCP session (or stop that process) to send from this one. Read tools still work here`),
      { pilotUser: true, pilotNotSent: true, code: "signerBusy" },
    );
  // Taking over a dead holder's lock is serialized by a short-lived takeover file (exclusive create),
  // so two servers that both saw the same dead pid cannot both delete the lock and both take it: the
  // one holding the takeover re-reads the holder, replaces the lock, and only then lets go. A takeover
  // file left by a process that died mid-takeover is cleared after takeoverStaleMs.
  const takeover = `${path}.takeover`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (place()) return held;
    const seen = holderOf(path);
    if (seen === pid) return held;
    if (Number.isInteger(seen) && seen > 0 && alive(seen)) throw busy(seen);
    let fd;
    try {
      fd = openSync(takeover, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (now() - statSync(takeover).mtimeMs > takeoverStaleMs) unlinkSync(takeover);
      } catch {
        // gone already
      }
      continue; // another server is taking over right now
    }
    try {
      closeSync(fd);
      const holder = holderOf(path); // read again, now that no one else can be replacing it
      if (holder === pid) return held;
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw busy(holder);
      try {
        unlinkSync(path); // its process is gone (or the file holds no pid)
      } catch {
        // already gone
      }
      if (place()) return held;
    } finally {
      try {
        unlinkSync(takeover);
      } catch {
        // cleared already
      }
    }
  }
  throw Object.assign(new Error(`could not take the signer lock ${path}; try again`), { pilotNotSent: true });
};
