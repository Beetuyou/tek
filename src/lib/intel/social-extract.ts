import { linkOriginFor } from "./history-plan.ts";
import { collectPostLinks } from "./post-key.ts";

export type SocialField = { field: string; value: string };

const SOCIAL_KEY = /^(twitter|x|website|websites|telegram|discord|description|url|link|links|social|socials)$/i;

function fieldName(key: string): string {
  const name = key.toLowerCase();
  if (name === "description") return "description";
  if (name === "website" || name === "websites") return "website";
  if (name === "twitter" || name === "x") return "twitter";
  if (name === "telegram") return "telegram";
  return "links";
}

/** Pull URL-bearing strings out of provider JSON, including nested pair info and metadata objects. */
export function socialFieldsFromPayload(payload: unknown): SocialField[] {
  const out: SocialField[] = [];
  const seen = new Set<string>();
  function push(field: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const id = `${field}:${trimmed}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ field, value: trimmed });
  }
  function walk(value: unknown, key: string, depth: number) {
    if (depth > 6 || out.length > 200) return;
    if (typeof value === "string") {
      const social = SOCIAL_KEY.test(key);
      if (social && (/^https?:\/\//i.test(value) || key.toLowerCase() === "description")) push(fieldName(key), value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, childKey, depth + 1);
    }
  }
  walk(payload, "root", 0);
  return out;
}

export function socialExcerpt(payload: unknown): string {
  return JSON.stringify(socialFieldsFromPayload(payload)).slice(0, 4000);
}

function asMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Token creation wins over pool creation. updated_at and ingestion times are ignored. */
export function launchTimeFromPayload(payload: unknown): { iso?: string; kind?: "token" | "pool" } {
  let tokenMs: number | undefined;
  let poolMs: number | undefined;
  function walk(value: unknown, key: string, depth: number) {
    if (depth > 6) return;
    const tokenKey = key === "created_timestamp" || key === "createdAt" || key === "created_at";
    const poolKey = key === "pairCreatedAt" || key === "pool_created_at";
    if (tokenKey) {
      const ms = asMillis(value);
      if (ms != null && tokenMs == null) tokenMs = ms;
    } else if (poolKey) {
      const ms = asMillis(value);
      if (ms != null && poolMs == null) poolMs = ms;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, childKey, depth + 1);
    }
  }
  walk(payload, "root", 0);
  if (tokenMs != null) return { iso: new Date(tokenMs).toISOString(), kind: "token" };
  if (poolMs != null) return { iso: new Date(poolMs).toISOString(), kind: "pool" };
  return {};
}

export function httpsMetadataUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return null;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function citingLinks(
  postKey: string,
  payloads: { source: string; body: unknown }[],
  createdAt?: string,
) {
  const links: { platform: string; postKey: string; rawUrl: string; source: string; linkField: string; linkOrigin?: string }[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    for (const link of collectPostLinks(socialFieldsFromPayload(payload.body))) {
      if (link.postKey !== postKey) continue;
      const id = `${payload.source}:${link.postKey}:${link.field}`;
      if (seen.has(id)) continue;
      seen.add(id);
      links.push({
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source: payload.source,
        linkField: link.field,
        linkOrigin: linkOriginFor({ source: payload.source, createdAt }),
      });
    }
  }
  return links;
}
