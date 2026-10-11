import { getSql } from "@/lib/db";
import {
  COVERAGE_LIMIT,
  METADATA_ATTEMPT_LIMIT,
  PUMP_PAGE,
  PUMP_WINDOWS,
  SOURCE_CAPS,
  afterPumpPage,
  initialSources,
  metadataBlock,
  overallPercent,
  pumpWindowNote,
  type DeepHit,
  type DeepSearchView,
  type DeepSource,
} from "./deep-plan";
import { isWithinMaxAge, linkOriginFor } from "./history-plan";
import { collectPostLinks, isAccountProfileUrl, postKeyFromUrl, profileKeyFromUrl } from "./post-key";
import { socialFieldsFromPayload } from "./social-extract";
import { resolvePostUrl } from "./url-resolve";
import type { DexPair } from "./providers";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const generation = Symbol("tek-deep");

type QueueItem = { chain: string; address: string; createdAt?: string; sourceId: string };

type Job = {
  id: string;
  url: string;
  postKey: string;
  platform: string;
  handle?: string;
  postId: string;
  kind: "post" | "profile";
  status: "running" | "waiting" | "complete" | "incomplete";
  sources: DeepSource[];
  queue: QueueItem[];
  seen: string[];
  errors: string[];
  hits: DeepHit[];
  dexPauseUntil: number;
  dexStrikes: number;
  metadataAttempts: number;
  metadataStop?: string;
  stopped?: boolean;
  discovered: number;
  scanned: number;
  metadataOk: number;
  oldest?: string;
  newest?: string;
  note: string;
  updatedAt: string;
};

type Slot = {
  gen: symbol;
  job?: Job;
  timer?: ReturnType<typeof setInterval>;
  chain: Promise<void>;
  lastStep: number;
  busy: boolean;
  haltId?: string;
};

function slot(): Slot {
  const g = globalThis as typeof globalThis & { __tekDeep?: Slot };
  if (!g.__tekDeep || g.__tekDeep.gen !== generation) {
    if (g.__tekDeep?.timer) clearInterval(g.__tekDeep.timer);
    g.__tekDeep = { gen: generation, chain: Promise.resolve(), lastStep: 0, busy: false };
  }
  return g.__tekDeep;
}

