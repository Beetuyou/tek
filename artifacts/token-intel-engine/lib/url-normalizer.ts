/**
 * URL Normalization Module
 * Detects platform and extracts canonical identifiers from social URLs.
 */

export type Platform = 'x' | 'twitter' | 'tiktok' | 'instagram' | 'unknown';

export interface NormalizedUrl {
  original: string;
  platform: Platform;
  id?: string;          // tweet id, video id, etc.
  handle?: string;
  canonical: string;
  isValid: boolean;
  error?: string;
}

const patterns = {
  x: /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/i,
  tiktok: /tiktok\.com\/@([A-Za-z0-9_.]+)\/video\/(\d+)/i,
  instagram: /instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i,
};

export function normalizeUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { original: raw, platform: 'unknown', canonical: '', isValid: false, error: 'Empty URL' };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return { original: raw, platform: 'unknown', canonical: '', isValid: false, error: 'Invalid URL' };
  }

  const href = url.href;

  // X / Twitter
  const xMatch = href.match(patterns.x);
  if (xMatch) {
    return {
      original: raw,
      platform: 'x',
      handle: xMatch[1],
      id: xMatch[2],
      canonical: `https://x.com/${xMatch[1]}/status/${xMatch[2]}`,
      isValid: true,
    };
  }

  // TikTok
  const ttMatch = href.match(patterns.tiktok);
  if (ttMatch) {
    return {
      original: raw,
      platform: 'tiktok',
      handle: ttMatch[1],
      id: ttMatch[2],
      canonical: `https://www.tiktok.com/@${ttMatch[1]}/video/${ttMatch[2]}`,
      isValid: true,
    };
  }

  // Instagram
  const igMatch = href.match(patterns.instagram);
  if (igMatch) {
    return {
      original: raw,
      platform: 'instagram',
      id: igMatch[1],
      canonical: `https://www.instagram.com/reel/${igMatch[1]}/`,
      isValid: true,
    };
  }

  return {
    original: raw,
    platform: 'unknown',
    canonical: href,
    isValid: false,
    error: 'Unsupported or unrecognized social platform URL',
  };
}
