import { readChain, type ChainRead } from "./chain";
import { attachHistory, historyForContext } from "./history";
import { originPhrase } from "./history-plan";
import { findByPostKey, findByProfile, findByProfileLink, indexCoverage, startBackgroundIngest, type IndexedLink } from "./index-store";
import { indexerField, readJupiter } from "./indexers";
import { enrichMissingPost, type LiveEnrichment } from "./live-enrich";
import { classifyLink, postKeyFromUrl, profileKeyFromUrl, strongestClass, type MatchClass } from "./post-key";
import { pairToSeed, pairsForAddress, type DexPair } from "./providers";
import type { DiscoverResult, HistoryLink, IdentityField, IndexCoverage, MarketQuote, SearchDiagnostics, TokenHit } from "./types";
import { resolvePostUrl } from "./url-resolve";

function strongestOrigin(values: (string | undefined)[]): string {
  if (values.includes("launch")) return "launch";
  if (values.includes("current")) return "current";
  if (values.includes("later")) return "later";
  return "current";
}

function keepField(current: IdentityField | undefined, incoming: IdentityField | undefined, conflicts: string[]): IdentityField | undefined {
  if (!incoming?.value) return current;
  if (!current?.value) return incoming;
  if (current.value.toLowerCase() === incoming.value.toLowerCase()) return current;
  if (current.status === "verified" && incoming.status !== "verified") {
    conflicts.push(`${incoming.source} reports "${incoming.value}" instead of verified "${current.value}".`);
    return current;
  }
  if (incoming.status === "verified" && current.status !== "verified") return incoming;
  conflicts.push(`${incoming.source} reports "${incoming.value}" while ${current.source} reports "${current.value}".`);
  return current.status === "verified" ? current : incoming;
}

function fromChain(read: ChainRead): TokenHit {
  return {
    chain: read.chain,
    address: read.address,
    existence: read.existence,
    name: read.name,
    symbol: read.symbol,
    identityConflicts: [],
    marketStatus: read.existence === "provider_unavailable" ? "provider_unavailable" : "unavailable",
    markets: [],
    confidence: 0,
    relationship: "unverified",
    matchClass: "historical",
    evidence: [],
  };
}

async function enrichMarket(token: TokenHit, pair?: DexPair): Promise<TokenHit> {
  const conflicts = [...token.identityConflicts];
  let next = { ...token };
  if (pair) {
    const seed = pairToSeed(pair);
    if (seed) {
      const dexName = seed.name
        ? { value: seed.name, source: "dexscreener", retrievedAt: new Date().toISOString(), status: "indexer" as const }
        : undefined;
      const dexSymbol = seed.symbol
        ? { value: seed.symbol, source: "dexscreener", retrievedAt: new Date().toISOString(), status: "indexer" as const }
        : undefined;
      next.name = keepField(next.name, dexName, conflicts);
      next.symbol = keepField(next.symbol, dexSymbol, conflicts);
      next.twitter = seed.twitter || next.twitter;
      next.pairUrl = seed.pairUrl || next.pairUrl;
      next.dex = seed.dex || next.dex;
      if (seed.priceUsd != null) next.priceUsd = seed.priceUsd;
      if (seed.liquidityUsd != null) next.liquidityUsd = seed.liquidityUsd;
      if (seed.marketCap != null) next.marketCap = seed.marketCap;
      if (seed.change24h != null) next.change24h = seed.change24h;
      next.marketStatus = "available";
      next.marketSource = "dexscreener";
      if (!next.logo && seed.imageUrl) next.logo = seed.imageUrl;
    }
  }

  if (next.chain === "solana" && !pair && (next.priceUsd == null || !next.symbol?.value)) {
    try {
      const jup = await readJupiter(next.address);
      if (jup) {
        next.name = keepField(next.name, indexerField(jup.name, "jupiter"), conflicts);
        next.symbol = keepField(next.symbol, indexerField(jup.symbol, "jupiter"), conflicts);
        if (jup.launchpad && !next.launchpad) next.launchpad = jup.launchpad;
        if (jup.createdAt && !next.createdAt) next.createdAt = jup.createdAt;
        if (next.priceUsd == null && jup.usdPrice != null) next.priceUsd = jup.usdPrice;
        if (next.liquidityUsd == null && jup.liquidity != null) next.liquidityUsd = jup.liquidity;
        if (next.marketCap == null && jup.mcap != null) next.marketCap = jup.mcap;
        if (next.marketStatus !== "available" && (next.priceUsd != null || next.liquidityUsd != null || next.marketCap != null)) {
          next.marketStatus = "available";
          next.marketSource = "jupiter";
        }
      }
    } catch {
      if (next.marketStatus !== "available") next.marketStatus = "provider_unavailable";
    }
  }

  next.identityConflicts = conflicts;
  return next;
}

