import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLink } from "./normalize.ts";
import { collectPostLinks, postKeyFromUrl, profileKeyFromUrl } from "./post-key.ts";
import { citingLinks, launchTimeFromPayload, socialFieldsFromPayload } from "./social-extract.ts";
import { resolvePostUrl } from "./url-resolve.ts";

const STATUS = "2108270683352703418";
const WITH_QUERY = `https://x.com/Armoskii/status/${STATUS}?s=20`;

test("x.com and twitter.com status URLs share one post id, including tracking and photo suffixes", () => {
  const a = postKeyFromUrl(`https://x.com/Armoskii/status/${STATUS}`);
  const b = postKeyFromUrl(`https://twitter.com/Armoskii/status/${STATUS}`);
  const c = postKeyFromUrl(WITH_QUERY);
  const d = postKeyFromUrl(`https://twitter.com/Armoskii/status/${STATUS}/photo/1`);
  assert.equal(a?.key, `x:${STATUS}`);
  assert.equal(b?.key, a?.key);
  assert.equal(c?.key, a?.key);
  assert.equal(d?.key, a?.key);
  assert.equal(normalizeLink(WITH_QUERY).state, "resolved");
});

test("tiktok canonical video and photo URLs keep the numeric id", () => {
  const id = "7694435743086726413";
  const www = postKeyFromUrl(`https://www.tiktok.com/@name/video/${id}?is_from_webapp=1&sender_device=pc`);
  const bare = postKeyFromUrl(`https://tiktok.com/@name/video/${id}`);
  const photo = normalizeLink(`https://www.tiktok.com/@name/photo/${id}`);
  assert.equal(www?.key, `tiktok:${id}`);
  assert.equal(bare?.key, www?.key);
  assert.equal(photo.state, "resolved");
  assert.equal(photo.postId, id);
  assert.match(photo.canonical, /\/photo\//);
});

test("tiktok short links need resolution and do not invent an id when the redirect fails", async () => {
  assert.equal(normalizeLink("https://vm.tiktok.com/ZABC/").state, "needs_resolution");
  assert.equal(normalizeLink("https://vt.tiktok.com/ZABC/").state, "needs_resolution");
  assert.equal(normalizeLink("https://www.tiktok.com/t/ZABC/").state, "needs_resolution");
  assert.equal(postKeyFromUrl("https://vm.tiktok.com/ZABC/"), null);

  const resolved = await resolvePostUrl("https://vm.tiktok.com/ZABC/", async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://www.tiktok.com/@name/video/1234567890123456789?is_from_webapp=1" },
    }),
  );
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.postId, "1234567890123456789");

  const offsite = await resolvePostUrl("https://vt.tiktok.com/ZABC/", async () =>
    new Response(null, { status: 302, headers: { location: "https://evil.example/phish" } }),
  );
  assert.equal(offsite.state, "unresolved");
  assert.equal(offsite.valid, false);
  assert.equal(offsite.postId, undefined);
  assert.match(offsite.error || "", /not marked invalid/);

  const timeout = await resolvePostUrl("https://vm.tiktok.com/ZDOWN/", async () => {
    throw new Error("timeout");
  });
  assert.equal(timeout.state, "unresolved");
  assert.equal(timeout.postId, undefined);
});

test("a profile is a profile, not a post id", () => {
  const profile = normalizeLink("https://www.tiktok.com/@name");
  assert.equal(profile.kind, "profile");
  assert.equal(profile.valid, true);
  assert.equal(profile.postId, undefined);
  assert.equal(postKeyFromUrl("https://x.com/Armoskii"), null);
  assert.equal(profileKeyFromUrl("https://x.com/Armoskii")?.key, "x:@armoskii");
  assert.equal(normalizeLink("https://www.instagram.com/reel/DeNZyUxM9m8/").kind, "post");
});

test("nested DexScreener pair socials cite the status, pump launch metadata that points elsewhere does not", () => {
  const dex = {
    pairs: [
      {
        chainId: "solana",
        pairCreatedAt: 1791485560000,
        baseToken: { address: "Mint111111111111111111111111111111111111" },
        info: { socials: [{ type: "twitter", url: WITH_QUERY }], websites: [] },
      },
    ],
  };
  const pump = {
    twitter: "https://x.com/Noorii__5/status/2108267185097298035",
    website: "",
    description: "Deployed using https://j7tracker.io",
    created_timestamp: 1791485506000,
    updated_at: 1791550342,
  };
  const fields = socialFieldsFromPayload(dex);
  assert.ok(fields.some((field) => field.value === WITH_QUERY));
  const cited = citingLinks(`x:${STATUS}`, [
    { source: "dexscreener-token", body: dex },
    { source: "pump.fun-coin", body: pump },
  ], new Date(1791485506000).toISOString());
  assert.equal(cited.length, 1);
  assert.equal(cited[0].source, "dexscreener-token");
  assert.equal(cited[0].linkOrigin, "later");
  const launchOnly = citingLinks(`x:${STATUS}`, [{ source: "pump.fun-coin", body: pump }]);
  assert.equal(launchOnly.length, 0);
  assert.equal(citingLinks("x:2108267185097298035", [{ source: "metadata-uri", body: { twitter: pump.twitter } }]).length, 1);
});

test("ordinary handles are profile links, and empty social metadata is not a post match", () => {
  assert.deepEqual(
    collectPostLinks([{ field: "twitter", value: "https://x.com/GaryCatX" }]).map((link) => link.postKey),
    ["x:@garycatx"],
  );
  assert.equal(citingLinks("x:1", [{ source: "dexscreener-token", body: { pairs: [{ info: { socials: [] } }] } }]).length, 0);
  assert.equal(citingLinks("x:@garycatx", [{ source: "pump.fun-coin", body: { twitter: "https://x.com/GaryCatX" } }]).length, 1);
  assert.equal(citingLinks("x:@armoskii", [{ source: "dexscreener-token", body: { twitter: `https://x.com/Armoskii/status/${STATUS}` } }]).length, 1);
});

test("launch time uses token creation, then pool creation, and never updated_at", () => {
  const both = launchTimeFromPayload({ created_timestamp: 1791485506000, pairCreatedAt: 1791485560000, updated_at: 1791550342 });
  assert.equal(both.kind, "token");
  assert.equal(both.iso, new Date(1791485506000).toISOString());
  const pool = launchTimeFromPayload({ pairCreatedAt: 1791485560000, updated_at: Date.now() });
  assert.equal(pool.kind, "pool");
  assert.equal(pool.iso, new Date(1791485560000).toISOString());
  assert.deepEqual(launchTimeFromPayload({ updated_at: Date.now() }), {});
});