let schema: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schema ??= (async () => {
    const sql = await getSql();
    await sql.query(
      `create table if not exists search_jobs (
        id text primary key,
        url text not null,
        post_key text,
        mode text not null,
        status text not null,
        discovered integer not null default 0,
        scanned integer not null default 0,
        metadata_ok integer not null default 0,
        matches integer not null default 0,
        oldest_launch text,
        newest_launch text,
        sources text not null default '[]',
        hits text not null default '[]',
        note text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
    );
  })().catch((err) => {
    schema = null;
    throw err;
  });
  return schema;
}

function pushError(job: Job, message: string) {
  job.errors = [...job.errors, message].slice(-8);
}

function track(job: Job, source: DeepSource, iso?: string) {
  if (!iso) return;
  if (!source.oldest || iso < source.oldest) source.oldest = iso;
  if (!source.newest || iso > source.newest) source.newest = iso;
  if (!job.oldest || iso < job.oldest) job.oldest = iso;
  if (!job.newest || iso > job.newest) job.newest = iso;
}

function metadataClosed(job: Job) {
  return Boolean(job.metadataStop) || metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts }) != null;
}

function closeMetadata(job: Job, reason: "rate" | "budget") {
  const left = job.queue.length;
  job.queue = [];
  if (job.metadataStop) return;
  job.metadataStop =
    reason === "rate"
      ? `DexScreener metadata stopped after repeated rate limits. ${left} tokens were not given a second profile check. List rows already saved stay in the index.`
      : `DexScreener metadata stopped after ${METADATA_ATTEMPT_LIMIT} reads so the search could finish. ${left} tokens were not given a second profile check.`;
  pushError(job, job.metadataStop);
}

function forceStop(job: Job) {
  job.stopped = true;
  job.queue = [];
  for (const source of job.sources) {
    if (!terminal(source.status)) {
      source.status = "blocked";
      source.note = "Stopped before this source finished.";
    }
  }
  job.status = "incomplete";
  if (!job.metadataStop) job.metadataStop = "Stopped before every source finished. Tokens already saved stay in the index.";
}

function enqueue(job: Job, item: QueueItem) {
  const id = `${item.chain}:${item.address}`;
  if (!job.seen.includes(id)) {
    job.seen.push(id);
    job.discovered = job.seen.length;
  }
  if (metadataClosed(job)) {
    const reason = metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts });
    if (reason) closeMetadata(job, reason);
    return;
  }
  if (job.queue.some((row) => row.chain === item.chain && row.address === item.address)) return;
  job.queue.push(item);
}

function recompute(job: Job) {
  job.scanned = job.sources.reduce((sum, source) => sum + source.scanned, 0);
  job.metadataOk = job.sources.reduce((sum, source) => sum + source.metadataOk, 0);
  job.discovered = job.seen.length;
  job.note = [
    `${job.discovered} unique tokens discovered, ${job.scanned} rows scanned, ${job.metadataOk} metadata reads succeeded.`,
    `Launch times seen: ${job.oldest?.slice(0, 19) || "none yet"} to ${job.newest?.slice(0, 19) || "none yet"}.`,
    `Connected ranges ${overallPercent(job.sources, SOURCE_CAPS) ?? 0}%.`,
    job.metadataStop || "",
    COVERAGE_LIMIT,
  ].filter(Boolean).join(" ");
}

function terminal(status: DeepSource["status"]) {
  return status === "done" || status === "blocked" || status === "unavailable";
}

function linksFrom(source: string, body: unknown, createdAt?: string) {
  return collectPostLinks(socialFieldsFromPayload(body)).map((link) => ({
    platform: link.platform,
    postKey: link.postKey,
    rawUrl: link.rawUrl,
    source,
    linkField: link.field,
    linkOrigin: linkOriginFor({ source, createdAt }),
  }));
}

async function matchingRows(job: Job) {
  const store = await import("./index-store");
  if (job.kind === "profile" && job.handle) return store.findByProfile(job.platform, job.handle);
  const posts = await store.findByPostKey(job.postKey);
  if (!job.handle) return posts;
  const profiles = await store.findByProfileLink(job.platform, job.handle);
  const seen = new Set<string>();
  const out = [];
  for (const row of [...posts, ...profiles]) {
    const id = `${row.chain}:${row.address}:${row.postKey}:${row.source}:${row.linkField}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function profileSearchUrl(job: Job): string | null {
  if (job.kind !== "post" || !job.handle) return null;
  if (job.platform === "x") return `https://x.com/${job.handle}`;
  if (job.platform === "tiktok") return `https://www.tiktok.com/@${job.handle}`;
  if (job.platform === "instagram") return `https://www.instagram.com/${job.handle}/`;
  return null;
}

function linkCitesSearch(job: Job, link: { postKey: string; rawUrl: string }): boolean {
  if (link.postKey === job.postKey) return job.kind === "profile" || !link.postKey.includes(":@");
  if (job.kind !== "post" || !job.handle) return false;
  return link.postKey === `${job.platform}:@${job.handle.toLowerCase()}` && isAccountProfileUrl(link.rawUrl, job.platform, job.handle);
}

async function refreshHits(job: Job) {
  const rows = await matchingRows(job);
  const map = new Map<string, DeepHit>();
  for (const row of rows) {
    const id = `${row.chain}:${row.address}`;
    const prev = map.get(id);
    if (!prev) {
      map.set(id, {
        chain: row.chain,
        address: row.address,
        name: row.name,
        symbol: row.symbol,
        source: row.source,
        rawUrl: row.rawUrl,
        linkField: row.linkField,
        linkOrigin: row.linkOrigin,
        createdAt: row.createdAt,
      });
      continue;
    }
    if (!prev.source.includes(row.source)) prev.source = `${prev.source}, ${row.source}`;
    if (!prev.createdAt && row.createdAt) prev.createdAt = row.createdAt;
  }
  job.hits = [...map.values()];
}

function maybeFinish(job: Job) {
  if (job.stopped) {
    forceStop(job);
    return;
  }
  const block = metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts });
  if (block) closeMetadata(job, block);
  const runnable = job.sources.some((source) => !terminal(source.status) && (!source.retryAt || source.retryAt <= Date.now()));
  const dexReady = job.queue.length > 0 && Date.now() >= job.dexPauseUntil && !job.metadataStop;
  if (runnable || dexReady) {
    job.status = "running";
    return;
  }
  const open = job.sources.some((source) => !terminal(source.status));
  if (open || job.queue.length > 0) {
    job.status = "waiting";
    return;
  }
  const limited = Boolean(job.metadataStop) || job.sources.some((source) => source.status === "blocked" && source.measurable);
  job.status = limited ? "incomplete" : "complete";
}

async function drainDex(job: Job, limit = 2) {
  if (job.metadataStop) {
    job.queue = [];
    return;
  }
  const block = metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts });
  if (block) {
    closeMetadata(job, block);
    return;
  }
  if (!job.queue.length || Date.now() < job.dexPauseUntil) return;
  const { attachDexMetadata } = await import("./index-store");
  const batch = job.queue.splice(0, limit);
  for (const item of batch) {
    const saved = await attachDexMetadata({ chain: item.chain, address: item.address, createdAt: item.createdAt });
    const source = job.sources.find((row) => row.id === item.sourceId);
    if (!saved.ok) {
      if (saved.error === "HTTP 429" || /429|timeout|abort/i.test(saved.error || "")) {
        job.dexStrikes += 1;
        const reason = metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts });
        if (reason) {
          job.queue.unshift(item, ...batch.slice(batch.indexOf(item) + 1));
          closeMetadata(job, reason);
          return;
        }
        job.queue.unshift(item, ...batch.slice(batch.indexOf(item) + 1));
        job.dexPauseUntil = Date.now() + 20_000;
        pushError(job, `DexScreener metadata paused: ${saved.error || "rate limit"}`);
        return;
      }
      job.metadataAttempts += 1;
      job.dexStrikes = 0;
      pushError(job, `Metadata ${item.address.slice(0, 6)}…: ${saved.error || "failed"}`);
      if (metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts })) {
        job.queue.unshift(...batch.slice(batch.indexOf(item) + 1));
        closeMetadata(job, "budget");
        return;
      }
      continue;
    }
    job.metadataAttempts += 1;
    job.dexStrikes = 0;
    if (source) source.metadataOk += 1;
    if (metadataBlock({ strikes: job.dexStrikes, attempts: job.metadataAttempts })) {
      closeMetadata(job, "budget");
      return;
    }
  }
}

