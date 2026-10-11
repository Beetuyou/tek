export type DeepSourceStatus = "pending" | "running" | "waiting" | "done" | "blocked" | "unavailable";

export type DeepSource = {
  id: string;
  label: string;
  status: DeepSourceStatus;
  cursor: number;
  scanned: number;
  metadataOk: number;
  matches: number;
  oldest?: string;
  newest?: string;
  note: string;
  retryAt?: number;
  fails?: number;
  marker?: string;
  measurable: boolean;
};

export type DeepHit = {
  chain: string;
  address: string;
  name?: string;
  symbol?: string;
  source: string;
  rawUrl: string;
  linkField: string;
  linkOrigin?: string;
  createdAt?: string;
};

export type DeepSearchView = {
  id: string;
  url: string;
  postKey: string | null;
  status: "running" | "waiting" | "complete" | "incomplete" | "missing";
  discovered: number;
  scanned: number;
  metadataOk: number;
  matches: number;
  oldestLaunch: string | null;
  newestLaunch: string | null;
  percent: number | null;
  note: string;
  errors: string[];
  sources: DeepSource[];
  hits: DeepHit[];
  updatedAt: string;
};

export const PUMP_PAGE = 50;

export type PumpWindow = {
  id: string;
  label: string;
  sort: "created_timestamp" | "market_cap" | "reply_count";
  order: "DESC" | "ASC";
  complete?: boolean;
  cap: number;
  kind: "time" | "slice";
};

/** Time-ordered lists stop at the first coin older than 30 days. The market-cap list is not chronological, so it is scanned to the end and only in-window coins are kept. Caps are a guard above the public ~1,050 row cutoff. */
export const PUMP_WINDOWS: PumpWindow[] = [
  { id: "pump-newest", label: "Pump.fun launches from the last 30 days", sort: "created_timestamp", order: "DESC", cap: 2000, kind: "time" },
  { id: "pump-graduated", label: "Pump.fun graduated coins from the last 30 days", sort: "created_timestamp", order: "DESC", complete: true, cap: 2000, kind: "time" },
  { id: "pump-bonding", label: "Pump.fun bonding-curve coins from the last 30 days", sort: "created_timestamp", order: "DESC", complete: false, cap: 2000, kind: "time" },
  { id: "pump-mcap", label: "Pump.fun top market-cap coins launched in the last 30 days", sort: "market_cap", order: "DESC", cap: 2000, kind: "slice" },
];

export const COVERAGE_LIMIT =
  "The index keeps tokens launched in the last 30 days only. Time-ordered pump.fun lists are walked until a coin is older than 30 days or the API returns an empty page. The market-cap list is scanned to the end and older coins are skipped. An empty page before 30 days means that list does not contain the rest of the month. 100% is the share of these lists that finished, not every memecoin.";

export const DEX_RATE_LIMIT_STRIKES = 3;
export const METADATA_ATTEMPT_LIMIT = 160;

/** Metadata checks stop on repeated rate limits or after a fixed number of reads, so a search cannot run forever. */
export function metadataBlock(input: { strikes: number; attempts: number }): "rate" | "budget" | null {
  if (input.strikes >= DEX_RATE_LIMIT_STRIKES) return "rate";
  if (input.attempts >= METADATA_ATTEMPT_LIMIT) return "budget";
  return null;
}
export function sourceFraction(source: DeepSource, cap: number): number {
  if (!source.measurable || source.status === "unavailable") return 0;
  if (source.status === "done" || source.status === "blocked") return 1;
  if (cap <= 0) return 0;
  return Math.min(0.99, source.scanned / cap);
}

export function overallPercent(sources: DeepSource[], caps: Record<string, number>): number | null {
  const rows = sources.filter((source) => source.measurable && source.status !== "unavailable");
  if (!rows.length) return null;
  const total = rows.reduce((sum, source) => sum + sourceFraction(source, caps[source.id] ?? 1), 0);
  return Math.round((100 * total) / rows.length);
}

export function afterPumpPage(cursor: number, pageSize: number, rowCount: number, cap: number): { next: number; ended: boolean; reason: "empty" | "cap" | "continue" } {
  if (rowCount <= 0) return { next: cursor, ended: true, reason: "empty" };
  const next = cursor + pageSize;
  if (next >= cap) return { next: cap, ended: true, reason: "cap" };
  return { next, ended: false, reason: "continue" };
}

export function pumpWindowNote(input: {
  label: string;
  kind: "time" | "slice";
  sort: string;
  scanned: number;
  oldest?: string;
  newest?: string;
  ended: boolean;
  reason?: "empty" | "cap" | "repeat" | "error" | "age";
}): string {
  const span = [input.oldest?.slice(0, 10), input.newest?.slice(0, 10)].filter(Boolean).join(" to ");
  const where = span ? ` (${span})` : "";
  if (!input.ended) {
    return `Still paging ${input.label}: ${input.scanned} rows${where}. Only tokens from the last 30 days are kept.`;
  }
  if (input.reason === "age") {
    return `${input.label} reached coins older than 30 days after ${input.scanned} rows${where}. Every newer coin returned by this list was indexed.`;
  }
  const stop =
    input.reason === "cap"
      ? "The walk stopped at the page guard."
      : input.reason === "repeat"
        ? "The API repeated the same page, so the walk stopped."
        : "The public list then returned an empty page.";
  if (input.kind === "slice") {
    return `${input.label} ended after ${input.scanned} rows${where}. Sorted by ${input.sort}, not by launch date. ${stop} These rows are not every token launched in that span.`;
  }
  return `${input.label} ended after ${input.scanned} rows${where}. ${stop} Not every token launched in the last 30 days is on this list.`;
}

export function initialSources(birdeye: boolean): DeepSource[] {
  const base = {
    cursor: 0,
    scanned: 0,
    metadataOk: 0,
    matches: 0,
    note: "Not started.",
    measurable: true,
    status: "pending" as const,
  };
  return [
    { ...base, id: "index", label: "Stored index" },
    { ...base, id: "post-hints", label: "Post text hints" },
    { ...base, id: "dex-search", label: "DexScreener search" },
    ...PUMP_WINDOWS.map((window) => ({ ...base, id: window.id, label: window.label })),
    { ...base, id: "dex-latest", label: "DexScreener latest pages" },
    { ...base, id: "gecko-new-pools", label: "GeckoTerminal new pools", cursor: 1 },
    {
      ...base,
      id: "birdeye",
      label: "Birdeye",
      status: birdeye ? "pending" : "unavailable",
      measurable: birdeye,
      note: birdeye
        ? "Key is set. The meme list used here is one recent page, not a full archive."
        : "API key not configured. Historical Birdeye listing is not connected.",
    },
    {
      ...base,
      id: "solana-program",
      label: "Solana pump program logs",
      measurable: false,
      note: "Not started. Signatures are not social links.",
    },
  ];
}

export const SOURCE_CAPS: Record<string, number> = {
  index: 1,
  "post-hints": 1,
  "dex-search": 1,
  "dex-latest": 5,
  "gecko-new-pools": 10,
  birdeye: 1,
  "solana-program": 1,
  ...Object.fromEntries(PUMP_WINDOWS.map((window) => [window.id, window.cap])),
};
