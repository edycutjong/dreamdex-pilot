// Append-only JSONL journal of every plan, refusal and transaction: ~/.pilot/journal.jsonl.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pilotHome } from "./policy.mjs";

const big = (_, x) => (typeof x === "bigint" ? x.toString() : x);

export const createJournal = (path = process.env.PILOT_JOURNAL ?? join(pilotHome(), "journal.jsonl")) => {
  const append = (entry) => {
    mkdirSync(dirname(path), { recursive: true });
    const row = { at: new Date().toISOString(), ...entry };
    appendFileSync(path, JSON.stringify(row, big) + "\n");
    return row;
  };
  // A corrupt line fails closed (the daily cap cannot be counted), with a message that says where.
  const read = () => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").flatMap((l, i) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l)];
      } catch {
        throw new Error(`journal ${path} line ${i + 1} is not valid JSON; move the file aside or fix that line`);
      }
    });
  };
  // The daily cap counts every opening transaction pilot SENT today (UTC), including ones the
  // exchange reverted (real sends) and ones whose send status is unknown. Closes never count.
  const ordersToday = (now = new Date()) => {
    const day = now.toISOString().slice(0, 10);
    return read().filter((e) => e.at.startsWith(day) && (e.sent === true || e.sent === "unknown") && e.action === "open").length;
  };
  return { path, append, read, ordersToday };
};
