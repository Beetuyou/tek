export type Platform = "x" | "tiktok" | "instagram" | "unknown";

export type EvidenceKind =
  | "ca_in_post"
  | "ca_in_link"
  | "ticker_match"
  | "author_social"
  | "indexed_post"
  | "historical";

export type Evidence = {
  kind: EvidenceKind;
  score: number;
  detail: string;
};

export type FieldStatus = "verified" | "indexer";

export type IdentityField = {
  value: string;
  source: string;
  retrievedAt: string;
  status: FieldStatus;
};

export type ExistenceStatus = "verified" | "not_found" | "provider_unavailable";
export type MarketStatus = "available" | "unavailable" | "provider_unavailable";
export type MatchClass = "exact" | "indirect" | "historical" | "profile";
export type RelationshipStatus = "verified" | "historical" | "unverified";

export type HistoryLink = {
  address: string;
  chain: string;
  handle?: string;
  url?: string;
  recordedAt: string;
};

export type MarketQuote = {
  dex?: string;
  pairUrl?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCap?: number;
  volume24h?: number;
  change24h?: number;
};

export type TokenHit = {
  chain: string;
  address: string;
  existence: ExistenceStatus;
  name?: IdentityField;
  symbol?: IdentityField;
  identityConflicts: string[];
  marketStatus: MarketStatus;
  marketSource?: string;
  pairUrl?: string;
  dex?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCap?: number;
  volume24h?: number;
  change24h?: number;
  markets: MarketQuote[];
  logo?: string;
  launchpad?: string;
  launchpadUrl?: string;
  createdAt?: string;
  twitter?: string;
  confidence: number;
  relationship: RelationshipStatus;
  matchClass: MatchClass;
  linkOrigin?: string;
  evidence: Evidence[];
};

export type SourcePost = {
  platform: Platform;
  canonical: string;
  handle?: string;
  postId?: string;
  text: string;
  fetched: boolean;
  provider?: string;
  access: "fetched" | "pasted" | "inaccessible";
};

export type IndexCoverage = {
  records: number;
  tokens: number;
  postLinks: number;
  chains: string[];
  platforms: { platform: string; posts: number }[];
  launchpads: string[];
  lastSuccess: string | null;
  progress: string;
  note: string;
  providers: { provider: string; ok: boolean; fetched: number; stored: number; error?: string; finishedAt: string }[];
  oldestLaunch: string | null;
  windows: { label: string; tokens: number; note: string }[];
  history: { provider: string; cursor: number; oldest: string | null; note: string | null }[];
  batches: { provider: string; ok: boolean; cursor: number; fetched: number; stored: number; error?: string; oldest?: string; finishedAt: string }[];
};

export type DiscoverOutcome = "matches" | "none" | "social_inaccessible" | "invalid" | "unresolved";

export type SearchDiagnostics = {
  platform: string;
  postId: string | null;
  normalization: "resolved" | "needs_resolution" | "unresolved" | "invalid";
  normalizationDetail: string;
  tokensSearched: number;
  postLinksSearched: number;
  historical: string;
  exactMatches: number;
  indirectMatches: number;
  historicalMatches: number;
  profileMatches: number;
  searchKind: "post" | "profile";
  liveEnrichment: "attempted" | "not_attempted" | "failed";
  liveEnrichmentDetail: string;
  sourceNotes: string[];
  failure: string;
};

export type DiscoverResult = {
  source: SourcePost;
  extracted: { cas: string[]; tickers: string[]; links: string[] };
  tokens: TokenHit[];
  warnings: string[];
  outcome: DiscoverOutcome;
  coverage: IndexCoverage | null;
  diagnostics: SearchDiagnostics;
  durationMs: number;
};
