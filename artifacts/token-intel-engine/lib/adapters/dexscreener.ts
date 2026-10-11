/**
 * DexScreener Adapter
 * Real public API integration. No API key required.
 */

const DEX_BASE = 'https://api.dexscreener.com';

export interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  fdv?: number;
  priceChange?: { h24?: number };
  url: string;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { platform?: string; handle?: string; url?: string }[];
  };
  pairCreatedAt?: number;
}

export async function searchDex(query: string, limit = 15): Promise<DexPair[]> {
  const res = await fetch(`${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error(`DexScreener search failed: ${res.status}`);
  const data = await res.json();
  const pairs: DexPair[] = data.pairs || [];
  return pairs
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
    .slice(0, limit);
}

export async function getPairsByToken(chain: string, address: string): Promise<DexPair[]> {
  const res = await fetch(`${DEX_BASE}/tokens/v1/${chain}/${address}`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];
  return (await res.json()) || [];
}

export async function getLatestProfiles(): Promise<any[]> {
  const res = await fetch(`${DEX_BASE}/token-profiles/latest/v1`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];
  return (await res.json()) || [];
}