async function stepIndex(job: Job, source: DeepSource) {
  const rows = await matchingRows(job);
  const tokens = new Set(rows.map((row) => `${row.chain}:${row.address}`));
  source.scanned = 1;
  source.metadataOk = rows.length ? 1 : 0;
  source.matches = tokens.size;
  source.status = "done";
  const noun = job.kind === "profile" ? "profile" : job.handle ? "post or this account's profile" : "post";
  source.note = tokens.size
    ? `Stored index already has ${tokens.size} token${tokens.size === 1 ? "" : "s"} for this ${noun}.`
    : `Stored index has no link for this ${noun} yet.`;
}

async function stepHints(job: Job, source: DeepSource) {
  if (job.kind === "profile" || !job.postId) {
    source.scanned = 1;
    source.status = "done";
    source.note = "This is a profile, not one post. The account feed was not read for contract addresses. A coin matches only when stored metadata cites this profile or a post on it.";
    return;
  }
  const { enrichMissingPost } = await import("./live-enrich");
  const enrichment = await enrichMissingPost({
    platform: job.platform,
    handle: job.handle,
    postId: job.postId,
    postKey: job.postKey,
  });
  source.scanned = 1;
  source.metadataOk = enrichment.hints.length;
  source.matches = enrichment.confirmed;
  source.status = enrichment.status === "failed" && !enrichment.confirmed ? "blocked" : "done";
  source.note = enrichment.detail;
  for (const error of enrichment.errors) pushError(job, error);
}