function quotesFrom(pairs: DexPair[]): MarketQuote[] {
  const seen = new Set<string>();
  const quotes: MarketQuote[] = [];
  for (const pair of [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))) {
    const id = pair.url || `${pair.dexId}:${pair.baseToken?.address}`;
    if (seen.has(id)) continue;
    seen.add(id);
    quotes.push({
      dex: pair.dexId,
      pairUrl: pair.url,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : undefined,
      liquidityUsd: pair.liquidity?.usd,
      marketCap: pair.marketCap,
      volume24h: pair.volume?.h24,
      change24h: pair.priceChange?.h24,
    });
  }
  return quotes;
}

function applyQuotes(token: TokenHit, quotes: MarketQuote[]): TokenHit {
  const best = quotes[0];
  if (!best) return { ...token, markets: [] };
  return {
    ...token,
    markets: quotes,
    pairUrl: best.pairUrl,
    dex: best.dex,
    priceUsd: best.priceUsd ?? token.priceUsd,
    liquidityUsd: best.liquidityUsd ?? token.liquidityUsd,
    marketCap: best.marketCap ?? token.marketCap,
    volume24h: best.volume24h ?? token.volume24h,
    change24h: best.change24h ?? token.change24h,
    marketStatus: "available",
    marketSource: "dexscreener",
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function historicalLine(coverage: IndexCoverage | null): string {
  if (!coverage) return "Coverage could not be read.";
  const pump = coverage.history.find((row) => row.provider === "pump.fun-30d");
  return `Index is the last 30 days. Oldest stored launch in that window: ${coverage.oldestLaunch?.slice(0, 19) || "none yet"}. ${pump?.note || coverage.note}`;
}

function baseDiagnostics(input: Partial<SearchDiagnostics> & Pick<SearchDiagnostics, "platform" | "normalization" | "normalizationDetail" | "failure">): SearchDiagnostics {
  return {
    postId: null,
    tokensSearched: 0,
    postLinksSearched: 0,
    historical: "Coverage was not loaded.",
    exactMatches: 0,
    indirectMatches: 0,
    historicalMatches: 0,
    profileMatches: 0,
    searchKind: "post",
    liveEnrichment: "not_attempted",
    liveEnrichmentDetail: "Live enrichment was not attempted.",
    sourceNotes: ["Indexed rows were searched. This is not every token on DexScreener, Pump.fun, or Birdeye."],
    ...input,
  };
}

function rowClass(row: IndexedLink, exactKey: string | null, mode: "post" | "profile"): MatchClass {
  if (!row.current) return "historical";
  if (mode === "profile") return row.linkField === "description" ? "indirect" : "profile";
  if (exactKey && row.postKey === exactKey) return classifyLink(row.linkField, true);
  return row.linkField === "description" ? "indirect" : "profile";
}

function dedupeLinks(rows: IndexedLink[]): IndexedLink[] {
  const seen = new Set<string>();
  const out: IndexedLink[] = [];
  for (const row of rows) {
    const id = `${row.chain}:${row.address}:${row.postKey}:${row.source}:${row.linkField}:${row.rawUrl}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function groupRows(rows: IndexedLink[]) {
  const grouped = new Map<string, IndexedLink[]>();
  for (const row of rows) {
    const address = row.chain === "solana" ? row.address : row.address.toLowerCase();
    const id = `${row.chain}:${address}`;
    grouped.set(id, [...(grouped.get(id) || []), row]);
  }
  return grouped;
}

export async function runDiscovery(url: string, pasted?: string, history: HistoryLink[] = []): Promise<DiscoverResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const normalized = await resolvePostUrl(url);
  const emptyExtracted = { cas: [] as string[], tickers: [] as string[], links: [] as string[] };
  const profile = normalized.kind === "profile" ? profileKeyFromUrl(normalized.canonical || url) : null;
  if (!profile && (!normalized.valid || !normalized.postId)) {
    const unresolved = normalized.state === "unresolved" || normalized.state === "needs_resolution";
    return {
      source: {
        platform: normalized.platform,
        canonical: normalized.canonical,
        handle: normalized.handle,
        text: pasted?.trim() || "",
        fetched: false,
        access: "inaccessible",
      },
      extracted: emptyExtracted,
      tokens: [],
      warnings: [normalized.error || "Paste an X, TikTok, or Instagram post or profile link."],
      outcome: unresolved ? "unresolved" : "invalid",
      coverage: null,
      diagnostics: baseDiagnostics({
        platform: normalized.platform,
        postId: null,
        normalization: unresolved ? "unresolved" : "invalid",
        normalizationDetail: normalized.error || "The URL is not one post.",
        failure: unresolved
          ? "The TikTok link looks real but did not resolve to a video id. It was not treated as invalid."
          : "The URL is not a supported post or profile.",
      }),
      durationMs: Date.now() - started,
    };
  }

  const key = profile ? null : postKeyFromUrl(normalized.canonical);
  if (!key && !profile) {
    return {
      source: { platform: normalized.platform, canonical: normalized.canonical, text: "", fetched: false, access: "inaccessible" },
      extracted: emptyExtracted,
      tokens: [],
      warnings: ["That URL does not identify one post or profile."],
      outcome: "invalid",
      coverage: null,
      diagnostics: baseDiagnostics({
        platform: normalized.platform,
        normalization: "invalid",
        normalizationDetail: "The URL did not produce a post id or a profile.",
        failure: "Normalization did not yield a post or profile.",
      }),
      durationMs: Date.now() - started,
    };
  }

  const mode = profile ? "profile" : "post";
  const postAuthor = mode === "post" ? profileKeyFromUrl(normalized.canonical || url) : null;
  startBackgroundIngest();

  let coverage = await indexCoverage().catch(() => null);
  let postRows = mode === "post" && key ? await findByPostKey(key.key) : [];
  let profileRows = profile
    ? await findByProfile(profile.platform, profile.handle)
    : postAuthor
      ? await findByProfileLink(postAuthor.platform, postAuthor.handle)
      : [];
  const hadPost = postRows.length > 0;
  let rows = dedupeLinks([...postRows, ...profileRows]);
  let enrichment: LiveEnrichment = {
    attempted: false,
    status: "not_attempted",
    detail: mode === "profile"
      ? profileRows.length
        ? "Live enrichment was not attempted. A profile search uses indexed metadata that already cites this account."
        : "Profile search does not open the account feed. A coin matches only when stored metadata cites this profile or a post on it."
      : hadPost
        ? "Live enrichment was not attempted because the index already had a stored link for this post."
        : "Live enrichment was not attempted.",
    errors: [],
    hints: [],
    confirmed: 0,
    rejected: [],
  };
  if (!hadPost && mode === "post" && key) {
    try {
      enrichment = await enrichMissingPost({
        platform: normalized.platform,
        handle: postAuthor?.handle || normalized.handle,
        postId: key.postId,
        postKey: key.key,
      });
      if (enrichment.confirmed > 0) postRows = await findByPostKey(key.key);
      if (postAuthor && enrichment.attempted) profileRows = await findByProfileLink(postAuthor.platform, postAuthor.handle);
      rows = dedupeLinks([...postRows, ...profileRows]);
      if (enrichment.confirmed > 0 || profileRows.length) coverage = await indexCoverage().catch(() => coverage);
    } catch (err) {
      enrichment = {
        attempted: true,
        status: "failed",
        detail: "Live enrichment failed before metadata could be checked.",
        errors: [err instanceof Error ? err.message : "enrichment failed"],
        hints: [],
        confirmed: 0,
        rejected: [],
      };
    }
  }

  const grouped = groupRows(rows);
  const tokens = await mapLimit([...grouped.values()], 4, async (group) => {
    const first = group[0];
    const read = await readChain(first.address);
    if (read.existence === "provider_unavailable") {
      warnings.push(`Provider unavailable: could not verify ${first.address}.`);
    }
    let token = fromChain(read.existence === "verified" ? read : { ...read, chain: first.chain });
    const conflicts = [...token.identityConflicts];
    const indexedName = indexerField(first.name, first.launchpad || "indexed-metadata");
    const indexedSymbol = indexerField(first.symbol, first.launchpad || "indexed-metadata");
    token.name = keepField(token.name, indexedName, conflicts);
    token.symbol = keepField(token.symbol, indexedSymbol, conflicts);
    token.identityConflicts = conflicts;
    token.logo = first.logo || token.logo;
    token.launchpad = first.launchpad || (first.address.toLowerCase().endsWith("pump") ? "pump.fun" : token.launchpad);
    token.launchpadUrl = first.dexUrl?.includes("pump.fun")
      ? first.dexUrl
      : token.launchpad === "pump.fun"
        ? `https://pump.fun/coin/${first.address}`
        : undefined;
    token.createdAt = first.createdAt || token.createdAt;
    if (first.marketCap != null && !Number.isNaN(first.marketCap)) {
      token.marketCap = first.marketCap;
      token.marketStatus = "available";
      token.marketSource = first.launchpad || "indexed-metadata";
    }
    const classes = group.map((row) => rowClass(row, key?.key || null, mode));
    const matchClass = strongestClass(classes);
    token.matchClass = matchClass;
    token.linkOrigin = strongestOrigin(group.map((row) => row.linkOrigin));
    token.evidence = group.map((row) => {
      const klass = rowClass(row, key?.key || null, mode);
      const onPost = /\/status\/|\/video\/|\/photo\/|\/reel\/|\/p\//i.test(row.rawUrl);
      const label = klass === "exact"
        ? "Exact match"
        : klass === "profile"
          ? "Profile match"
          : klass === "indirect"
            ? mode === "profile" ? "Indirect profile reference" : "Indirect exact-post reference"
            : "Historical";
      const verb = klass === "profile"
        ? onPost ? "cites a post on this profile" : "cites this profile"
        : klass === "indirect"
          ? mode === "profile" ? "mentions this profile inside the text" : "mentions this post inside the text"
          : klass === "historical"
            ? mode === "profile" ? "previously cited this profile" : "previously contained this post"
            : "is this exact post";
      return {
        kind: klass === "historical" ? "historical" as const : klass === "profile" ? "author_social" as const : "indexed_post" as const,
        score: klass === "exact" || klass === "profile" ? 1 : 0.8,
        detail: `${label}. ${row.source} field "${row.linkField}" ${verb}: ${row.rawUrl}. Link ${originPhrase(row.linkOrigin)}.`,
      };
    });
    token.relationship = matchClass === "historical" ? "historical" : "verified";
    token.confidence = matchClass === "exact" || matchClass === "profile" ? 1 : 0.8;
    let pairs: DexPair[] = [];
    try {
      pairs = await pairsForAddress(first.address);
    } catch (err) {
      warnings.push(`Provider unavailable: market lookup failed for ${first.address.slice(0, 6)}… (${err instanceof Error ? err.message : "error"}).`);
      if (token.marketStatus === "unavailable") token.marketStatus = "provider_unavailable";
    }
    token = await enrichMarket(token, pairs[0]);
    const quotes = quotesFrom(pairs);
    if (quotes.length) token = applyQuotes(token, quotes);
    return token;
  });

  const pastedText = "";
  const extracted = { cas: [] as string[], tickers: [] as string[], links: [] as string[] };
  const relevant = historyForContext(history, undefined, normalized.canonical);
  const withHistory = tokens.map((token) => attachHistory(token, relevant));
  const rank: Record<MatchClass, number> = { exact: 0, profile: 1, indirect: 2, historical: 3 };
  withHistory.sort((a, b) => rank[a.matchClass] - rank[b.matchClass] || (b.liquidityUsd || 0) - (a.liquidityUsd || 0));

  if (withHistory.length === 0) {
    warnings.push("No indexed matches found");
    warnings.push(
      mode === "profile"
        ? "Coverage may be incomplete. A profile match is a stored coin whose metadata cites this account, or a post on this account. This does not mean no coin exists."
        : postAuthor
          ? "Coverage may be incomplete. A coin is returned when a stored record cites that exact post, or cites this account's profile. This does not mean no coin exists."
          : "Coverage may be incomplete. A post is returned only when a stored token record cites that exact post. This link has no account name, so profile links were not searched. This does not mean no coin exists.",
    );
    warnings.push(
      mode === "profile"
        ? "Quick search checks coins launched in the last 30 days. Deep search keeps walking public lists and stores profile links it finds. Those lists do not contain every coin from the month."
        : "Quick search checks coins launched in the last 30 days that are already indexed and, for an X post, contract addresses written in the post. A post search also keeps coins that cite the account's profile. Deep search walks the public lists. Those lists do not contain every coin from the month.",
    );
    for (const note of enrichment.rejected) warnings.push(note);
    for (const error of enrichment.errors) warnings.push(error);
  }

  const exactMatches = withHistory.filter((token) => token.matchClass === "exact").length;
  const indirectMatches = withHistory.filter((token) => token.matchClass === "indirect").length;
  const historicalMatches = withHistory.filter((token) => token.matchClass === "historical").length;
  const profileMatches = withHistory.filter((token) => token.matchClass === "profile").length;
  const failure = withHistory.length
    ? mode === "profile"
      ? "Stored index rows cite this profile."
      : exactMatches
        ? hadPost
          ? "Stored index rows matched this post id."
          : "No stored row existed. Live enrichment confirmed the post in fetched token metadata and stored it."
        : profileMatches
          ? "No stored row cited this exact post. Stored rows cite this account's profile."
          : indirectMatches
            ? "Stored rows mention this post or profile inside a description."
            : "Stored rows previously cited this post or profile."
    : mode === "profile"
      ? "No stored row cites this profile."
      : enrichment.rejected.length
        ? "No stored row cited this post or this account's profile. Metadata was fetched for addresses named in the post and did not cite either."
        : enrichment.status === "failed"
          ? "No stored row cited this post or this account's profile, and live enrichment could not read the source post or a provider."
          : postAuthor
            ? "No stored row cited this post or this account's profile."
            : "No stored row cited this post.";

  return {
    source: {
      platform: normalized.platform,
      canonical: normalized.canonical,
      handle: normalized.handle,
      postId: normalized.postId,
      text: pastedText,
      fetched: false,
      provider: "reverse-index",
      access: pastedText ? "pasted" : "inaccessible",
    },
    extracted,
    tokens: withHistory,
    warnings,
    outcome: withHistory.length ? "matches" : "none",
    coverage,
    diagnostics: baseDiagnostics({
      platform: normalized.platform,
      postId: normalized.postId,
      normalization: "resolved",
      normalizationDetail: profile
        ? `Profile @${profile.handle} on ${profile.platform}. Post ids on this account are included. The account name alone is not a match.`
        : postAuthor
          ? `Post id ${normalized.postId} on ${normalized.platform}. Also searched coins whose metadata cites @${postAuthor.handle}.`
          : `Post id ${normalized.postId} on ${normalized.platform}. This link has no account name, so profile links were not searched.`,
      tokensSearched: coverage?.tokens ?? 0,
      postLinksSearched: coverage?.postLinks ?? 0,
      historical: historicalLine(coverage),
      exactMatches,
      indirectMatches,
      historicalMatches,
      profileMatches,
      searchKind: mode,
      liveEnrichment: enrichment.status,
      liveEnrichmentDetail: enrichment.detail,
      sourceNotes: [
        "Indexed rows were searched. This is not every token on DexScreener, Pump.fun, or Birdeye.",
        ...enrichment.errors.map((error) => `Provider: ${error}`),
        ...enrichment.rejected,
      ],
      failure,
    }),
    durationMs: Date.now() - started,
  };
}
