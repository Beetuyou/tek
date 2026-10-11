import { createServerFn } from "@tanstack/react-start";
import type { DeepSearchView } from "./deep-plan";
import type { DiscoverResult, HistoryLink, IndexCoverage } from "./types";

const buckets = new Map<string, { count: number; reset: number }>();

function allow(key: string, limit = 8, windowMs = 60_000): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { count: 0, reset: now + windowMs };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + windowMs;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket.count <= limit;
}

export const discoverTokens = createServerFn({ method: "POST" })
  .validator((input: { url: string; text?: string; history?: HistoryLink[] }) => {
    const url = typeof input?.url === "string" ? input.url.trim() : "";
    const text = typeof input?.text === "string" ? input.text.slice(0, 8000) : "";
    if (!url || url.length > 500) throw new Error("Enter a social post link.");
    const history = Array.isArray(input?.history)
      ? input.history.slice(0, 40).flatMap((item) => {
          if (!item || typeof item.address !== "string" || typeof item.recordedAt !== "string") return [];
          return [{
            address: item.address.slice(0, 80),
            chain: typeof item.chain === "string" ? item.chain.slice(0, 32) : "",
            handle: typeof item.handle === "string" ? item.handle.slice(0, 32) : undefined,
            url: typeof item.url === "string" ? item.url.slice(0, 300) : undefined,
            recordedAt: item.recordedAt.slice(0, 40),
          }];
        })
      : [];
    return { url, text, history };
  })
  .handler(async ({ data }): Promise<DiscoverResult> => {
    if (!allow("discover", 30)) throw new Error("Too many scans. Wait a minute and try again.");
    const { runDiscovery } = await import("./reverse");
    return runDiscovery(data.url, data.text, data.history);
  });

export const warmupIndex = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .handler(async (): Promise<IndexCoverage | null> => {
    const { startBackgroundIngest, indexCoverage } = await import("./index-store");
    startBackgroundIngest();
    return indexCoverage().catch(() => null);
  });

export const startDeepSearch = createServerFn({ method: "POST" })
  .validator((input: { url: string }) => {
    const url = typeof input?.url === "string" ? input.url.trim() : "";
    if (!url || url.length > 500) throw new Error("Enter a social post link.");
    return { url };
  })
  .handler(async ({ data }): Promise<DeepSearchView> => {
    if (!allow("deep-start", 8)) throw new Error("Too many deep searches. Wait a minute and try again.");
    const { startDeepJob } = await import("./deep-job");
    return startDeepJob(data.url);
  });

export const readDeepSearch = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => {
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!/^dj_[a-z0-9_]+$/i.test(id)) throw new Error("Missing search.");
    return { id };
  })
  .handler(async ({ data }): Promise<DeepSearchView> => {
    const { readDeepJob } = await import("./deep-job");
    return readDeepJob(data.id);
  });

export const stopDeepSearch = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => {
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!/^dj_[a-z0-9_]+$/i.test(id)) throw new Error("Missing search.");
    return { id };
  })
  .handler(async ({ data }): Promise<DeepSearchView> => {
    const { stopDeepJob } = await import("./deep-job");
    return stopDeepJob(data.id);
  });