async function stepDexSearch(job: Job, source: DeepSource) {
  const { searchDex } = await import("./providers");
  const { indexObservedToken } = await import("./index-store");
  const pairs: DexPair[] = [];
  for (const query of [job.postId, job.url, profileSearchUrl(job) || ""].filter((query) => query.length > 2)) {
    try {
      pairs.push(...(await searchDex(query)));
    } catch (err) {
      pushError(job, `DexScreener search: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  const seen = new Set<string>();
  let cited = 0;
  for (const pair of pairs) {
    const address = pair.baseToken?.address || "";
    const chain = pair.chainId || "";
    if (!address || !chain || seen.has(`${chain}:${address}`)) continue;
    seen.add(`${chain}:${address}`);
    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : undefined;
    const links = linksFrom("dexscreener-search", { pairs: [pair] }, createdAt).filter((link) => linkCitesSearch(job, link));
    if (!links.length) continue;
    cited += 1;
    await indexObservedToken({
      chain,
      address,
      name: pair.baseToken?.name,
      symbol: pair.baseToken?.symbol,
      logo: pair.info?.imageUrl,
      dexUrl: pair.url,
      links,
    });
    enqueue(job, { chain, address, createdAt, sourceId: source.id });
  }
  source.scanned = 1;
  source.metadataOk = seen.size;
  source.matches = cited;
  source.status = "done";
  source.note = job.kind === "profile"
    ? `DexScreener search returned ${pairs.length} pairs for this profile. ${cited} cited this account. A search hit is not a match unless its metadata cites the profile. This is not a historical catalog.`
    : `DexScreener search returned ${pairs.length} pairs for the post, the URL, and the account profile. ${cited} cited this post or this account's profile. A search hit is not a match unless its metadata cites one of those. This is not a historical catalog.`;
}

async function stepPump(job: Job, source: DeepSource) {
  const spec = PUMP_WINDOWS.find((window) => window.id === source.id);
  if (!spec) {
    source.status = "blocked";
    source.note = "Unknown pump window.";
    return;
  }
  if (source.cursor >= spec.cap) {
    source.status = "done";
    source.note = pumpWindowNote({ ...spec, scanned: source.scanned, oldest: source.oldest, newest: source.newest, ended: true, reason: "cap" });
    return;
  }
  const { fetchPumpList, indexPumpCoins } = await import("./index-store");
  let page: Awaited<ReturnType<typeof fetchPumpList>>;
  try {
    page = await fetchPumpList(source.cursor, spec.order, { sort: spec.sort, complete: spec.complete });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    source.fails = (source.fails || 0) + 1;
    pushError(job, `${spec.label}: ${message}`);
    if (source.fails >= 3) {
      source.status = "blocked";
      source.note = `${pumpWindowNote({ ...spec, scanned: source.scanned, oldest: source.oldest, newest: source.newest, ended: true, reason: "error" })} Last error: ${message}.`;
      return;
    }
    source.status = "waiting";
    source.retryAt = Date.now() + (/429/.test(message) ? 20_000 : 15_000);
    source.note = `${spec.label} paused after ${message}. The offset stayed at ${source.cursor}.`;
    return;
  }
  const marker = page[0]?.mint || "";
  if (marker && source.marker === marker) {
    source.status = "done";
    source.note = pumpWindowNote({ ...spec, scanned: source.scanned, oldest: source.oldest, newest: source.newest, ended: true, reason: "repeat" });
    return;
  }
  const saved = await indexPumpCoins(page, source.id);
  let kept = 0;
  for (const coin of page) {
    if (!coin.mint) continue;
    const createdAt = coin.created_timestamp ? new Date(coin.created_timestamp).toISOString() : undefined;
    if (!isWithinMaxAge(createdAt)) continue;
    kept += 1;
    track(job, source, createdAt);
    enqueue(job, { chain: "solana", address: coin.mint, createdAt, sourceId: source.id });
  }
  source.scanned += page.length;
  source.metadataOk += kept;
  source.marker = marker || source.marker;
  source.fails = 0;
  if (spec.kind === "time" && saved.crossedAge) {
    source.status = "done";
    source.note = pumpWindowNote({
      ...spec,
      scanned: source.scanned,
      oldest: source.oldest,
      newest: source.newest,
      ended: true,
      reason: "age",
    });
    return;
  }
  const adv = afterPumpPage(source.cursor, PUMP_PAGE, page.length, spec.cap);
  source.cursor = adv.next;
  source.status = adv.ended ? "done" : "running";
  source.note = pumpWindowNote({
    ...spec,
    scanned: source.scanned,
    oldest: source.oldest,
    newest: source.newest,
    ended: adv.ended,
    reason: adv.ended && adv.reason !== "continue" ? adv.reason : undefined,
  });
}

async function stepDexLatest(job: Job, source: DeepSource) {
  const { FEEDS, scanDexFeed } = await import("./index-store");
  const feed = FEEDS[source.cursor];
  if (!feed) {
    source.status = "done";
    source.note = "DexScreener latest profile, boost, and takeover pages were requested once. Those pages are not a historical catalog.";
    return;
  }
  try {
    const saved = await scanDexFeed(feed.provider, feed.url);
    source.scanned += 1;
    source.metadataOk += saved.fetched;
    source.note = `${feed.provider}: ${saved.fetched} rows. Latest pages only, not a historical catalog.`;
  } catch (err) {
    source.scanned += 1;
    const message = err instanceof Error ? err.message : "failed";
    pushError(job, `${feed.provider}: ${message}`);
    source.note = `${feed.provider} failed (${message}). Latest pages are not a historical catalog.`;
  }
  source.cursor += 1;
  source.status = source.cursor >= FEEDS.length ? "done" : "running";
  if (source.status === "done") {
    source.note = "DexScreener latest profile, boost, and takeover pages were requested once. Those pages are not a historical catalog.";
  }
}

async function stepGecko(job: Job, source: DeepSource) {
  const page = source.cursor || 1;
  if (page > 10) {
    source.status = "done";
    source.note = "GeckoTerminal new_pools exposes about 10 pages of recently created pools. This is not 30, 90, or 180 day coverage.";
    return;
  }
  let res: Response;
  try {
    res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`, {
      headers: { accept: "application/json", "user-agent": "TekIntel/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    source.fails = (source.fails || 0) + 1;
    const message = err instanceof Error ? err.message : "failed";
    pushError(job, `GeckoTerminal: ${message}`);
    source.status = source.fails >= 2 ? "blocked" : "waiting";
    source.retryAt = Date.now() + 45_000;
    source.note = source.status === "blocked"
      ? `GeckoTerminal stopped on page ${page} after ${message}. Earlier pages only. Not 30, 90, or 180 day coverage.`
      : `GeckoTerminal paused on page ${page}: ${message}.`;
    return;
  }
  if (res.status === 429) {
    source.fails = (source.fails || 0) + 1;
    source.status = source.fails >= 2 ? "blocked" : "waiting";
    source.retryAt = Date.now() + 45_000;
    pushError(job, "GeckoTerminal HTTP 429");
    source.note = source.status === "blocked"
      ? `GeckoTerminal rate-limited through page ${page}. Not 30, 90, or 180 day coverage.`
      : `GeckoTerminal rate-limited on page ${page}. The page was not skipped.`;
    return;
  }
  if (!res.ok) {
    source.status = "blocked";
    source.note = `GeckoTerminal HTTP ${res.status} on page ${page}. Not a full historical archive.`;
    pushError(job, `GeckoTerminal HTTP ${res.status}`);
    return;
  }
  const body = (await res.json()) as {
    data?: { attributes?: { pool_created_at?: string }; relationships?: { base_token?: { data?: { id?: string } } } }[];
  };
  const pools = body.data || [];
  const { indexObservedToken } = await import("./index-store");
  for (const pool of pools) {
    const raw = pool.relationships?.base_token?.data?.id || "";
    const address = raw.includes("_") ? raw.slice(raw.indexOf("_") + 1) : raw;
    if (!address) continue;
    const createdAt = pool.attributes?.pool_created_at;
    track(job, source, createdAt);
    await indexObservedToken({
      chain: "solana",
      address,
      dexUrl: `https://www.geckoterminal.com/solana/tokens/${address}`,
      links: [],
    });
    enqueue(job, { chain: "solana", address, createdAt, sourceId: source.id });
  }
  source.scanned += pools.length;
  source.metadataOk += pools.length;
  source.cursor = page + 1;
  source.fails = 0;
  source.status = !pools.length || source.cursor > 10 ? "done" : "running";
  source.note = source.status === "done"
    ? `GeckoTerminal new_pools ended around page ${page} (${source.scanned} pools). About 10 recent pages, not 30, 90, or 180 day coverage.`
    : `GeckoTerminal new_pools page ${page} stored. Recent pools only.`;
}

async function stepBirdeye(job: Job, source: DeepSource) {
  const { scanBirdeyePage } = await import("./index-store");
  const saved = await scanBirdeyePage();
  source.scanned = 1;
  source.metadataOk = saved.ok ? 1 : 0;
  source.status = saved.ok ? "done" : "blocked";
  source.note = saved.ok
    ? "Birdeye meme list returned one recent page. That is not a historical archive."
    : `Birdeye unavailable (${saved.error || "request failed"}). Historical listing was not scanned.`;
  if (!saved.ok && saved.error) pushError(job, `Birdeye: ${saved.error}`);
}

async function stepSolana(job: Job, source: DeepSource) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [PUMP_PROGRAM, { limit: 5 }],
  };
  let note = "Public Solana RPC was asked for 5 recent pump-program signatures. A signature is not a social link, and decoding every launch exceeds the public rate limit. Token metadata from this source was not scanned.";
  try {
    const res = await fetch("https://solana-rpc.publicnode.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = (await res.json()) as { result?: { blockTime?: number }[]; error?: { message?: string } };
    const time = payload.result?.[0]?.blockTime;
    if (time) note = `Public RPC returned recent pump-program signatures (newest block time ${new Date(time * 1000).toISOString()}). ${note}`;
    else if (!res.ok || payload.error) note = `Public RPC did not return a usable signature page (${payload.error?.message || `HTTP ${res.status}`}). ${note}`;
  } catch (err) {
    note = `Public RPC request failed (${err instanceof Error ? err.message : "failed"}). ${note}`;
    pushError(job, `Solana RPC: ${err instanceof Error ? err.message : "failed"}`);
  }
  source.scanned = 0;
  source.status = "blocked";
  source.measurable = false;
  source.note = note;
}

