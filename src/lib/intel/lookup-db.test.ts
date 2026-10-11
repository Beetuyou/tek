import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("the database returns every stored token from the last 30 days for one post, and skips older tokens and tokens with no social link", async () => {
  const vite = await createServer({
    root: "/workspace",
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const store = (await vite.ssrLoadModule("/src/lib/intel/index-store.ts")) as {
      indexObservedToken: (token: {
        chain: string;
        address: string;
        name?: string;
        createdAt?: string;
        links: { platform: string; postKey: string; rawUrl: string; source: string; linkField: string; linkOrigin?: string }[];
      }) => Promise<void>;
      findByPostKey: (postKey: string) => Promise<{ address: string; createdAt?: string; rawUrl: string }[]>;
      findByProfile: (platform: string, handle: string) => Promise<{ address: string; rawUrl: string }[]>;
      findByProfileLink: (platform: string, handle: string) => Promise<{ address: string; rawUrl: string }[]>;
    };
    const postKey = "x:424242";
    const now = Date.now();
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    const withinMonth = new Date(now - 20 * 86_400_000).toISOString();
    const tooOld = new Date(now - 40 * 86_400_000).toISOString();
    await store.indexObservedToken({
      chain: "solana",
      address: "RecentMint11111111111111111111111111111111",
      name: "Recent",
      createdAt: recent,
      links: [{ platform: "x", postKey, rawUrl: "https://x.com/a/status/424242?s=20", source: "dexscreener-token", linkField: "links", linkOrigin: "current" }],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "MonthMint11111111111111111111111111111111",
      name: "Month",
      createdAt: withinMonth,
      links: [{ platform: "x", postKey, rawUrl: "https://twitter.com/a/status/424242", source: "pump.fun-coin", linkField: "twitter", linkOrigin: "current" }],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "OldMint1111111111111111111111111111111111",
      name: "Old",
      createdAt: tooOld,
      links: [{ platform: "x", postKey, rawUrl: "https://twitter.com/a/status/424242", source: "pump.fun-coin", linkField: "twitter", linkOrigin: "current" }],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "SilentMint111111111111111111111111111111",
      name: "No social",
      createdAt: recent,
      links: [],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "ProfileMint11111111111111111111111111111",
      name: "Profile only",
      createdAt: recent,
      links: [{ platform: "x", postKey: "x:@somecoin", rawUrl: "https://x.com/somecoin", source: "pump.fun-coin", linkField: "twitter", linkOrigin: "current" }],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "TikTokMint11111111111111111111111111111",
      name: "TikTok profile",
      createdAt: recent,
      links: [{ platform: "tiktok", postKey: "tiktok:@clipcoin", rawUrl: "https://www.tiktok.com/@clipcoin", source: "pump.fun-coin", linkField: "website", linkOrigin: "current" }],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "InstaMint111111111111111111111111111111",
      name: "Instagram profile",
      createdAt: recent,
      links: [{ platform: "instagram", postKey: "instagram:@reelcoin", rawUrl: "https://www.instagram.com/reelcoin/", source: "pump.fun-coin", linkField: "website", linkOrigin: "current" }],
    });
    await store.indexObservedToken({
      chain: "solana",
      address: "DualMint1111111111111111111111111111111",
      name: "Post stored under profile key",
      createdAt: recent,
      links: [{ platform: "x", postKey: "x:@a", rawUrl: "https://x.com/a/status/424242", source: "dexscreener-token", linkField: "twitter", linkOrigin: "current" }],
    });
    const rows = await store.findByPostKey(postKey);
    assert.deepEqual(rows.map((row) => row.address).sort(), [
      "MonthMint11111111111111111111111111111111",
      "RecentMint11111111111111111111111111111111",
    ]);
    assert.equal(rows.find((row) => row.address.startsWith("Month"))?.createdAt?.slice(0, 10), withinMonth.slice(0, 10));
    assert.match(rows.find((row) => row.address.startsWith("Recent"))?.rawUrl || "", /status\/424242/);
    assert.equal((await store.findByPostKey("x:not-a-real-post")).length, 0);
    const fromPosts = await store.findByProfile("x", "a");
    assert.deepEqual(fromPosts.map((row) => row.address).sort(), [
      "DualMint1111111111111111111111111111111",
      "MonthMint11111111111111111111111111111111",
      "RecentMint11111111111111111111111111111111",
    ]);
    const fromProfile = await store.findByProfile("x", "somecoin");
    assert.deepEqual(fromProfile.map((row) => row.address), ["ProfileMint11111111111111111111111111111"]);
    assert.equal((await store.findByPostKey("x:424242")).some((row) => row.address.startsWith("Profile")), false);
    assert.deepEqual((await store.findByProfileLink("x", "somecoin")).map((row) => row.address), ["ProfileMint11111111111111111111111111111"]);
    assert.deepEqual((await store.findByProfileLink("tiktok", "clipcoin")).map((row) => row.address), ["TikTokMint11111111111111111111111111111"]);
    assert.deepEqual((await store.findByProfileLink("instagram", "reelcoin")).map((row) => row.address), ["InstaMint111111111111111111111111111111"]);
    assert.equal((await store.findByProfileLink("x", "a")).length, 0);
  } finally {
    await vite.close();
  }
});
