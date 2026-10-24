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
  const read = () =>
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  // The daily cap counts every opening transaction pilot SENT today (UTC), including ones the
  // exchange reverted: they were real sends. Closes never count and are never capped.
  const ordersToday = (now = new Date()) => {
    const day = now.toISOString().slice(0, 10);
    return read().filter((e) => e.at.startsWith(day) && e.sent === true && e.action === "open").length;
  };
  return { path, append, read, ordersToday };
};
