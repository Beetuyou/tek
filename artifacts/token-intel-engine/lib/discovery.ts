export async function discoverTokens(rawUrl: string, providedText?: string): Promise<DiscoveryResult> {
  const start = Date.now();
  const errors: string[] = [];
  const normalized = normalizeUrl(rawUrl);

  if (!normalized.isValid) {
    return {
      normalized,
      candidates: [],
      extracted: { cas: [], tickers: [] },
      errors: [normalized.error || 'Invalid URL'],
      durationMs: Date.now() - start,
    };
  }

  // Cache key
  const cacheKey = `discover:${normalized.canonical}:${providedText?.slice(0, 100) || ''}`;
  const cached = getCached<DiscoveryResult>(cacheKey);
  if (cached) return { ...cached, durationMs: Date.now() - start };

  // Fetch social content when possible
  let text = providedText || '';
  if (normalized.platform === 'x' && normalized.id && !text) {
    const post = await fetchXPost(normalized.id);
    if (post) {
      text = post.text;
      if (!normalized.handle && post.authorHandle) {
        normalized.handle = post.authorHandle;
      }
    } else {
      errors.push('Could not fetch X post (missing X_BEARER_TOKEN or API error). Paste text for better results.');
    }
  }

  const extracted = extractSignals(text);

  const rawCandidates: TokenCandidate[] = [];
  const seen = new Set<string>();

  // 1. Direct CA lookups via DexScreener
  for (const ca of extracted.cas) {
    try {
      const pairs = await searchDex(ca, 5);
      for (const p of pairs) {
        const key = `${p.chainId}:${p.baseToken.address}`;
        if (!seen.has(key)) {
          seen.add(key);
          rawCandidates.push(pairToCandidate(p, 'direct_ca'));
        }
      }
    } catch (e: any) {
      errors.push(`CA lookup failed for ${ca}: ${e.message}`);
    }
  }

  // 2. Ticker searches
  for (const ticker of extracted.tickers) {
    try {
      const pairs = await searchDex(ticker, 8);
      for (const p of pairs) {
        const key = `${p.chainId}:${p.baseToken.address}`;
        if (!seen.has(key)) {
          seen.add(key);
          rawCandidates.push(pairToCandidate(p, `ticker_${ticker}`));
        }
      }
    } catch (e: any) {
      errors.push(`Ticker search failed for ${ticker}: ${e.message}`);
    }
  }

  // 3. Handle-based search
  if (normalized.handle) {
    try {
      const pairs = await searchDex(normalized.handle, 10);
      for (const p of pairs) {
        const key = `${p.chainId}:${p.baseToken.address}`;
        if (!seen.has(key)) {
          seen.add(key);
          rawCandidates.push(pairToCandidate(p, 'handle_search'));
        }
      }
    } catch (e: any) {
      errors.push(`Handle search failed: ${e.message}`);
    }

    // Birdeye enrichment for Solana handle search
    try {
      const be = await searchBirdeye(normalized.handle);
      for (const t of be) {
        const key = `solana:${t.address}`;
        if (!seen.has(key)) {
          seen.add(key);
          rawCandidates.push({
            address: t.address,
            chain: 'solana',
            symbol: t.symbol || '',
            name: t.name || '',
            source: 'birdeye',
            liquidityUsd: t.liquidity,
            marketCap: t.mc,
            socials: t.twitter ? [{ platform: 'twitter', handle: t.twitter }] : undefined,
          });
        }
      }
    } catch (e: any) {
      errors.push(`Birdeye search failed: ${e.message}`);
    }
  }

  const candidates = rawCandidates
    .map(c => scoreCandidate(c, {
      handle: normalized.handle,
      text,
      tickers: extracted.tickers,
      cas: extracted.cas,
    }))
    .filter(c => c.confidence > 0.15)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  const result: DiscoveryResult = {
    normalized,
    candidates,
    extracted,
    errors,
    durationMs: Date.now() - start,
  };

  setCached(cacheKey, result, 5 * 60 * 1000);
  return result;
}