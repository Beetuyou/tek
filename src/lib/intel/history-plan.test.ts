import assert from "node:assert/strict";
import test from "node:test";
import { agePhrase, isOlderThanMaxAge, isWithinMaxAge, linkOriginFor, nextOffset, originPhrase, retainIndexedRows, windowNote } from "./history-plan.ts";

test("historical checkpoint advances only after a non-empty page", () => {
  assert.equal(nextOffset(800, 50, true, 50), 850);
  assert.equal(nextOffset(800, 50, false, 0), 800);
  assert.equal(nextOffset(800, 50, true, 0), 800);
});

test("coverage wording does not claim a full period was scanned", () => {
  assert.match(windowNote("the last 90 days"), /not every token launched/);
  assert.match(originPhrase("current"), /not separately available/);
  assert.match(originPhrase("launch"), /launch metadata/);
  assert.match(originPhrase("later"), /later profile/);
});

test("pump list fields are not treated as launch metadata", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  assert.equal(linkOriginFor({ source: "pump.fun-history", createdAt: "2026-06-09T12:00:00.000Z", now }), "current");
  assert.equal(linkOriginFor({ source: "pump.fun-history", inLaunchMetadata: true, now }), "launch");
  assert.equal(
    linkOriginFor({ source: "dexscreener-token", createdAt: "2026-06-09T12:00:00.000Z", now }),
    "later",
  );
  assert.equal(linkOriginFor({ source: "dexscreener-profiles", createdAt: new Date(now - 60_000).toISOString(), now }), "current");
});

test("the index window is 30 days and rejects older or far-future times", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  assert.equal(isWithinMaxAge(new Date(now - 2 * 86_400_000).toISOString(), now), true);
  assert.equal(isWithinMaxAge(new Date(now - 20 * 86_400_000).toISOString(), now), true);
  assert.equal(isWithinMaxAge(new Date(now - 29 * 86_400_000).toISOString(), now), true);
  assert.equal(isWithinMaxAge(new Date(now - 40 * 86_400_000).toISOString(), now), false);
  assert.equal(isWithinMaxAge(new Date(now + 60_000).toISOString(), now), true);
  assert.equal(isWithinMaxAge(new Date(now + 5 * 60_000).toISOString(), now), false);
  assert.equal(isWithinMaxAge("not-a-date", now), false);
  assert.equal(isWithinMaxAge(null, now), false);
  assert.equal(isOlderThanMaxAge(new Date(now - 40 * 86_400_000).toISOString(), now), true);
  assert.equal(isOlderThanMaxAge(new Date(now + 5 * 60_000).toISOString(), now), false);
  assert.equal(isOlderThanMaxAge(new Date(now - 2 * 86_400_000).toISOString(), now), false);
});

test("age phrase covers hours, days, and months", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  assert.equal(agePhrase(new Date(now - 2 * 3_600_000).toISOString(), now), "2 hours old");
  assert.equal(agePhrase(new Date(now - 12 * 86_400_000).toISOString(), now), "12 days old");
  assert.equal(agePhrase(new Date(now - 120 * 86_400_000).toISOString(), now), "about 4 months old");
});

test("old and illiquid indexed rows are kept", () => {
  const rows = retainIndexedRows([
    { address: "today", liquidityUsd: 0, createdAt: "2026-10-09T10:00:00.000Z" },
    { address: "twelve", liquidityUsd: 1, createdAt: "2026-09-27T12:00:00.000Z" },
    { address: "months", createdAt: "2026-06-09T12:00:00.000Z" },
    { address: "" },
  ]);
  assert.deepEqual(rows.map((row) => row.address), ["today", "twelve", "months"]);
});
