import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../lib/url-normalizer';

describe('URL Normalizer', () => {
  it('parses X status URLs', () => {
    const r = normalizeUrl('https://x.com/elonmusk/status/1234567890123456789');
    expect(r.isValid).toBe(true);
    expect(r.platform).toBe('x');
    expect(r.handle).toBe('elonmusk');
    expect(r.id).toBe('1234567890123456789');
  });

  it('parses TikTok video URLs', () => {
    const r = normalizeUrl('https://www.tiktok.com/@user/video/7123456789012345678');
    expect(r.isValid).toBe(true);
    expect(r.platform).toBe('tiktok');
    expect(r.handle).toBe('user');
  });

  it('rejects unsupported URLs', () => {
    const r = normalizeUrl('https://example.com/not-a-social');
    expect(r.isValid).toBe(false);
  });

  it('rejects empty input', () => {
    const r = normalizeUrl('');
    expect(r.isValid).toBe(false);
  });
});
