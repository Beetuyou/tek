/**
 * Simple in-memory rate limiter + LRU cache
 * For production, replace with Redis or Vercel KV.
 */

import { LRUCache } from 'lru-cache';

const cache = new LRUCache<string, any>({
  max: 500,
  ttl: 1000 * 60 * 5, // 5 minutes
});

const rateBuckets = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, reset: now + windowMs };

  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + windowMs;
  }

  bucket.count++;
  rateBuckets.set(key, bucket);
  return bucket.count <= limit;
}

export function getCached<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setCached(key: string, value: any, ttlMs?: number) {
  cache.set(key, value, { ttl: ttlMs });
}
