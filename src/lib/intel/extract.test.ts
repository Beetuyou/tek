import assert from "node:assert/strict";
import { extractSignals } from "./extract.ts";
import { normalizeLink } from "./normalize.ts";

const pepe = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const signals = extractSignals(`launch $${"BONK"} ${pepe} https://pump.fun/coin/${mint}`);
assert.ok(signals.cas.includes(pepe));
assert.ok(signals.cas.includes(mint));
assert.ok(signals.tickers.includes("BONK"));

const link = normalizeLink("https://x.com/bonk_inu/status/1810000000000000000");
assert.equal(link.valid, true);
assert.equal(link.handle, "bonk_inu");
assert.equal(link.platform, "x");

const bad = normalizeLink("https://example.com/nope");
assert.equal(bad.valid, false);

console.log("extract+normalize ok");
