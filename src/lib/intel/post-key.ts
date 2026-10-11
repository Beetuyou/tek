import { normalizeLink, profileFromUrl } from "./normalize.ts";

export function postKeyFromUrl(raw: string): { key: string; platform: string; canonical: string; postId: string } | null {
  const link = normalizeLink(raw);
  if (!link.valid || !link.postId || link.kind === "profile") return null;
  return {
    key: `${link.platform}:${link.postId}`,
    platform: link.platform,
    canonical: link.canonical,
    postId: link.postId,
  };
}

export type ProfileKey = { key: string; platform: string; handle: string; canonical: string };

function profileKey(platform: string, handle: string): ProfileKey {
  const name = handle.toLowerCase();
  const canonical = platform === "x"
    ? `https://x.com/${handle}`
    : platform === "tiktok"
      ? `https://www.tiktok.com/@${handle}`
      : `https://www.instagram.com/${handle}/`;
  return { key: `${platform}:@${name}`, platform, handle: name, canonical };
}

/** True when the URL is the account itself, not a status, video, photo, or reel. */
export function isAccountProfileUrl(raw: string, platform: string, handle: string): boolean {
  const profile = profileFromUrl(raw);
  return Boolean(profile && profile.platform === platform && profile.handle.toLowerCase() === handle.toLowerCase());
}

/** Account link, or the account that owns a post URL. Not a status, video, or reel id. */
export function profileKeyFromUrl(raw: string): ProfileKey | null {
  const direct = profileFromUrl(raw);
  if (direct) return profileKey(direct.platform, direct.handle);
  const post = normalizeLink(raw);
  if (!post.valid || !post.postId || !post.handle || post.kind === "profile") return null;
  if (post.platform === "x" && post.handle.toLowerCase() === "i") return null;
  return profileKey(post.platform, post.handle);
}

function looseProfile(field: string, value: string): ProfileKey | null {
  const name = field.toLowerCase();
  const platform = name === "twitter" || name === "x" ? "x" : name === "tiktok" ? "tiktok" : name === "instagram" ? "instagram" : "";
  if (!platform) return null;
  const handle = value.trim().replace(/^@/, "");
  if (platform === "x" && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (platform === "tiktok" && !/^[A-Za-z0-9_.]{2,24}$/.test(handle)) return null;
  if (platform === "instagram" && !/^[A-Za-z0-9_.]{1,30}$/.test(handle)) return null;
  if (/^(i|intent|home|explore|search|p|reel|reels)$/i.test(handle)) return null;
  return profileKey(platform, handle);
}

const URL_RE = /https?:\/\/[^\s)>"']+/gi;

export type CollectedPostLink = {
  field: string;
  rawUrl: string;
  postKey: string;
  platform: string;
};

/** Pull post URLs and profile URLs out of token metadata. A profile is stored separately from a post id. */
export function collectPostLinks(fields: { field: string; value?: string | null }[]): CollectedPostLink[] {
  const out: CollectedPostLink[] = [];
  const seen = new Set<string>();
  function push(field: string, rawUrl: string, key: string, platform: string) {
    const id = `${field}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ field, rawUrl, postKey: key, platform });
  }
  for (const field of fields) {
    const value = field.value?.trim();
    if (!value) continue;
    const found = value.match(URL_RE) || [];
    if (!found.length) {
      const loose = looseProfile(field.field, value);
      if (loose) push(field.field, loose.canonical, loose.key, loose.platform);
      continue;
    }
    for (const raw of found) {
      const post = postKeyFromUrl(raw);
      if (post) push(field.field, raw, post.key, post.platform);
      const profile = profileKeyFromUrl(raw);
      if (profile) push(field.field, raw, profile.key, profile.platform);
    }
  }
  return out;
}

export type MatchClass = "exact" | "indirect" | "historical" | "profile";

/** Dedicated social/website fields are exact. A URL buried in a description is an indirect exact-post reference. */
export function classifyLink(field: string, current: boolean): MatchClass {
  if (!current) return "historical";
  if (field === "description") return "indirect";
  return "exact";
}

export function strongestClass(classes: MatchClass[]): MatchClass {
  if (classes.includes("exact")) return "exact";
  if (classes.includes("profile")) return "profile";
  if (classes.includes("indirect")) return "indirect";
  return "historical";
}

/** Post keys that were stored for a token but are absent from the latest snapshot of that same source. */
export function keysDropped(existing: string[], seen: Set<string>): string[] {
  return existing.filter((key) => !seen.has(key));
}
