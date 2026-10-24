import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../src/journal.mjs";

afterEach(() => vi.useRealTimers());

describe("journal", () => {
  it("appends JSONL rows with a timestamp and bigints as strings", () => {
    const j = createJournal(join(mkdtempSync(join(tmpdir(), "pilot-j-")), "sub", "journal.jsonl"));
    j.append({ kind: "plan", quantity: 100000000n });
    j.append({ kind: "order", sent: true, action: "open" });
    const lines = readFileSync(j.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "plan", quantity: "100000000" });
    expect(j.read()[1].at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it("reads an empty journal as no rows", () => {
    expect(createJournal(join(mkdtempSync(join(tmpdir(), "pilot-j-")), "none.jsonl")).read()).toEqual([]);
  });
  it("counts only today's sent opening orders toward the daily cap", () => {
    const j = createJournal(join(mkdtempSync(join(tmpdir(), "pilot-j-")), "journal.jsonl"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T23:59:00Z"));
    j.append({ kind: "order", sent: true, action: "open" }); // yesterday
    vi.setSystemTime(new Date("2026-10-24T03:00:00Z"));
    j.append({ kind: "order", sent: true, action: "open" });
    j.append({ kind: "refusal", refused_by: "exchange", sent: true, action: "open" }); // reverted, but sent
    j.append({ kind: "refusal", refused_by: "pilot-policy", action: "open" }); // never sent
    j.append({ kind: "close", sent: true, action: "close" }); // closes never count
    expect(j.ordersToday(new Date("2026-10-24T12:00:00Z"))).toBe(2);
  });
});
