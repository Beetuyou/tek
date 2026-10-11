/**
 * Birdeye Adapter (Solana-focused)
 * Requires BIRDEYE_API_KEY
 */

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

export interface BirdeyeToken {
  address: string;
  symbol?: string;
  name?: string;
  liquidity?: number;
  mc?: number;
  price?: number;
  twitter?: string;
  website?: string;
}

export async function searchBirdeye(query: string): Promise<BirdeyeToken[]> {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return [];

  const res = await fetch(
    `${BIRDEYE_BASE}/defi/v3/token/list?sort_by=liquidity&sort_type=desc&offset=0&limit=10&keyword=${encodeURIComponent(query)}`,
    {
      headers: { 'X-API-KEY': key, 'x-chain': 'solana' },
      next: { revalidate: 60 },
    }
  );

  if (!res.ok) return [];
  const data = await res.json();
  return (data.data?.items || []).map((t: any) => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    liquidity: t.liquidity,
    mc: t.mc,
    price: t.price,
    twitter: t.twitter,
    website: t.website,
  }));
}
