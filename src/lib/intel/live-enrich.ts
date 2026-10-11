import { extractSignals } from "./extract";
import { linkOriginFor } from "./history-plan";
import { indexObservedToken } from "./index-store";
import { isAccountProfileUrl, collectPostLinks } from "./post-key";
import { fetchXPost, pairsForAddress } from "./providers";
import { citingLinks, httpsMetadataUrl, launchTimeFromPayload, socialExcerpt, socialFieldsFromPayload } from "./social-extract";

const SKIP = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type Payload = { source: string; body: unknown };

export type LiveEnrichment = {
  attempted: boolean;
  status: "not_attempted" | "attempted" | "failed";
  detail: string;
  errors: string[];
  hints: string[];
  confirmed: number;
  rejected: string[];
};

async function readPump(address: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 TekIntel/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`pump.fun HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function readMetadata(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "TekIntel/1.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status !== 200) throw new Error(`metadata HTTP ${res.status}`);
  return res.json();
}

function identityFrom(payloads: Payload[], address: string) {
  let chain = address.startsWith("0x") ? "" : "solana";
  let name: string | undefined;
  let symbol: string | undefined;
  let logo: string | undefined;
  let dexUrl: string | undefined;
  let launchpad: string | undefined;
  let marketCap: number | undefined;
  let createdAt: string | undefined;
  let createdKind: string | undefined;
  for (const payload of payloads) {
    const launch = launchTimeFromPayload(payload.body);
    if (launch.iso && (!createdAt || (createdKind !== "token" && launch.kind === "token"))) {
      createdAt = launch.iso;
      createdKind = launch.kind;
    }
    const body = payload.body;
    if (!body || typeof body !== "object") continue;
    const record = body as Record<string, unknown>;
    if (typeof record.name === "string" && !name) name = record.name;
    if (typeof record.symbol === "string" && !symbol) symbol = record.symbol;
    if (typeof record.image_uri === "string" && !logo) logo = record.image_uri;
    if (typeof record.mint === "string") launchpad = "pump.fun";
    if (typeof record.usd_market_cap === "number") marketCap = record.usd_market_cap;
    const pairs = record.pairs;
    if (!Array.isArray(pairs)) continue;
    const pair = pairs.find((item) => {
      const base = (item as { baseToken?: { address?: string } } | null)?.baseToken?.address;
      return base && base.toLowerCase() === address.toLowerCase();
    }) as {
      chainId?: string;
      url?: string;
      marketCap?: number;
      baseToken?: { name?: string; symbol?: string };
      info?: { imageUrl?: string };
    } | undefined;
    if (!pair) continue;
    if (pair.chainId) chain = pair.chainId;
    dexUrl = pair.url || dexUrl;
    name = name || pair.baseToken?.name;
    symbol = symbol || pair.baseToken?.symbol;
    logo = logo || pair.info?.imageUrl;
    if (marketCap == null && typeof pair.marketCap === "number") marketCap = pair.marketCap;
  }
  if (!chain) chain = "solana";
  if (address.toLowerCase().endsWith("pump")) launchpad = launchpad || "pump.fun";
  if (!dexUrl && launchpad === "pump.fun") dexUrl = `https://pump.fun/coin/${address}`;
  return { chain, name, symbol, logo, dexUrl, launchpad, marketCap, createdAt };
}

function authorProfileLinks(platform: string, handle: string | undefined, payloads: Payload[], createdAt?: string) {
  if (!handle || handle.toLowerCase() === "i") return [];
  const want = `${platform}:@${handle.toLowerCase()}`;
  const links: { platform: string; postKey: string; rawUrl: string; source: string; linkField: string; linkOrigin?: string }[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    for (const link of collectPostLinks(socialFieldsFromPayload(payload.body))) {
      if (link.postKey !== want || !isAccountProfileUrl(link.rawUrl, platform, handle)) continue;
      const id = `${payload.source}:${link.postKey}:${link.field}`;
      if (seen.has(id)) continue;
      seen.add(id);
      links.push({
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source: payload.source,
        linkField: link.field,
        linkOrigin: linkOriginFor({ source: payload.source, createdAt }),
      });
    }
  }
  return links;
}

/**
 * When the index has no row for an X post, read that post and fetch metadata only for
 * contract addresses written in it. A token is stored when those fields cite the same
 * post id, or cite that account's profile. An address in the text is not itself a match.
 */