async function oneStep(job: Job) {
  if (job.stopped || slot().haltId === job.id) {
    forceStop(job);
    recompute(job);
    return;
  }
  const { holdBackgroundHistory } = await import("./index-store");
  holdBackgroundHistory(25_000);
  const source = job.sources.find((row) => !terminal(row.status) && (!row.retryAt || row.retryAt <= Date.now()));
  if (!source) {
    if (!job.metadataStop && job.queue.length && Date.now() >= job.dexPauseUntil) await drainDex(job, 4);
    else job.queue = job.metadataStop ? [] : job.queue;
    maybeFinish(job);
    recompute(job);
    await refreshHits(job);
    return;
  }
  source.status = source.status === "pending" ? "running" : source.status;
  if (source.id === "index") await stepIndex(job, source);
  else if (source.id === "post-hints") await stepHints(job, source);
  else if (source.id === "dex-search") await stepDexSearch(job, source);
  else if (source.id.startsWith("pump-")) await stepPump(job, source);
  else if (source.id === "dex-latest") await stepDexLatest(job, source);
  else if (source.id === "gecko-new-pools") await stepGecko(job, source);
  else if (source.id === "birdeye") await stepBirdeye(job, source);
  else if (source.id === "solana-program") await stepSolana(job, source);
  else {
    source.status = "blocked";
    source.note = "This source is not connected.";
  }
  if (!job.stopped && !job.metadataStop && job.queue.length && Date.now() >= job.dexPauseUntil && source.id !== "post-hints") await drainDex(job);
  maybeFinish(job);
  recompute(job);
  await refreshHits(job);
}

