import { isTikTokHost, normalizeLink, type NormalizedLink } from "./normalize.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const HOPS = 4;
const HOP_MS = 6_000;
const BODY_CAP = 80_000;

function canonicalFromHtml(html: string): string | null {
  const link = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0] || "";
  const href = link.match(/href=["']([^"']+)["']/i)?.[1];
  if (href) return href;
  return html.match(/https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[A-Za-z0-9_.]+\/(?:video|photo)\/\d+/i)?.[0] || null;
}

/** Follow TikTok short-link redirects only onto TikTok hosts. Never invent a video id. */
export async function resolveTikTokShort(start: string, fetchImpl: FetchLike = fetch): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let current = start;
  for (let hop = 0; hop < HOPS; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return { ok: false, reason: "The redirect target was not a URL." };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, reason: "The redirect used an unsupported protocol." };
    }
    if (!isTikTokHost(url.hostname)) {
      return { ok: false, reason: "The redirect left TikTok, so it was not followed." };
    }
    const ready = normalizeLink(current);
    if (ready.valid && ready.platform === "tiktok" && ready.postId) return { ok: true, url: ready.canonical };

    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HOP_MS),
        headers: { accept: "text/html,application/json", "user-agent": "Mozilla/5.0 TekIntel/1.0" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "request failed";
      return { ok: false, reason: `TikTok did not answer the short link (${message}).` };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, reason: "TikTok sent a redirect with no destination." };
      current = new URL(location, current).href;
      continue;
    }

    const finalUrl = res.url || current;
    const parsed = normalizeLink(finalUrl);
    if (parsed.valid && parsed.platform === "tiktok" && parsed.postId) return { ok: true, url: parsed.canonical };
    let html = "";
    try {
      html = (await res.text()).slice(0, BODY_CAP);
    } catch {
      html = "";
    }
    const found = canonicalFromHtml(html);
    if (found) {
      const fromHtml = normalizeLink(found);
      if (fromHtml.valid && fromHtml.platform === "tiktok" && fromHtml.postId) return { ok: true, url: fromHtml.canonical };
    }
    return { ok: false, reason: "TikTok answered, but no video or photo id was in the redirect or page." };
  }
  return { ok: false, reason: "The short link redirected too many times." };
}

/** Resolve a post URL. Short TikTok links that fail stay unresolved, not invalid, and keep the original URL. */
export async function resolvePostUrl(raw: string, fetchImpl?: FetchLike): Promise<NormalizedLink> {
  const first = normalizeLink(raw);
  if (first.state !== "needs_resolution") return first;
  const resolved = await resolveTikTokShort(first.canonical || raw, fetchImpl);
  if (!resolved.ok) {
    return {
      ...first,
      state: "unresolved",
      valid: false,
      postId: undefined,
      error: `${resolved.reason} The short link was kept and was not marked invalid. Paste the canonical www.tiktok.com/@name/video/ID link if you have it.`,
    };
  }
  const again = normalizeLink(resolved.url);
  if (!again.valid || !again.postId) {
    return {
      ...first,
      state: "unresolved",
      valid: false,
      error: "The short link resolved to a TikTok page that is not one video or photo. Paste the canonical video URL.",
    };
  }
  return again;
}
