/** Historical backfill moves forward only after a non-empty successful page. Failures and empty pages keep the checkpoint. */
export function nextOffset(cursor: number, pageSize: number, ok: boolean, rowCount: number): number {
  if (!ok || rowCount <= 0) return cursor;
  return cursor + pageSize;
}

/** Index and search only keep tokens launched inside this window. */
export const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function isWithinMaxAge(iso?: string | null, now = Date.now()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  if (t > now + 120_000) return false;
  return now - t <= MAX_TOKEN_AGE_MS;
}

/** True only when the launch time is more than 30 days in the past. Future timestamps are not "older". */
export function isOlderThanMaxAge(iso?: string | null, now = Date.now()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now - t > MAX_TOKEN_AGE_MS;
}

/** Live pump.fun scan owns offsets below this. History starts here so the two workers do not share a cursor. */
export const PUMP_HISTORY_START = 800;

/** GeckoTerminal new_pools is documented as a short recent list, about 10 pages, not a dated archive. */
export const GECKO_HISTORY_MAX_PAGE = 10;

export function windowNote(label: string): string {
  return `Indexed tokens with a known launch time in ${label}. This is not every token launched then.`;
}

export type LinkOrigin = "launch" | "current" | "later";

export function originPhrase(origin: string | undefined): string {
  if (origin === "launch") return "seen in launch metadata";
  if (origin === "later") return "first observed on a later profile, not in the launch record";
  return "seen on the current profile; launch-time metadata was not separately available";
}

/**
 * Pump list fields are mutable, so they are "current" unless an immutable metadata URI actually contains the URL.
 * A DEX or Gecko profile on a token older than six hours is "later", not launch.
 */
export function linkOriginFor(input: {
  source: string;
  createdAt?: string;
  inLaunchMetadata?: boolean;
  now?: number;
}): LinkOrigin {
  if (input.inLaunchMetadata) return "launch";
  const created = input.createdAt ? Date.parse(input.createdAt) : Number.NaN;
  const ageMs = Number.isFinite(created) ? (input.now ?? Date.now()) - created : 0;
  const profileSource =
    input.source.startsWith("dexscreener") || input.source === "geckoterminal" || input.source === "birdeye";
  if (profileSource && ageMs > 6 * 3_600_000) return "later";
  return "current";
}

export function agePhrase(createdAt: string | undefined, now = Date.now()): string | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  const ms = Math.max(0, now - t);
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) {
    if (hours <= 1) return "about 1 hour old";
    return `${hours} hours old`;
  }
  const days = Math.round(ms / 86_400_000);
  if (days < 60) return days === 1 ? "1 day old" : `${days} days old`;
  const months = Math.max(1, Math.round(days / 30));
  return months === 1 ? "about 1 month old" : `about ${months} months old`;
}

/** Every indexed row is a hit. Age and liquidity never drop a match. */
export function retainIndexedRows<T extends { address: string }>(rows: T[]): T[] {
  return rows.filter((row) => row.address.length > 0);
}
