import assert from "node:assert/strict";
import test from "node:test";
import { classifyLink, collectPostLinks, isAccountProfileUrl, keysDropped, postKeyFromUrl, profileKeyFromUrl, strongestClass } from "./post-key.ts";

test("same X status is one key regardless of handle or query", () => {
  const a = postKeyFromUrl("https://x.com/trencherdeploy/status/2108331766519939528?s=46");
  const b = postKeyFromUrl("https://twitter.com/i/status/2108331766519939528");
  assert.equal(a?.key, "x:2108331766519939528");
  assert.equal(b?.key, a?.key);
});

test("a profile url is the account, not a post on the account", () => {
  assert.equal(isAccountProfileUrl("https://x.com/Armoskii", "x", "armoskii"), true);
  assert.equal(isAccountProfileUrl("https://twitter.com/Armoskii?s=21", "x", "Armoskii"), true);
  assert.equal(isAccountProfileUrl("https://x.com/Armoskii/status/1", "x", "armoskii"), false);
  assert.equal(isAccountProfileUrl("https://www.tiktok.com/@druski", "tiktok", "druski"), true);
  assert.equal(isAccountProfileUrl("https://www.tiktok.com/@druski/video/1", "tiktok", "druski"), false);
  assert.equal(isAccountProfileUrl("https://www.instagram.com/cockroachjantaparty/", "instagram", "CockroachJantaParty"), true);
  assert.equal(isAccountProfileUrl("https://www.instagram.com/reel/abc/", "instagram", "abc"), false);
});

test("a profile is not a post, but it is its own account key", () => {
  assert.equal(postKeyFromUrl("https://x.com/Pumpfun"), null);
  assert.equal(postKeyFromUrl("https://www.tiktok.com/@druski"), null);
  assert.equal(postKeyFromUrl("https://www.instagram.com/cockroachjantaparty"), null);
  assert.equal(postKeyFromUrl("https://x.com/i/communities/2038004348622454968"), null);
  assert.equal(profileKeyFromUrl("https://x.com/Pumpfun?s=21")?.key, "x:@pumpfun");
  assert.equal(profileKeyFromUrl("https://twitter.com/Pumpfun/")?.canonical, "https://x.com/Pumpfun");
  assert.equal(profileKeyFromUrl("https://www.tiktok.com/@druski")?.key, "tiktok:@druski");
  assert.equal(profileKeyFromUrl("https://www.instagram.com/cockroachjantaparty")?.key, "instagram:@cockroachjantaparty");
  assert.equal(profileKeyFromUrl("https://x.com/i/communities/2038004348622454968"), null);
  assert.equal(profileKeyFromUrl("https://x.com/home"), null);
  assert.equal(profileKeyFromUrl("https://www.tiktok.com/@druski/video/7694435743086726413")?.key, "tiktok:@druski");
  assert.equal(profileKeyFromUrl("https://twitter.com/i/status/2108331766519939528"), null);
});

test("tiktok video and instagram post or reel keep the post id", () => {
  assert.equal(
    postKeyFromUrl("https://www.tiktok.com/@druski/video/7694435743086726413")?.key,
    "tiktok:7694435743086726413",
  );
  assert.equal(postKeyFromUrl("https://www.instagram.com/p/DeQGwHnxx8S/")?.key, "instagram:DeQGwHnxx8S");
  assert.equal(postKeyFromUrl("https://www.instagram.com/reel/DeNZyUxM9m8/?stkn=1")?.key, "instagram:DeNZyUxM9m8");
  assert.equal(postKeyFromUrl("https://www.tiktok.com/music/original-sound-7629357399823928077"), null);
});

test("metadata collector keeps posts and the profiles those links belong to", () => {
  const links = collectPostLinks([
    { field: "twitter", value: "https://x.com/flowerDexSol" },
    { field: "twitter", value: "https://x.com/thedevrrrrrrr/status/2108339994217922771" },
    { field: "twitter", value: "@GaryCatX" },
    { field: "website", value: "https://www.instagram.com/p/DeQGwHnxx8S/" },
    { field: "telegram", value: "https://t.me/example" },
  ]);
  assert.deepEqual(
    links.map((link) => link.postKey).sort(),
    ["instagram:DeQGwHnxx8S", "x:@flowerdexsol", "x:@garycatx", "x:@thedevrrrrrrr", "x:2108339994217922771"].sort(),
  );
});

test("a description link is indirect and a dedicated field is exact", () => {
  assert.equal(classifyLink("twitter", true), "exact");
  assert.equal(classifyLink("website", true), "exact");
  assert.equal(classifyLink("description", true), "indirect");
  assert.equal(classifyLink("twitter", false), "historical");
  assert.equal(strongestClass(["indirect", "historical", "exact"]), "exact");
  assert.equal(strongestClass(["indirect"]), "indirect");
});
test("a changed social link keeps the old post as history instead of deleting it", () => {
  assert.deepEqual(keysDropped(["x:1", "x:2"], new Set(["x:2"])), ["x:1"]);
  assert.deepEqual(keysDropped(["x:1"], new Set(["x:1"])), []);
  assert.deepEqual(keysDropped(["instagram:abc"], new Set()), ["instagram:abc"]);
});