function blobOf(job: Job) {
  return {
    sources: job.sources,
    queue: job.queue,
    seen: job.seen,
    errors: job.errors,
    dexPauseUntil: job.dexPauseUntil,
    dexStrikes: job.dexStrikes,
    metadataAttempts: job.metadataAttempts,
    metadataStop: job.metadataStop || "",
    stopped: Boolean(job.stopped),
    platform: job.platform,
    handle: job.handle || "",
    postId: job.postId,
    kind: job.kind,
    oldest: job.oldest || "",
    newest: job.newest || "",
  };
}

async function save(job: Job) {
  const sql = await getSql();
  job.updatedAt = new Date().toISOString();
  await sql.query(
    `insert into search_jobs
      (id, url, post_key, mode, status, discovered, scanned, metadata_ok, matches, oldest_launch, newest_launch, sources, hits, note, updated_at)
     values ($1,$2,$3,'deep',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     on conflict (id) do update set
       status = excluded.status,
       discovered = excluded.discovered,
       scanned = excluded.scanned,
       metadata_ok = excluded.metadata_ok,
       matches = excluded.matches,
       oldest_launch = excluded.oldest_launch,
       newest_launch = excluded.newest_launch,
       sources = excluded.sources,
       hits = excluded.hits,
       note = excluded.note,
       updated_at = now()`,
    [
      job.id,
      job.url,
      job.postKey,
      job.status,
      job.discovered,
      job.scanned,
      job.metadataOk,
      job.hits.length,
      job.oldest || null,
      job.newest || null,
      JSON.stringify(blobOf(job)),
      JSON.stringify(job.hits),
      job.note,
    ],
  );
}