export async function enrichMissingPost(input: {
  platform: string;
  handle?: string;
  postId: string;
  postKey: string;
}): Promise<LiveEnrichment> {
  if (input.platform !== "x") {
    return {
      attempted: false,
      status: "not_attempted",
      detail: "Live enrichment was not attempted. It only reads an X post for contract addresses, then checks those tokens' metadata. TikTok and Instagram captions are not fetched.",
      errors: [],
      hints: [],
      confirmed: 0,
      rejected: [],
    };
  }
  const errors: string[] = [];
  let text = "";
  try {
    text = (await fetchXPost(input.handle || "i", input.postId)).text || "";
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "X post text unavailable");
  }
  if (!text) {
    return {
      attempted: true,
      status: "failed",
      detail: "The index has no stored link for this post. The X post text could not be read, so no token metadata was fetched from a contract hint. DexScreener has no reverse search by status id, and its latest pages are not a full catalog.",
      errors,
      hints: [],
      confirmed: 0,
      rejected: [],
    };
  }
  const hints = extractSignals(text).cas.filter((address) => !SKIP.has(address)).slice(0, 3);
  if (!hints.length) {
    return {
      attempted: true,
      status: "attempted",
      detail: "The X post was read and did not name a contract address. No extra token metadata was fetched. The index still has no stored link for this post.",
      errors,
      hints: [],
      confirmed: 0,
      rejected: [],
    };
  }
  let confirmed = 0;
  let profileStored = 0;
  const rejected: string[] = [];
  for (const address of hints) {
    const payloads: Payload[] = [];
    try {
      const pairs = await pairsForAddress(address);
      payloads.push({ source: "dexscreener-token", body: { pairs } });
    } catch (err) {
      errors.push(`DexScreener ${address.slice(0, 6)}…: ${err instanceof Error ? err.message : "failed"}`);
    }
    if (!address.startsWith("0x")) {
      try {
        const coin = await readPump(address);
        payloads.push({ source: "pump.fun-coin", body: coin });
        const metaUrl = httpsMetadataUrl(coin.metadata_uri);
        if (metaUrl) {
          try {
            payloads.push({ source: "metadata-uri", body: await readMetadata(metaUrl) });
          } catch (err) {
            errors.push(`metadata URI: ${err instanceof Error ? err.message : "failed"}`);
          }
        }
      } catch (err) {
        errors.push(`pump.fun ${address.slice(0, 6)}…: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    if (!payloads.length) {
      rejected.push(`${address}: provider metadata could not be fetched`);
      continue;
    }
    const id = identityFrom(payloads, address);
    const postLinks = citingLinks(input.postKey, payloads, id.createdAt);
    const profileLinks = authorProfileLinks(input.platform, input.handle, payloads, id.createdAt);
    const seen = new Set(postLinks.map((link) => `${link.source}:${link.postKey}:${link.linkField}`));
    const links = [...postLinks];
    for (const link of profileLinks) {
      const key = `${link.source}:${link.postKey}:${link.linkField}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
    const excerpt = payloads.map((payload) => `${payload.source}:${socialExcerpt(payload.body)}`).join("\n").slice(0, 4000);
    if (!links.length) {
      rejected.push(`${address}: fetched metadata did not cite this post or this account's profile`);
      await indexObservedToken({ ...id, address, metaExcerpt: excerpt, links: [] }).catch((err) => {
        errors.push(err instanceof Error ? err.message : "could not store token");
      });
      continue;
    }
    await indexObservedToken({ ...id, address, metaExcerpt: excerpt, links });
    if (postLinks.length) confirmed += 1;
    else profileStored += 1;
  }
  const detail = confirmed
    ? `Live enrichment fetched metadata for ${hints.length} address${hints.length === 1 ? "" : "es"} named in the X post. ${confirmed} cited this exact post and ${confirmed === 1 ? "was" : "were"} stored. This did not scan every token on DexScreener, Pump.fun, or Birdeye.`
    : profileStored
      ? `Live enrichment fetched metadata for ${hints.length} address${hints.length === 1 ? "" : "es"} named in the X post. None cited this exact post. ${profileStored} cited this account's profile and ${profileStored === 1 ? "was" : "were"} stored.`
      : `Live enrichment fetched metadata for ${hints.length} address${hints.length === 1 ? "" : "es"} named in the X post. None of those fields cited this exact post or this account's profile, so nothing was returned as a match.`;
  return {
    attempted: true,
    status: errors.length && !confirmed && !profileStored ? "failed" : "attempted",
    detail,
    errors,
    hints,
    confirmed,
    rejected,
  };
}
