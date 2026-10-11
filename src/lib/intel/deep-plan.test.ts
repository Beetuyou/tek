import assert from "node:assert/strict";
import test from "node:test";
import {
  COVERAGE_LIMIT,
  PUMP_WINDOWS,
  SOURCE_CAPS,
  afterPumpPage,
  initialSources,
  metadataBlock,
  overallPercent,
  pumpWindowNote,
  type DeepSource,
} from "./deep-plan.ts";

function source(partial: Partial<DeepSource> & Pick<DeepSource, "id">): DeepSource {
  return {
    label: partial.id,
    status: "running",
    cursor: 0,
    scanned: 0,
    metadataOk: 0,
    matches: 0,
    note: "",
    measurable: true,
    ...partial,
  };
}

test("metadata checks stop after repeated rate limits or the read budget", () => {
  assert.equal(metadataBlock({ strikes: 2, attempts: 10 }), null);
  assert.equal(metadataBlock({ strikes: 3, attempts: 10 }), "rate");
  assert.equal(metadataBlock({ strikes: 0, attempts: 160 }), "budget");
  assert.equal(metadataBlock({ strikes: 0, attempts: 159 }), null);
});

test("an empty pump page ends the window and a full page advances until the cap", () => {
  assert.deepEqual(afterPumpPage(100, 50, 0, 1000), { next: 100, ended: true, reason: "empty" });
  assert.deepEqual(afterPumpPage(0, 50, 50, 1000), { next: 50, ended: false, reason: "continue" });
  assert.deepEqual(afterPumpPage(950, 50, 50, 1000), { next: 1000, ended: true, reason: "cap" });
});

test("pump window notes do not claim a year or the gap was scanned", () => {
  for (const window of PUMP_WINDOWS) {
    const note = pumpWindowNote({ ...window, scanned: 1000, oldest: "2024-01-25T00:00:00.000Z", newest: "2026-10-09T00:00:00.000Z", ended: true, reason: "empty" });
    assert.match(note, /not fully scanned|not every token/i);
    assert.doesNotMatch(note, /every memecoin/i);
    assert.doesNotMatch(note, /fully scanned the last year/i);
    assert.doesNotMatch(note, /100% of all/i);
  }
  assert.match(COVERAGE_LIMIT, /not every memecoin/i);
  assert.match(COVERAGE_LIMIT, /30 days/);
  assert.doesNotMatch(COVERAGE_LIMIT, /January/);
  assert.doesNotMatch(COVERAGE_LIMIT, /fully scanned the last year/i);
});

test("percent is the share of connected ranges, and unavailable sources are ignored", () => {
  const sources = initialSources(false);
  assert.equal(sources.find((row) => row.id === "birdeye")?.status, "unavailable");
  assert.equal(overallPercent(sources, SOURCE_CAPS), 0);
  const done = sources.map((row) => (row.measurable ? { ...row, status: "done" as const } : row));
  assert.equal(overallPercent(done, SOURCE_CAPS), 100);
  const cap = SOURCE_CAPS["pump-newest"] ?? 1;
  const mid = [source({ id: "pump-newest", status: "running", scanned: cap / 2 })];
  assert.equal(overallPercent(mid, SOURCE_CAPS), 50);
  const blocked = [source({ id: "solana-program", status: "blocked", measurable: false })];
  assert.equal(overallPercent(blocked, SOURCE_CAPS), null);
});