function fromRow(row: {
  id: string;
  url: string;
  post_key: string | null;
  status: string;
  discovered: number;
  scanned: number;
  metadata_ok: number;
  oldest_launch: string | null;
  newest_launch: string | null;
  sources: string;
  hits: string;
  note: string | null;
  updated_at: string;
}): Job | null {
  let blob: Partial<ReturnType<typeof blobOf>> = {};
  let hits: DeepHit[] = [];
  try {
    blob = JSON.parse(row.sources) as ReturnType<typeof blobOf>;
    hits = JSON.parse(row.hits) as DeepHit[];
  } catch {
    return null;
  }
  const status = row.status === "complete" || row.status === "incomplete" || row.status === "waiting" ? row.status : "running";
  return {
    id: row.id,
    url: row.url,
    postKey: row.post_key || "",
    platform: blob.platform || "x",
    handle: blob.handle || undefined,
    postId: blob.postId || "",
    kind: blob.kind === "profile" || (row.post_key || "").includes(":@") ? "profile" : "post",
    status,
    sources: blob.sources || [],
    queue: blob.queue || [],
    seen: blob.seen || [],
    errors: blob.errors || [],
    hits: Array.isArray(hits) ? hits : [],
    dexPauseUntil: blob.dexPauseUntil || 0,
    dexStrikes: blob.dexStrikes || 0,
    metadataAttempts: blob.metadataAttempts || 0,
    metadataStop: blob.metadataStop || undefined,
    stopped: Boolean(blob.stopped),
    discovered: row.discovered,
    scanned: row.scanned,
    metadataOk: row.metadata_ok,
    oldest: row.oldest_launch || blob.oldest || undefined,
    newest: row.newest_launch || blob.newest || undefined,
    note: row.note || "",
    updatedAt: row.updated_at,
  };
}

async function load(id: string): Promise<Job | null> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    url: string;
    post_key: string | null;
    status: string;
    discovered: number;
    scanned: number;
    metadata_ok: number;
    oldest_launch: string | null;
    newest_launch: string | null;
    sources: string;
    hits: string;
    note: string | null;
    updated_at: string;
  }>`
    select id, url, post_key, status, discovered, scanned, metadata_ok, oldest_launch, newest_launch,
           sources, hits, note, updated_at::text as updated_at
    from search_jobs where id = ${id}
  `;
  return rows[0] ? fromRow(rows[0]) : null;
}

