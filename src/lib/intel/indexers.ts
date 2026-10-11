import type { IdentityField } from "./types";

export type JupiterToken = {
  id: string;
  name?: string;
  symbol?: string;
  launchpad?: string;
  createdAt?: string;
  usdPrice?: number;
  liquidity?: number;
  mcap?: number;
};

export async function readJupiter(mint: string): Promise<JupiterToken | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as JupiterToken[];
    return data.find((token) => token.id === mint) ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export function indexerField(value: string | undefined, source: string): IdentityField | undefined {
  if (!value) return undefined;
  return { value, source, retrievedAt: new Date().toISOString(), status: "indexer" };
}
