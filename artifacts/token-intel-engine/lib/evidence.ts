/**
 * Evidence Matching Module
 * Scores how strongly a token candidate is linked to the source social content.
 */

export interface TokenCandidate {
  address: string;
  chain: string;
  symbol: string;
  name: string;
  source: string;
  liquidityUsd?: number;
  marketCap?: number;
  socials?: { platform?: string; handle?: string; url?: string }[];
  imageUrl?: string;
  pairUrl?: string;
}

export interface Evidence {
  type: 'twitter_handle' | 'ticker_mention' | 'ca_in_text' | 'image_similarity' | 'profile_link' | 'name_similarity';
  score: number; // 0-1
  detail: string;
}

export interface ScoredCandidate extends TokenCandidate {
  evidence: Evidence[];
  confidence: number; // 0-1
}

export function scoreCandidate(
  candidate: TokenCandidate,
  context: {
    handle?: string;
    text?: string;
    tickers?: string[];
    cas?: string[];
  }
): ScoredCandidate {
  const evidence: Evidence[] = [];
  let total = 0;

  // Direct CA in text
  if (context.cas?.some(ca => ca.toLowerCase() === candidate.address.toLowerCase())) {
    evidence.push({ type: 'ca_in_text', score: 1.0, detail: 'Contract address appeared in source text' });
    total += 1.0;
  }

  // Twitter handle match in socials
  if (context.handle && candidate.socials) {
    const handleLower = context.handle.toLowerCase();
    const match = candidate.socials.some(s =>
      (s.handle || '').toLowerCase().includes(handleLower) ||
      (s.url || '').toLowerCase().includes(handleLower)
    );
    if (match) {
      evidence.push({ type: 'twitter_handle', score: 0.85, detail: `Socials reference @${context.handle}` });
      total += 0.85;
    }
  }

  // Ticker mention
  if (context.tickers?.some(t => t.toUpperCase() === candidate.symbol.toUpperCase())) {
    evidence.push({ type: 'ticker_mention', score: 0.7, detail: `$${candidate.symbol} mentioned in content` });
    total += 0.7;
  }

  // Name similarity (simple)
  if (context.handle && candidate.name.toLowerCase().includes(context.handle.toLowerCase())) {
    evidence.push({ type: 'name_similarity', score: 0.4, detail: 'Name contains handle' });
    total += 0.4;
  }

  const confidence = Math.min(1, total / 1.5); // normalize

  return { ...candidate, evidence, confidence };
}
