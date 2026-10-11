export type FetchedPost = {
  text: string;
  handle?: string;
  provider: string;
};

export type DexPair = {
  chainId: string;
  dexId?: string;
  url: string;
  priceUsd?: string;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
  priceChange?: { h24?: number };
  baseToken?: { address?: string; name?: string; symbol?: string };
  info?: {
    imageUrl?: string;
    websites?: { url?: string }[];
    socials?: { type?: string; platform?: string; url?: string; handle?: string }[];
  };
};

const TIMEOUT_MS = 9000;

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "TekIntel/1.0",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchXPost(handle: string, id: string): Promise<FetchedPost> {
  const errors: string[] = [];
  const mirrors = [
    `https://api.fxtwitter.com/${encodeURIComponent(handle)}/status/${id}`,
    `https://api.vxtwitter.com/${encodeURIComponent(handle)}/status/${id}`,
  ];

  for (const url of mirrors) {
    try {
      const data = (await getJson(url)) as {
        tweet?: { text?: string; author?: { screen_name?: string } };
        text?: string;
        user_screen_name?: string;
      };
      const text = data.tweet?.text || data.text;
      const author = data.tweet?.author?.screen_name || data.user_screen_name || handle;
      if (text && text.trim()) {
        return {
          text,
          handle: author.replace(/^@/, ""),
          provider: url.includes("fxtwitter") ? "fxtwitter" : "vxtwitter",
        };
      }
      errors.push(`${url} returned no text`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "fetch failed");
    }
  }

  try {
    const oembed = (await getJson(
      `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(`https://x.com/${handle}/status/${id}`)}`,
    )) as { html?: string; author_url?: string };
    const html = oembed.html || "";
    const text = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    const author = oembed.author_url?.match(/\/([^/]+)\/?$/)?.[1];
    if (text) return { text, handle: author || handle, provider: "oembed" };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "oembed failed");
  }

  throw new Error(`Could not read the X post (${errors.slice(0, 3).join("; ")})`);
}

function twitterFromPair(pair: DexPair): string | undefined {
  const socials = pair.info?.socials || [];
  for (const social of socials) {
    const kind = (social.type || social.platform || "").toLowerCase();
    const value = social.url || social.handle || "";
    if (kind.includes("twitter") || kind === "x" || /x\.com|twitter\.com/i.test(value)) {
      return value;
    }
  }
  return undefined;
}

export type DexSeed = {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  pairUrl: string;
  dex?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCap?: number;
  change24h?: number;
  imageUrl?: string;
  twitter?: string;
  website?: string;
};

export function pairToSeed(pair: DexPair): DexSeed | null {
  const address = pair.baseToken?.address;
  const symbol = pair.baseToken?.symbol;
  const name = pair.baseToken?.name;
  if (!address || !symbol || !name) return null;
  if (symbol === "SOL" || symbol === "WSOL" || symbol === "USDC" || symbol === "USDT" || symbol === "WETH") {
    return null;
  }
  return {
    chain: pair.chainId,
    address,
    symbol,
    name,
    pairUrl: pair.url,
    dex: pair.dexId,
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : undefined,
    liquidityUsd: pair.liquidity?.usd,
    marketCap: pair.marketCap,
    change24h: pair.priceChange?.h24,
    imageUrl: pair.info?.imageUrl,
    twitter: twitterFromPair(pair),
    website: pair.info?.websites?.[0]?.url,
  };
}

export async function searchDex(query: string): Promise<DexPair[]> {
  const data = (await getJson(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
  )) as { pairs?: DexPair[] };
  return data.pairs || [];
}

export async function pairsForAddress(address: string): Promise<DexPair[]> {
  const data = (await getJson(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`,
  )) as { pairs?: DexPair[] };
  return data.pairs || [];
}

export function bestPair(pairs: DexPair[]): DexPair | undefined {
  return [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}