async function findOpen(): Promise<Job | null> {
  const current = slot().job;
  if (current && (current.status === "running" || current.status === "waiting")) return current;
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    select id from search_jobs where status in ('running', 'waiting') order by updated_at desc limit 1
  `;
  if (!rows[0]) return null;
  return load(rows[0].id);
}

function toView(job: Job): DeepSearchView {
  return {
    id: job.id,
    url: job.url,
    postKey: job.postKey,
    status: job.status,
    discovered: job.discovered,
    scanned: job.scanned,
    metadataOk: job.metadataOk,
    matches: job.hits.length,
    oldestLaunch: job.oldest || null,
    newestLaunch: job.newest || null,
    percent: overallPercent(job.sources, SOURCE_CAPS),
    note: job.note,
    errors: job.errors,
    sources: job.sources,
    hits: job.hits,
    updatedAt: job.updatedAt,
  };
}

function missing(id: string): DeepSearchView {
  return {
    id,
    url: "",
    postKey: null,
    status: "missing",
    discovered: 0,
    scanned: 0,
    metadataOk: 0,
    matches: 0,
    oldestLaunch: null,
    newestLaunch: null,
    percent: null,
    note: "That search is no longer on this server. Start it again. Tokens already saved remain for the next search when storage is hosted. A site restart can clear an in-memory database.",
    errors: [],
    sources: [],
    hits: [],
    updatedAt: new Date().toISOString(),
  };
}

async function ensureProgress(job: Job, budgetMs: number) {
  const started = Date.now();
  let steps = 0;
  while (steps < 6 && Date.now() - started < budgetMs) {
    if (slot().haltId === job.id) job.stopped = true;
    if (job.status === "complete" || job.status === "incomplete" || job.stopped) break;
    await oneStep(job);
    steps += 1;
    if (slot().haltId === job.id) forceStop(job);
    await save(job);
    if (job.status !== "running") break;
  }
  slot().lastStep = Date.now();
}

function runLocked(id: string, budgetMs: number) {
  const current = slot();
  if (current.busy) return Promise.resolve(current.job?.id === id ? current.job : null);
  current.busy = true;
  const run = current.chain.then(async () => {
    try {
      let job = current.job?.id === id ? current.job : await load(id);
      if (!job) return null;
      current.job = job;
      if (job.status === "complete" || job.status === "incomplete") return job;
      await ensureProgress(job, budgetMs);
      return job;
    } finally {
      current.busy = false;
    }
  });
  current.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function arm() {
  const current = slot();
  if (current.timer) return;
  current.timer = setInterval(() => {
    const job = current.job;
    if (!job || job.status === "complete" || job.status === "incomplete" || current.busy) {
      if (job && (job.status === "complete" || job.status === "incomplete") && current.timer) {
        clearInterval(current.timer);
        current.timer = undefined;
      }
      return;
    }
    void runLocked(job.id, 2800);
  }, 1500);
}

export async function stopDeepJob(id: string): Promise<DeepSearchView> {
  await ensureSchema();
  const current = slot();
  current.haltId = id;
  const job = current.job?.id === id ? current.job : await load(id);
  if (!job) return missing(id);
  current.job = job;
  forceStop(job);
  recompute(job);
  await save(job);
  if (current.timer) {
    clearInterval(current.timer);
    current.timer = undefined;
  }
  return toView(job);
}

export async function startDeepJob(url: string): Promise<DeepSearchView> {
  await ensureSchema();
  const normalized = await resolvePostUrl(url);
  const profile = normalized.kind === "profile" ? profileKeyFromUrl(normalized.canonical || url) : null;
  const key = profile ? null : normalized.valid && normalized.postId ? postKeyFromUrl(normalized.canonical) : null;
  if (!key && !profile) throw new Error(normalized.error || "Paste an X, TikTok, or Instagram post or profile link.");
  const postKey = key?.key || profile!.key;
  const open = await findOpen();
  if (open) {
    if (open.postKey === postKey) {
      slot().job = open;
      arm();
      return toView(open);
    }
    throw new Error("A deep search is already running. Wait until it finishes.");
  }
  const job: Job = {
    id: `dj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    url: normalized.canonical,
    postKey,
    platform: profile?.platform || normalized.platform,
    handle: profile?.handle || normalized.handle,
    postId: key?.postId || "",
    kind: profile ? "profile" : "post",
    status: "running",
    sources: initialSources(Boolean(process.env.BIRDEYE_API_KEY)),
    queue: [],
    seen: [],
    errors: [],
    hits: [],
    dexPauseUntil: 0,
    dexStrikes: 0,
    metadataAttempts: 0,
    discovered: 0,
    scanned: 0,
    metadataOk: 0,
    note: COVERAGE_LIMIT,
    updatedAt: new Date().toISOString(),
  };
  slot().job = job;
  await save(job);
  arm();
  const done = await runLocked(job.id, 12_000);
  return toView(done || job);
}

export async function readDeepJob(id: string): Promise<DeepSearchView> {
  await ensureSchema();
  const current = slot();
  const known = current.job?.id === id ? current.job : await load(id);
  if (!known) return missing(id);
  if (known.status === "running" || known.status === "waiting") {
    current.job = known;
    arm();
    if (Date.now() - current.lastStep > 1500) await runLocked(id, 4000);
  }
  const fresh = current.job?.id === id ? current.job : known;
  return toView(fresh);
}
