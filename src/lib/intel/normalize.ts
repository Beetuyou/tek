import type { Platform } from "./types";

export type NormState = "resolved" | "needs_resolution" | "unresolved" | "invalid";

export type NormKind = "post" | "profile";

export type NormalizedLink = {
  original: string;
  platform: Platform;
  canonical: string;
  handle?: string;
  postId?: string;
  valid: boolean;
  state: NormState;
  kind?: NormKind;
  error?: string;
};

const X = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;
const TIKTOK = /tiktok\.com\/@([A-Za-z0-9_.]+)\/(?:video|photo)\/(\d+)/i;
const IG = /instagram\.com\/(?:([A-Za-z0-9_.]{1,30})\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i;

const X_RESERVED = new Set(["i", "intent", "share", "home", "explore", "search", "hashtag", "settings", "messages", "notifications", "compose", "tos", "privacy", "login", "signup", "jobs", "download", "account"]);
const IG_RESERVED = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "about", "legal", "developer", "emails", "tv", "directory", "graphql"]);

function xHost(host: string): boolean {
  return host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com" || host === "mobile.twitter.com";
}

/** A profile URL is the account itself, not a status, video, or reel. Reserved site paths are not profiles. */
export function profileFromUrl(raw: string): { platform: Platform; handle: string; canonical: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (xHost(host)) {
    if (parts.length !== 1 || !/^[A-Za-z0-9_]{1,15}$/.test(parts[0]) || X_RESERVED.has(parts[0].toLowerCase())) return null;
    return { platform: "x", handle: parts[0], canonical: `https://x.com/${parts[0]}` };
  }
  if (host === "tiktok.com" || host === "www.tiktok.com" || host === "m.tiktok.com") {
    if (parts.length !== 1 || !parts[0].startsWith("@")) return null;
    const handle = parts[0].slice(1);
    if (!/^[A-Za-z0-9_.]{2,24}$/.test(handle)) return null;
    return { platform: "tiktok", handle, canonical: `https://www.tiktok.com/@${handle}` };
  }
  if (host === "instagram.com" || host === "www.instagram.com") {
    if (parts.length !== 1 || !/^[A-Za-z0-9_.]{1,30}$/.test(parts[0]) || IG_RESERVED.has(parts[0].toLowerCase())) return null;
    return { platform: "instagram", handle: parts[0], canonical: `https://www.instagram.com/${parts[0]}/` };
  }
  return null;
}

const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "t.tiktok.com"]);

export function isTikTokHost(hostname: string): boolean {
  return TIKTOK_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

/** vm/vt and /t/ links identify a TikTok post only after a redirect. They are not invalid. */
export function isTikTokShort(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return true;
    if ((host === "tiktok.com" || host === "www.tiktok.com" || host === "m.tiktok.com" || host === "t.tiktok.com") && /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function normalizeLink(raw: string): NormalizedLink {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { original: raw, platform: "unknown", canonical: "", valid: false, state: "invalid", error: "Paste a link." };
  }
  let href = trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    href = parsed.href;
  } catch {
    return { original: raw, platform: "unknown", canonical: "", valid: false, state: "invalid", error: "That is not a valid URL." };
  }

  const x = href.match(X);
  if (x) {
    return {
      original: raw,
      platform: "x",
      handle: x[1],
      postId: x[2],
      canonical: `https://x.com/${x[1]}/status/${x[2]}`,
      valid: true,
      state: "resolved",
      kind: "post",
    };
  }
  const tt = href.match(TIKTOK);
  if (tt) {
    const kind = /\/photo\//i.test(href) ? "photo" : "video";
    return {
      original: raw,
      platform: "tiktok",
      handle: tt[1],
      postId: tt[2],
      canonical: `https://www.tiktok.com/@${tt[1]}/${kind}/${tt[2]}`,
      valid: true,
      state: "resolved",
      kind: "post",
    };
  }
  if (isTikTokShort(href)) {
    return {
      original: raw,
      platform: "tiktok",
      canonical: href,
      valid: false,
      state: "needs_resolution",
      error: "This is a TikTok short link. It needs a redirect to a video or photo id before it can be searched.",
    };
  }
  const ig = href.match(IG);
  if (ig) {
    const username = ig[1] && !IG_RESERVED.has(ig[1].toLowerCase()) ? ig[1] : undefined;
    const postId = ig[2];
    return {
      original: raw,
      platform: "instagram",
      handle: username,
      postId,
      canonical: `https://www.instagram.com/reel/${postId}/`,
      valid: true,
      state: "resolved",
      kind: "post",
    };
  }
  const profile = profileFromUrl(href);
  if (profile) {
    return {
      original: raw,
      platform: profile.platform,
      handle: profile.handle,
      canonical: profile.canonical,
      valid: true,
      state: "resolved",
      kind: "profile",
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (isTikTokHost(host)) {
    return {
      original: raw,
      platform: "tiktok",
      canonical: href,
      valid: false,
      state: "invalid",
      error: "That TikTok URL is not a video, photo, or profile.",
    };
  }
  return {
    original: raw,
    platform: "unknown",
    canonical: href,
    valid: false,
    state: "invalid",
    error: "Use an X, TikTok, or Instagram post or profile link.",
  };
}
