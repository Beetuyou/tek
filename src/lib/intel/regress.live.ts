import assert from "node:assert/strict";
import { readChain } from "./chain.ts";
import { attachHistory } from "./history.ts";
import { readJupiter } from "./indexers.ts";
import { pairsForAddress } from "./providers.ts";
import { relateToken } from "./score.ts";
import type { TokenHit } from "./types.ts";

const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const TBA = "YbwgtV8hdnXyBVBZqdHt5adKwwQzRwYtyyenQm7pump";
const PUMP = "H8R9Bh4QHNj9WfhjixM3uJfYsurwhKQBGvZ5NN1zpump";
const NONE = "SysvarC1ock11111111111111111111111111111111";

function shell(read: Awaited<ReturnType<typeof readChain>>): TokenHit {
  return {
    chain: read.chain,
    address: read.address,
    existence: read.existence,
    name: read.name,
    symbol: read.symbol,
    identityConflicts: [],
    marketStatus: "unavailable",
    markets: [],
    confidence: 0,
    relationship: "unverified",
    matchClass: "exact",
    evidence: [],
  };
}

const pepe = await readChain(PEPE);
assert.equal(pepe.existence, "verified");
assert.equal(pepe.symbol?.value, "PEPE");
assert.equal(pepe.symbol?.status, "verified");
assert.equal(pepe.name?.value, "Pepe");
assert.match(pepe.symbol?.source || "", /symbol\(\)/);
console.log("TEST B pass", JSON.stringify({ chain: pepe.chain, name: pepe.name, symbol: pepe.symbol }));

const tba = await readChain(TBA);
assert.equal(tba.existence, "verified");
assert.equal(tba.symbol?.value, "TBA");
assert.notEqual(tba.symbol?.value, "CA");
assert.equal(tba.name?.value, "Terminal Backrooms Agency");
console.log("TEST C pass", JSON.stringify({ symbol: tba.symbol, name: tba.name }));

const pump = await readChain(PUMP);
assert.equal(pump.existence, "verified");
assert.equal(pump.symbol?.value, "ILOVMNKYS");
assert.notEqual(pump.symbol?.value, "CA");
const dex = await pairsForAddress(PUMP);
let jupiter: Awaited<ReturnType<typeof readJupiter>> | null = null;
let jupiterError = "";
try {
  jupiter = await readJupiter(PUMP);
} catch (err) {
  jupiterError = err instanceof Error ? err.message : "jupiter failed";
}
console.log("TEST E pass", JSON.stringify({
  existence: pump.existence,
  symbol: pump.symbol,
  dexPairs: dex.length,
  jupiter: jupiter ? { symbol: jupiter.symbol, price: jupiter.usdPrice, liq: jupiter.liquidity, launchpad: jupiter.launchpad } : null,
  jupiterError,
}));
assert.equal(pump.symbol?.source, "solana-token-metadata");
assert.notEqual(pump.symbol?.value, "CA");

const unrelated = relateToken(shell(tba), { handle: "someone", cas: [], tickers: ["TBA"] });
assert.equal(unrelated.relationship, "unverified");
console.log("TEST shared-ticker-not-proof", unrelated.relationship, unrelated.evidence.map((item) => item.kind));

const remembered = attachHistory(
  { ...shell(tba), twitter: "https://x.com/newbrand" },
  [{ address: TBA, chain: "solana", handle: "oldbrand", url: "https://x.com/oldbrand/status/1", recordedAt: "2026-09-01T00:00:00.000Z" }],
);
assert.equal(remembered.relationship, "historical");
assert.equal(remembered.symbol?.value, "TBA");
assert.ok(remembered.evidence.some((item) => item.kind === "historical"));
console.log("TEST A pass", remembered.relationship, remembered.evidence.find((item) => item.kind === "historical")?.detail);

const missing = await readChain(NONE);
assert.equal(missing.existence, "not_found");
console.log("TEST F account", missing.existence, missing.detail);

const emptyPost = relateToken(shell(pepe), { cas: [], tickers: [], handle: "nobody" });
assert.equal(emptyPost.relationship, "unverified");
console.log("TEST F relationship", emptyPost.relationship);

try {
  const tt = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent("https://www.tiktok.com/@tiktok/video/6718335390845095173"));
  const body = await tt.text();
  console.log("TEST D tiktok oembed", tt.status, body.slice(0, 180).replace(/\n/g, " "));
} catch (err) {
  console.log("TEST D tiktok oembed failed", err instanceof Error ? err.message : err);
}

console.log("LIVE REGRESSION OK");
