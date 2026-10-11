import { getSql } from "@/lib/db";
import { GECKO_HISTORY_MAX_PAGE, PUMP_HISTORY_START, isOlderThanMaxAge, isWithinMaxAge, linkOriginFor, nextOffset, windowNote } from "./history-plan";
import { profileFromUrl } from "./normalize";
import { collectPostLinks, keysDropped } from "./post-key";
import { socialFieldsFromPayload } from "./social-extract";
import type { IndexCoverage } from "./types";

export const FEEDS: { provider: string; url: string }[] = [
  { provider: "dexscreener-profiles", url: "https://api.dexscreener.com/token-profiles/latest/v1" },
  { provider: "dexscreener-profiles-updates", url: "https://api.dexscreener.com/token-profiles/recent-updates/v1" },
  { provider: "dexscreener-cto", url: "https://api.dexscreener.com/community-takeovers/latest/v1" },
  { provider: "dexscreener-boosts-latest", url: "https://api.dexscreener.com/token-boosts/latest/v1" },
  { provider: "dexscreener-boosts-top", url: "https://api.dexscreener.com/token-boosts/top/v1" },
];

const PUMP_CREATED = "pump.fun-created";
const PUMP_HISTORY = "pump.fun-history";
const GECKO_HISTORY = "geckoterminal-history";
const PUMP_PAGE = 50;
const PUMP_GOAL = 2000;
const GECKO_NETS = ["solana", "eth", "base", "bsc"] as const;

const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type Profile = {
  chainId?: string;
  tokenAddress?: string;
  icon?: string;
  url?: string;
  links?: { type?: string; url?: string; label?: string }[];
  description?: string;
};

type PumpCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  image_uri?: string;
  twitter?: string | null;
  website?: string | null;
  telegram?: string | null;
  created_timestamp?: number;
  usd_market_cap?: number;
};

export type IndexedLink = {
  chain: string;
  address: string;
  platform: string;
  postKey: string;
  rawUrl: string;
  source: string;
  linkField: string;
  current: boolean;
  firstSeen: string;
  linkOrigin?: string;
  logo?: string;
  dexUrl?: string;
  name?: string;
  symbol?: string;
  launchpad?: string;
  createdAt?: string;
  marketCap?: number;
};

export type ProviderStatus = {
  provider: string;
  ok: boolean;
  fetched: number;
  stored: number;
  error?: string;
  finishedAt: string;
};

type TokenRow = {
  chain: string;
  address: string;
  logo?: string;
  dexUrl?: string;
  name?: string;
  symbol?: string;
  launchpad?: string;
  createdAt?: string;
  marketCap?: number;
};

type LinkRow = {
  chain: string;
  address: string;
  platform: string;
  postKey: string;
  rawUrl: string;
  source: string;
  linkField: string;
  linkOrigin?: string;
};

let lastIngest = 0;
let historyLock = false;
let historyTick = 0;
let pumpBackoffUntil = 0;
let metaBackoffUntil = 0;
let geckoBackoffUntil = 0;
let schemaReady: Promise<void> | null = null;
let notesReady = false;

function ensureHistorySchema(): Promise<void> {
  schemaReady ??= (async () => {
    const sql = await getSql();
    await sql.query("alter table token_socials add column if not exists link_origin text not null default 'current'");
    await sql.query("alter table indexed_tokens add column if not exists metadata_checked_at timestamptz");
    await sql.query("alter table indexed_tokens add column if not exists meta_excerpt text");
    await sql.query("alter table index_progress add column if not exists oldest_at timestamptz");
    await sql.query("alter table index_progress add column if not exists note text");
    await sql.query(
      `create table if not exists index_batches (
        id serial primary key,
        provider text not null,
        cursor_offset integer not null default 0,
        ok boolean not null,
        fetched integer not null default 0,
        stored integer not null default 0,
        oldest_at timestamptz,
        newest_at timestamptz,
        error text,
        finished_at timestamptz not null default now()
      )`,
    );
    await sql.query("create index if not exists indexed_tokens_created_idx on indexed_tokens (created_at)");
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s)>"']+/gi) || [];
}

function launchpadFor(address: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (address.toLowerCase().endsWith("pump")) return "pump.fun";
  return undefined;
}

async function rememberTokens(rows: TokenRow[]) {
  const unique = new Map<string, TokenRow>();
  for (const row of rows) unique.set(`${row.chain}:${row.address}`, row);
  const list = [...unique.values()];
  if (!list.length) return;
  const sql = await getSql();
  const chunk = 40;
  for (let i = 0; i < list.length; i += chunk) {
    const slice = list.slice(i, i + chunk);
    const values: unknown[] = [];
    const groups = slice.map((row) => {
      const base = values.length;
      values.push(
        row.chain,
        row.address,
        row.logo || null,
        row.dexUrl || null,
        row.name || null,
        row.symbol || null,
        row.launchpad || null,
        row.createdAt || null,
        row.marketCap ?? null,
      );
      return `(${Array.from({ length: 9 }, (_, k) => `$${base + k + 1}`).join(",")})`;
    });
    await sql.query(
      `insert into indexed_tokens (chain, address, logo, dex_url, name, symbol, launchpad, created_at, market_cap)
       values ${groups.join(",")}
       on conflict (chain, address) do update set
         logo = coalesce(excluded.logo, indexed_tokens.logo),
         dex_url = coalesce(excluded.dex_url, indexed_tokens.dex_url),
         name = coalesce(excluded.name, indexed_tokens.name),
         symbol = coalesce(excluded.symbol, indexed_tokens.symbol),
         launchpad = coalesce(excluded.launchpad, indexed_tokens.launchpad),
         created_at = case
           when indexed_tokens.created_at is null then excluded.created_at
           when excluded.created_at is null then indexed_tokens.created_at
           when excluded.created_at < indexed_tokens.created_at then excluded.created_at
           else indexed_tokens.created_at
         end,
         market_cap = coalesce(excluded.market_cap, indexed_tokens.market_cap)`,
      values,
    );
  }
}

async function upsertLinks(rows: LinkRow[]) {
  const unique = new Map<string, LinkRow>();
  for (const row of rows) unique.set(`${row.chain}:${row.address}:${row.postKey}:${row.source}`, row);
  const list = [...unique.values()];
  if (!list.length) return;
  await ensureHistorySchema();
  const sql = await getSql();
  const chunk = 40;
  for (let i = 0; i < list.length; i += chunk) {
    const slice = list.slice(i, i + chunk);
    const values: unknown[] = [];
    const groups = slice.map((row) => {
      const base = values.length;
      values.push(row.chain, row.address, row.platform, row.postKey, row.rawUrl, row.source, row.linkField, row.linkOrigin || "current");
      return `(${Array.from({ length: 8 }, (_, k) => `$${base + k + 1}`).join(",")}, true)`;
    });
    await sql.query(
      `insert into token_socials (chain, address, platform, post_key, raw_url, source, link_field, link_origin, current)
       values ${groups.join(",")}
       on conflict (chain, address, post_key, source) do update set
         current = true,
         raw_url = excluded.raw_url,
         link_origin = case
           when token_socials.link_origin = 'launch' then token_socials.link_origin
           when excluded.link_origin = 'launch' then excluded.link_origin
           when token_socials.link_origin = 'later' and excluded.link_origin = 'current' then token_socials.link_origin
           else excluded.link_origin
         end,
         last_seen = now()`,
      values,
    );
  }
}

export async function indexObservedToken(token: {
  chain: string;
  address: string;
  name?: string;
  symbol?: string;
  logo?: string;
  dexUrl?: string;
  launchpad?: string;
  createdAt?: string;
  marketCap?: number;
  metaExcerpt?: string;
  links: { platform: string; postKey: string; rawUrl: string; source: string; linkField: string; linkOrigin?: string }[];
}) {
  if (token.createdAt && !isWithinMaxAge(token.createdAt)) return;
  await rememberTokens([
    {
      chain: token.chain,
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      logo: token.logo,
      dexUrl: token.dexUrl,
      launchpad: token.launchpad,
      createdAt: token.createdAt,
      marketCap: token.marketCap,
    },
  ]);
  await upsertLinks(
    token.links.map((link) => ({
      chain: token.chain,
      address: token.address,
      platform: link.platform,
      postKey: link.postKey,
      rawUrl: link.rawUrl,
      source: link.source,
      linkField: link.linkField,
      linkOrigin: link.linkOrigin,
    })),
  );
  if (token.metaExcerpt) {
    await ensureHistorySchema();
    const sql = await getSql();
    await sql`
      update indexed_tokens set meta_excerpt = ${token.metaExcerpt.slice(0, 4000)}
      where chain = ${token.chain} and address = ${token.address}
    `;
  }
}

async function retireMissing(chain: string, address: string, source: string, keys: Set<string>) {
  const sql = await getSql();
  const existing = await sql<{ post_key: string }>`
    select post_key from token_socials
    where chain = ${chain} and address = ${address} and source = ${source} and current = true
  `;
  for (const postKey of keysDropped(existing.map((row) => row.post_key), keys)) {
    await sql`
      update token_socials set current = false
      where chain = ${chain} and address = ${address} and source = ${source} and post_key = ${postKey}
    `;
  }
}

async function recordRun(provider: string, ok: boolean, fetched: number, stored: number, error?: string) {
  const sql = await getSql();
  await sql`
    insert into index_runs (provider, ok, fetched, stored, error)
    values (${provider}, ${ok}, ${fetched}, ${stored}, ${error || null})
  `;
}

async function readCursor(provider: string): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ cursor_offset: number }>`
    select cursor_offset from index_progress where provider = ${provider}
  `;
  return rows[0]?.cursor_offset ?? 0;
}

async function writeCursor(provider: string, cursor: number, extra?: { oldest?: string; note?: string }) {
  await ensureHistorySchema();
  const sql = await getSql();
  const oldest = extra?.oldest ?? null;
  const note = extra?.note ?? null;
  await sql`
    insert into index_progress (provider, cursor_offset, oldest_at, note)
    values (${provider}, ${cursor}, ${oldest}, ${note})
    on conflict (provider) do update set
      cursor_offset = excluded.cursor_offset,
      oldest_at = case
        when excluded.oldest_at is null then index_progress.oldest_at
        when index_progress.oldest_at is null then excluded.oldest_at
        when excluded.oldest_at < index_progress.oldest_at then excluded.oldest_at
        else index_progress.oldest_at
      end,
      note = case when excluded.note is null then index_progress.note else excluded.note end,
      updated_at = now()
  `;
}

async function recordBatch(input: {
  provider: string;
  cursor: number;
  ok: boolean;
  fetched: number;
  stored: number;
  oldest?: string;
  newest?: string;
  error?: string;
}) {
  await ensureHistorySchema();
  const sql = await getSql();
  await sql`
    insert into index_batches (provider, cursor_offset, ok, fetched, stored, oldest_at, newest_at, error)
    values (
      ${input.provider},
      ${input.cursor},
      ${input.ok},
      ${input.fetched},
      ${input.stored},
      ${input.oldest || null},
      ${input.newest || null},
      ${input.error || null}
    )
  `;
  await sql`delete from index_batches where id < (select coalesce(max(id), 0) - 300 from index_batches)`;
}

async function ingestFeed(provider: string, url: string) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Profile[];
  if (!Array.isArray(data)) throw new Error("Feed was not a list");
  const tokens: TokenRow[] = [];
  const links: LinkRow[] = [];
  const seen = new Map<string, Set<string>>();
  for (const item of data) {
    const chain = item.chainId || "";
    const address = item.tokenAddress || "";
    if (!chain || !address) continue;
    const id = `${chain}:${address}`;
    tokens.push({
      chain,
      address,
      logo: item.icon,
      dexUrl: item.url,
      launchpad: launchpadFor(address),
    });
    const bag = seen.get(id) ?? new Set<string>();
    seen.set(id, bag);
    const fields: { field: string; value?: string | null }[] = [];
    for (const link of item.links || []) fields.push({ field: "links", value: link.url });
    if (item.description) {
      for (const found of urlsIn(item.description)) fields.push({ field: "description", value: found });
    }
    for (const extra of socialFieldsFromPayload(item)) fields.push(extra);
    for (const link of collectPostLinks(fields)) {
      bag.add(link.postKey);
      links.push({
        chain,
        address,
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source: provider,
        linkField: link.field,
        linkOrigin: linkOriginFor({ source: provider }),
      });
    }
  }
  await rememberTokens(tokens);
  await upsertLinks(links);
  for (const [id, keys] of seen) {
    const split = id.indexOf(":");
    await retireMissing(id.slice(0, split), id.slice(split + 1), provider, keys);
  }
  await recordRun(provider, true, data.length, links.length);
  return { fetched: data.length, stored: links.length };
}

export type PumpListQuery = {
  sort?: "created_timestamp" | "market_cap" | "reply_count";
  complete?: boolean;
};

export async function fetchPumpList(offset: number, order: "DESC" | "ASC" = "DESC", query: PumpListQuery = {}): Promise<PumpCoin[]> {
  const sort = query.sort || "created_timestamp";
  const complete = query.complete ? "&complete=true" : "";
  const url = `https://frontend-api-v3.pump.fun/coins?offset=${offset}&limit=${PUMP_PAGE}&sort=${sort}&order=${order}&includeNsfw=true${complete}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 TekIntel/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as PumpCoin[];
  if (!Array.isArray(data)) throw new Error("Pump.fun list was not a list");
  return data;
}

async function storePumpPage(coins: PumpCoin[], source: string) {
  const tokens: TokenRow[] = [];
  const links: LinkRow[] = [];
  const seen = new Map<string, Set<string>>();
  let oldest: string | undefined;
  let newest: string | undefined;
  let crossedAge = false;
  for (const coin of coins) {
    const address = coin.mint || "";
    if (!address) continue;
    const created = coin.created_timestamp ? new Date(coin.created_timestamp).toISOString() : undefined;
    if (!created || !isWithinMaxAge(created)) {
      if (isOlderThanMaxAge(created)) crossedAge = true;
      continue;
    }
    if (!oldest || created < oldest) oldest = created;
    if (!newest || created > newest) newest = created;
    tokens.push({
      chain: "solana",
      address,
      logo: coin.image_uri,
      dexUrl: `https://pump.fun/coin/${address}`,
      name: coin.name,
      symbol: coin.symbol,
      launchpad: "pump.fun",
      createdAt: created,
      marketCap: typeof coin.usd_market_cap === "number" ? coin.usd_market_cap : undefined,
    });
    const bag = new Set<string>();
    seen.set(address, bag);
    for (const link of collectPostLinks([
      { field: "twitter", value: coin.twitter },
      { field: "website", value: coin.website },
      { field: "telegram", value: coin.telegram },
    ])) {
      bag.add(link.postKey);
      links.push({
        chain: "solana",
        address,
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source,
        linkField: link.field,
        linkOrigin: linkOriginFor({ source, createdAt: created }),
      });
    }
  }
  await rememberTokens(tokens);
  await upsertLinks(links);
  for (const [address, keys] of seen) await retireMissing("solana", address, source, keys);
  return { stored: links.length, count: tokens.length, oldest, newest, crossedAge };
}

export async function indexPumpCoins(coins: PumpCoin[], source: string) {
  return storePumpPage(coins, source);
}

export async function scanDexFeed(provider: string, url: string) {
  return ingestFeed(provider, url);
}

async function ingestPump(budgetMs: number) {
  const started = Date.now();
  let fetched = 0;
  let stored = 0;
  try {
    const newest = await fetchPumpList(0);
    fetched += newest.length;
    stored += (await storePumpPage(newest, PUMP_CREATED)).stored;
  } catch (err) {
    await recordRun(PUMP_CREATED, false, fetched, stored, err instanceof Error ? err.message : "failed");
    return;
  }

  let cursor = await readCursor(PUMP_CREATED);
  if (cursor === 0) cursor = PUMP_PAGE;
  while (cursor < PUMP_GOAL && Date.now() - started < budgetMs) {
    try {
      const page = await fetchPumpList(cursor);
      if (!page.length) {
        await writeCursor(PUMP_CREATED, PUMP_GOAL, {
          note: "Newest pump.fun list returned an empty page. That list does not contain the rest of the month.",
        });
        break;
      }
      fetched += page.length;
      const saved = await storePumpPage(page, PUMP_CREATED);
      stored += saved.stored;
      if (saved.crossedAge) {
        await writeCursor(PUMP_CREATED, PUMP_GOAL, {
          oldest: saved.oldest,
          note: "Newest pump.fun list reached a coin older than 30 days. Every newer coin on this pass was stored.",
        });
        break;
      }
      cursor += PUMP_PAGE;
      await writeCursor(PUMP_CREATED, cursor);
    } catch (err) {
      await recordRun(PUMP_CREATED, false, fetched, stored, err instanceof Error ? err.message : "failed");
      return;
    }
  }
  await recordRun(PUMP_CREATED, true, fetched, stored);
}

function geckoChain(network: string): string {
  if (network === "eth") return "ethereum";
  return network;
}

function geckoMint(id?: string): string {
  if (!id) return "";
  const address = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
  if (!address || SKIP_MINTS.has(address)) return "";
  if (address.startsWith("0x") && address.toLowerCase() === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return "";
  return address;
}

let geckoNet = 0;

async function ingestGecko() {
  const network = GECKO_NETS[geckoNet % GECKO_NETS.length];
  geckoNet += 1;
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/new_pools?page=1`, {
    headers: { accept: "application/json", "user-agent": "TekIntel/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }[];
  };
  const pools = body.data || [];
  const addresses: string[] = [];
  for (const pool of pools) {
    const base = geckoMint(pool.relationships?.base_token?.data?.id);
    const quote = geckoMint(pool.relationships?.quote_token?.data?.id);
    const address = base || quote;
    if (address) addresses.push(address);
  }
  const unique = [...new Set(addresses)].slice(0, 6);
  const chain = geckoChain(network);
  const tokens: TokenRow[] = [];
  const links: LinkRow[] = [];
  const seen = new Map<string, Set<string>>();
  for (const address of unique) {
    const infoRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/info`, {
      headers: { accept: "application/json", "user-agent": "TekIntel/1.0" },
    });
    if (infoRes.status === 429) throw new Error("HTTP 429");
    if (!infoRes.ok) continue;
    const info = (await infoRes.json()) as {
      data?: {
        attributes?: {
          name?: string;
          symbol?: string;
          image_url?: string;
          description?: string;
          websites?: string[];
          twitter_handle?: string;
          telegram_handle?: string;
        };
      };
    };
    const attrs = info.data?.attributes || {};
    tokens.push({
      chain,
      address,
      logo: attrs.image_url,
      name: attrs.name,
      symbol: attrs.symbol,
      dexUrl: `https://www.geckoterminal.com/${network}/tokens/${address}`,
    });
    const bag = new Set<string>();
    seen.set(address, bag);
    const websites = (attrs.websites || []).join(" ");
    for (const link of collectPostLinks([
      { field: "twitter", value: attrs.twitter_handle },
      { field: "website", value: websites },
      { field: "telegram", value: attrs.telegram_handle },
      { field: "description", value: attrs.description },
    ])) {
      bag.add(link.postKey);
      links.push({
        chain,
        address,
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source: "geckoterminal",
        linkField: link.field,
        linkOrigin: linkOriginFor({ source: "geckoterminal" }),
      });
    }
  }
  await rememberTokens(tokens);
  await upsertLinks(links);
  for (const [address, keys] of seen) await retireMissing(chain, address, "geckoterminal", keys);
  await recordRun("geckoterminal", true, unique.length, links.length);
}

async function ingestBirdeye() {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) {
    await recordRun("birdeye", false, 0, 0, "API key not configured");
    return;
  }
  const res = await fetch(
    "https://public-api.birdeye.so/defi/v3/token/meme/list?sort_by=created_at&sort_type=desc&offset=0&limit=20",
    { headers: { accept: "application/json", "X-API-KEY": key, "x-chain": "solana" } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { items?: Record<string, unknown>[] } | Record<string, unknown>[] };
  const items = Array.isArray(body.data) ? body.data : body.data?.items || [];
  const tokens: TokenRow[] = [];
  const links: LinkRow[] = [];
  const seen = new Map<string, Set<string>>();
  for (const item of items) {
    const address = String(item.address || item.mint || "");
    if (!address) continue;
    tokens.push({
      chain: "solana",
      address,
      name: typeof item.name === "string" ? item.name : undefined,
      symbol: typeof item.symbol === "string" ? item.symbol : undefined,
      logo: typeof item.logoURI === "string" ? item.logoURI : typeof item.logo_uri === "string" ? item.logo_uri : undefined,
      launchpad: "birdeye",
    });
    const bag = new Set<string>();
    seen.set(address, bag);
    const extensions = (item.extensions || {}) as { twitter?: string; website?: string; telegram?: string };
    for (const link of collectPostLinks([
      { field: "twitter", value: String(item.twitter || extensions.twitter || "") },
      { field: "website", value: String(item.website || extensions.website || "") },
      { field: "telegram", value: String(item.telegram || extensions.telegram || "") },
    ])) {
      bag.add(link.postKey);
      links.push({
        chain: "solana",
        address,
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source: "birdeye",
        linkField: link.field,
        linkOrigin: linkOriginFor({ source: "birdeye" }),
      });
    }
  }
  await rememberTokens(tokens);
  await upsertLinks(links);
  for (const [address, keys] of seen) await retireMissing("solana", address, "birdeye", keys);
  await recordRun("birdeye", true, items.length, links.length);
}

let cycleLock = false;
let ingestHoldUntil = 0;

export function holdBackgroundHistory(ms: number) {
  const until = Date.now() + ms;
  if (until > pumpBackoffUntil) pumpBackoffUntil = until;
  if (until > metaBackoffUntil) metaBackoffUntil = until;
  if (until > geckoBackoffUntil) geckoBackoffUntil = until;
  if (until > ingestHoldUntil) ingestHoldUntil = until;
}

export async function attachDexMetadata(input: { chain: string; address: string; createdAt?: string }): Promise<{ ok: boolean; links: number; error?: string }> {
  await ensureHistorySchema();
  let res: Response;
  try {
    res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(input.address)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    return { ok: false, links: 0, error: err instanceof Error ? err.message : "failed" };
  }
  if (!res.ok) return { ok: false, links: 0, error: `HTTP ${res.status}` };
  const body = (await res.json()) as unknown;
  const fields = socialFieldsFromPayload(body).map((field) => ({ field: field.field, value: field.value }));
  const pairs = (body as { pairs?: { pairCreatedAt?: number }[] }).pairs || [];
  let poolCreated: string | undefined;
  for (const pair of pairs) {
    if (!pair.pairCreatedAt) continue;
    const iso = new Date(pair.pairCreatedAt).toISOString();
    if (!Number.isFinite(Date.parse(iso))) continue;
    if (!poolCreated || iso < poolCreated) poolCreated = iso;
  }
  const knownLaunch = input.createdAt && isWithinMaxAge(input.createdAt) ? input.createdAt : undefined;
  const dated = knownLaunch || poolCreated;
  const keepLinks = Boolean(knownLaunch) || !poolCreated || isWithinMaxAge(poolCreated);
  const links: LinkRow[] = [];
  const seen = new Set<string>();
  if (keepLinks) {
    for (const link of collectPostLinks(fields)) {
      if (seen.has(link.postKey)) continue;
      seen.add(link.postKey);
      links.push({
        chain: input.chain,
        address: input.address,
        platform: link.platform,
        postKey: link.postKey,
        rawUrl: link.rawUrl,
        source: "dexscreener-token",
        linkField: link.field,
        linkOrigin: linkOriginFor({ source: "dexscreener-token", createdAt: dated }),
      });
    }
  }
  await upsertLinks(links);
  const sql = await getSql();
  await sql`
    update indexed_tokens set
      metadata_checked_at = now(),
      created_at = case
        when indexed_tokens.created_at is not null then indexed_tokens.created_at
        when ${poolCreated || null}::timestamptz is null then indexed_tokens.created_at
        else ${poolCreated || null}::timestamptz
      end
    where chain = ${input.chain} and address = ${input.address}
  `;
  return { ok: true, links: links.length };
}

export async function scanBirdeyePage(): Promise<{ ok: boolean; error?: string }> {
  try {
    await ingestBirdeye();
    if (!process.env.BIRDEYE_API_KEY) return { ok: false, error: "API key not configured" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "failed" };
  }
}

export async function ingestSocialFeeds(force = false) {
  if (cycleLock) return;
  if (!force && Date.now() < ingestHoldUntil) return;
  if (!force && Date.now() - lastIngest < 45_000) return;
  cycleLock = true;
  lastIngest = Date.now();
  try {
    for (const feed of FEEDS) {
      try {
        await ingestFeed(feed.provider, feed.url);
      } catch (err) {
        await recordRun(feed.provider, false, 0, 0, err instanceof Error ? err.message : "failed");
      }
    }
    await ingestPump(5_000);
    try {
      await ingestGecko();
    } catch (err) {
      await recordRun("geckoterminal", false, 0, 0, err instanceof Error ? err.message : "failed");
    }
    try {
      await ingestBirdeye();
    } catch (err) {
      await recordRun("birdeye", false, 0, 0, err instanceof Error ? err.message : "failed");
    }
  } finally {
    cycleLock = false;
  }
}

const PUMP_HISTORY_NOTE =
  "Walking pump.fun by created_timestamp, newest first, starting at offset 800 so it does not share the live scanner cursor. Offset is not a calendar date. A period is covered only when a stored launch time falls inside it.";

async function ensureSourceNotes() {
  if (notesReady) return;
    const bird = process.env.BIRDEYE_API_KEY
    ? "Birdeye key is set. The meme list used here is one recent page, not every coin from the last 30 days."
    : "API key not configured. Birdeye listing is unavailable.";
  await writeCursor("birdeye-history", 0, { note: bird });
  await writeCursor("dexscreener-history", 0, {
    note: "DexScreener has no 30-day catalog. Latest profile pages stay on the live scanner. Social links for stored coins come from a per-token metadata check.",
  });
  notesReady = true;
}

async function pumpHistoryPage() {
  let cursor = await readCursor(PUMP_HISTORY);
  if (cursor < PUMP_HISTORY_START) cursor = PUMP_HISTORY_START;
  try {
    const page = await fetchPumpList(cursor);
    const saved = await storePumpPage(page, PUMP_HISTORY);
    const next = nextOffset(cursor, PUMP_PAGE, true, page.length);
    const note = page.length
      ? PUMP_HISTORY_NOTE
      : `${PUMP_HISTORY_NOTE} Last page was empty, so the cursor stayed put. An empty page can be a pagination cap, not proof that older launches do not exist.`;
    await writeCursor(PUMP_HISTORY, next, { oldest: saved.oldest, note });
    await recordBatch({
      provider: PUMP_HISTORY,
      cursor,
      ok: page.length > 0,
      fetched: page.length,
      stored: saved.stored,
      oldest: saved.oldest,
      newest: saved.newest,
      error: page.length ? undefined : "empty page",
    });
    await recordRun(PUMP_HISTORY, page.length > 0, page.length, saved.stored, page.length ? undefined : "empty page");
    if (!page.length) pumpBackoffUntil = Date.now() + 600_000;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    await recordBatch({ provider: PUMP_HISTORY, cursor, ok: false, fetched: 0, stored: 0, error: msg });
    await recordRun(PUMP_HISTORY, false, 0, 0, msg);
    await writeCursor(PUMP_HISTORY, cursor, { note: `${PUMP_HISTORY_NOTE} Last error: ${msg}. Cursor held.` });
    if (/429|timeout|abort|timed out/i.test(msg)) throw err;
  }
}

let geckoHistoryDone = false;

async function geckoHistoryPage() {
  if (geckoHistoryDone) return;
  let page = await readCursor(GECKO_HISTORY);
  if (page < 2) page = 2;
  const note =
    "GeckoTerminal new_pools exposes about 10 pages of recently created pools. That is not every pool from the last 30 days.";
  if (page > GECKO_HISTORY_MAX_PAGE) {
    geckoHistoryDone = true;
    await writeCursor(GECKO_HISTORY, page, { note: `${note} Page walk finished.` });
    return;
  }
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`, {
    headers: { accept: "application/json", "user-agent": "TekIntel/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    await recordBatch({ provider: GECKO_HISTORY, cursor: page, ok: false, fetched: 0, stored: 0, error: `HTTP ${res.status}` });
    await recordRun(GECKO_HISTORY, false, 0, 0, `HTTP ${res.status}`);
    await writeCursor(GECKO_HISTORY, page, { note });
    if (res.status === 429) throw new Error("HTTP 429");
    return;
  }
  const body = (await res.json()) as {
    data?: {
      attributes?: { pool_created_at?: string };
      relationships?: { base_token?: { data?: { id?: string } } };
    }[];
  };
  const pools = body.data || [];
  const tokens: TokenRow[] = [];
  let oldest: string | undefined;
  let newest: string | undefined;
  for (const pool of pools) {
    const created = pool.attributes?.pool_created_at;
    if (created && !isWithinMaxAge(created)) continue;
    if (created) {
      if (!oldest || created < oldest) oldest = created;
      if (!newest || created > newest) newest = created;
    }
    const address = geckoMint(pool.relationships?.base_token?.data?.id);
    if (!address) continue;
    tokens.push({
      chain: "solana",
      address,
      dexUrl: `https://www.geckoterminal.com/solana/tokens/${address}`,
      createdAt: created,
      launchpad: launchpadFor(address),
    });
  }
  await rememberTokens(tokens);
  const next = nextOffset(page, 1, true, pools.length);
  await writeCursor(GECKO_HISTORY, next, { oldest, note });
  await recordBatch({
    provider: GECKO_HISTORY,
    cursor: page,
    ok: pools.length > 0,
    fetched: pools.length,
    stored: tokens.length,
    oldest,
    newest,
    error: pools.length ? undefined : "empty page",
  });
  await recordRun(GECKO_HISTORY, pools.length > 0, pools.length, tokens.length, pools.length ? undefined : "empty page");
}

async function refreshUncheckedMetadata(limit: number) {
  await ensureHistorySchema();
  const sql = await getSql();
  const rows = await sql<{ chain: string; address: string; created_at: string | null }>`
    select chain, address, created_at::text as created_at
    from indexed_tokens
    where metadata_checked_at is null
      and (created_at is null or created_at >= now() - interval '30 days')
    order by created_at is null, created_at desc
    limit ${limit}
  `;
  if (!rows.length) return;
  let stored = 0;
  for (const row of rows) {
    const saved = await attachDexMetadata({ chain: row.chain, address: row.address, createdAt: row.created_at || undefined });
    if (saved.error === "HTTP 429") {
      await recordBatch({ provider: "dexscreener-metadata", cursor: 0, ok: false, fetched: rows.length, stored, error: "HTTP 429" });
      await recordRun("dexscreener-metadata", false, rows.length, stored, "HTTP 429");
      throw new Error("HTTP 429");
    }
    if (!saved.ok) continue;
    stored += saved.links;
  }
  await recordBatch({ provider: "dexscreener-metadata", cursor: 0, ok: true, fetched: rows.length, stored });
  await recordRun("dexscreener-metadata", true, rows.length, stored);
}

const MONTH_LISTS: {
  provider: string;
  order: "DESC";
  sort: "created_timestamp" | "market_cap";
  complete?: boolean;
  cap: number;
  chronological: boolean;
  rescanMs: number;
  note: string;
}[] = [
  {
    provider: "pump.fun-30d",
    order: "DESC",
    sort: "created_timestamp",
    cap: PUMP_GOAL,
    chronological: true,
    rescanMs: 90_000,
    note: "Newest pump.fun list. Every returned coin launched in the last 30 days is stored. The public list empties after about 1,050 rows, which is only the last minutes, not the rest of the month.",
  },
  {
    provider: "pump.fun-30d-bonding",
    order: "DESC",
    sort: "created_timestamp",
    complete: false,
    cap: PUMP_GOAL,
    chronological: true,
    rescanMs: 90_000,
    note: "Bonding-curve pump.fun list. Every returned coin launched in the last 30 days is stored. It also empties after about 1,050 rows.",
  },
  {
    provider: "pump.fun-30d-graduated",
    order: "DESC",
    sort: "created_timestamp",
    complete: true,
    cap: PUMP_GOAL,
    chronological: true,
    rescanMs: 10 * 60_000,
    note: "Graduated pump.fun list by launch time. Every returned coin from the last 30 days is stored. The public list empties after about 1,050 rows, about a day of graduations, not the full month.",
  },
  {
    provider: "pump.fun-30d-mcap",
    order: "DESC",
    sort: "market_cap",
    cap: PUMP_GOAL,
    chronological: false,
    rescanMs: 15 * 60_000,
    note: "Top pump.fun coins by market cap. The whole list is scanned. Only coins launched in the last 30 days are stored. Older rows are skipped. This is not every launch in the month.",
  },
];

const monthRescanAt = new Map<string, number>();

async function pumpCatalogPage() {
  let spec: (typeof MONTH_LISTS)[number] | undefined;
  let cursor = 0;
  for (const candidate of MONTH_LISTS) {
    const at = await readCursor(candidate.provider);
    const due = Date.now() >= (monthRescanAt.get(candidate.provider) ?? 0);
    if (at < candidate.cap) {
      spec = candidate;
      cursor = at;
      break;
    }
    if (due) {
      spec = candidate;
      cursor = 0;
      break;
    }
  }
  if (!spec) return;
  try {
    const page = await fetchPumpList(cursor, spec.order, { sort: spec.sort, complete: spec.complete });
    if (!page.length) {
      const note = `${spec.note} Empty page at offset ${cursor}.`;
      await writeCursor(spec.provider, spec.cap, { note });
      monthRescanAt.set(spec.provider, Date.now() + spec.rescanMs);
      await recordBatch({ provider: spec.provider, cursor, ok: false, fetched: 0, stored: 0, error: "empty page" });
      await recordRun(spec.provider, false, 0, 0, "empty page");
      return;
    }
    const saved = await storePumpPage(page, spec.provider);
    if (spec.chronological && saved.crossedAge) {
      const note = `${spec.note} Reached coins older than 30 days at offset ${cursor}. Every newer coin on this list was indexed.`;
      await writeCursor(spec.provider, spec.cap, { oldest: saved.oldest, note });
      monthRescanAt.set(spec.provider, Date.now() + spec.rescanMs);
      await recordBatch({
        provider: spec.provider,
        cursor,
        ok: true,
        fetched: page.length,
        stored: saved.stored,
        oldest: saved.oldest,
        newest: saved.newest,
      });
      await recordRun(spec.provider, true, page.length, saved.stored);
      return;
    }
    const next = Math.min(spec.cap, cursor + PUMP_PAGE);
    if (next >= spec.cap) monthRescanAt.set(spec.provider, Date.now() + spec.rescanMs);
    await writeCursor(spec.provider, next, { oldest: saved.oldest, note: spec.note });
    await recordBatch({
      provider: spec.provider,
      cursor,
      ok: true,
      fetched: page.length,
      stored: saved.stored,
      oldest: saved.oldest,
      newest: saved.newest,
    });
    await recordRun(spec.provider, true, page.length, saved.stored);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    await recordBatch({ provider: spec.provider, cursor, ok: false, fetched: 0, stored: 0, error: msg });
    await recordRun(spec.provider, false, 0, 0, msg);
    await writeCursor(spec.provider, cursor, { note: `${spec.note} Last error: ${msg}. Cursor held.` });
    if (/429|timeout|abort|timed out/i.test(msg)) throw err;
  }
}

async function runHistoryTick() {
  if (historyLock) return;
  historyLock = true;
  historyTick += 1;
  try {
    await ensureSourceNotes();
    if (Date.now() >= pumpBackoffUntil) {
      try {
        await pumpCatalogPage();
      } catch (err) {
        if (err instanceof Error && /429|timeout|abort|timed out/i.test(err.message)) pumpBackoffUntil = Date.now() + 60_000;
      }
    }
    if (Date.now() >= metaBackoffUntil) {
      try {
        await refreshUncheckedMetadata(10);
      } catch (err) {
        if (err instanceof Error && /429|timeout|abort|timed out/i.test(err.message)) metaBackoffUntil = Date.now() + 45_000;
      }
    }
    if (historyTick % 5 === 0 && Date.now() >= geckoBackoffUntil) {
      try {
        await geckoHistoryPage();
      } catch (err) {
        if (err instanceof Error && /429|timeout|abort|timed out/i.test(err.message)) geckoBackoffUntil = Date.now() + 90_000;
      }
    }
  } finally {
    historyLock = false;
  }
}

const ingestGeneration = Symbol("tek-ingest");

export function startBackgroundIngest() {
  const slot = globalThis as typeof globalThis & {
    __tekIngestTimer?: ReturnType<typeof setInterval>;
    __tekHistoryTimer?: ReturnType<typeof setInterval>;
    __tekHistoryKick?: ReturnType<typeof setTimeout>;
    __tekIngestGen?: symbol;
  };
  if (slot.__tekIngestGen === ingestGeneration && slot.__tekIngestTimer) return;
  if (slot.__tekIngestTimer) clearInterval(slot.__tekIngestTimer);
  if (slot.__tekHistoryTimer) clearInterval(slot.__tekHistoryTimer);
  if (slot.__tekHistoryKick) clearTimeout(slot.__tekHistoryKick);
  slot.__tekIngestGen = ingestGeneration;
  void ingestSocialFeeds(true);
  slot.__tekIngestTimer = setInterval(() => {
    void ingestSocialFeeds(false);
  }, 60_000);
  slot.__tekHistoryKick = setTimeout(() => {
    void runHistoryTick();
  }, 4_000);
  slot.__tekHistoryTimer = setInterval(() => {
    void runHistoryTick();
  }, 8_000);
}

export async function findByPostKey(postKey: string): Promise<IndexedLink[]> {
  await ensureHistorySchema();
  const sql = await getSql();
  const rows = await sql<{
    chain: string;
    address: string;
    platform: string;
    post_key: string;
    raw_url: string;
    source: string;
    link_field: string;
    link_origin: string | null;
    current: boolean;
    first_seen: string;
    logo: string | null;
    dex_url: string | null;
    name: string | null;
    symbol: string | null;
    launchpad: string | null;
    created_at: string | null;
    market_cap: number | string | null;
  }>`
    select s.chain, s.address, s.platform, s.post_key, s.raw_url, s.source, s.link_field, s.link_origin, s.current,
           s.first_seen::text as first_seen, t.logo, t.dex_url, t.name, t.symbol, t.launchpad,
           t.created_at::text as created_at, t.market_cap
    from token_socials s
    left join indexed_tokens t on t.chain = s.chain and t.address = s.address
    where s.post_key = ${postKey}
      and t.created_at >= now() - interval '30 days'
    order by s.current desc, s.first_seen asc
  `;
  return rows.map((row) => ({
    chain: row.chain,
    address: row.address,
    platform: row.platform,
    postKey: row.post_key,
    rawUrl: row.raw_url,
    source: row.source,
    linkField: row.link_field,
    linkOrigin: row.link_origin || "current",
    current: row.current,
    firstSeen: row.first_seen,
    logo: row.logo || undefined,
    dexUrl: row.dex_url || undefined,
    name: row.name || undefined,
    symbol: row.symbol || undefined,
    launchpad: row.launchpad || undefined,
    createdAt: row.created_at || undefined,
    marketCap: row.market_cap == null ? undefined : Number(row.market_cap),
  }));
}

function profilePattern(platform: string, handle: string): string | null {
  if (!/^[a-z0-9_.]{1,30}$/.test(handle)) return null;
  const name = handle.replace(/\./g, "\\.");
  if (platform === "x") return `https?://(?:www\\.|mobile\\.)?(?:x\\.com|twitter\\.com)/${name}(?:[/?#]|$)`;
  if (platform === "tiktok") return `https?://(?:www\\.|m\\.)?tiktok\\.com/@${name}(?:[/?#]|$)`;
  if (platform === "instagram") return `https?://(?:www\\.)?instagram\\.com/${name}(?:[/?#]|$)`;
  return null;
}

function accountProfilePattern(platform: string, handle: string): string | null {
  if (!/^[a-z0-9_.]{1,30}$/.test(handle)) return null;
  const name = handle.replace(/\./g, "\\.");
  const tail = "/?(?:\\?[^#]*)?(?:#.*)?$";
  if (platform === "x") return `^https?://(?:www\\.|mobile\\.)?(?:x\\.com|twitter\\.com)/${name}${tail}`;
  if (platform === "tiktok") return `^https?://(?:www\\.|m\\.)?tiktok\\.com/@${name}${tail}`;
  if (platform === "instagram") return `^https?://(?:www\\.)?instagram\\.com/${name}${tail}`;
  return null;
}

/** Coins whose stored metadata cites this account, including a post on the account. Same 30-day window as post search. */
export async function findByProfile(platform: string, handle: string): Promise<IndexedLink[]> {
  const pattern = profilePattern(platform, handle.toLowerCase());
  if (!pattern) return [];
  const key = `${platform}:@${handle.toLowerCase()}`;
  await ensureHistorySchema();
  const sql = await getSql();
  const rows = await sql<{
    chain: string;
    address: string;
    platform: string;
    post_key: string;
    raw_url: string;
    source: string;
    link_field: string;
    link_origin: string | null;
    current: boolean;
    first_seen: string;
    logo: string | null;
    dex_url: string | null;
    name: string | null;
    symbol: string | null;
    launchpad: string | null;
    created_at: string | null;
    market_cap: number | string | null;
  }>`
    select s.chain, s.address, s.platform, s.post_key, s.raw_url, s.source, s.link_field, s.link_origin, s.current,
           s.first_seen::text as first_seen, t.logo, t.dex_url, t.name, t.symbol, t.launchpad,
           t.created_at::text as created_at, t.market_cap
    from token_socials s
    left join indexed_tokens t on t.chain = s.chain and t.address = s.address
    where t.created_at >= now() - interval '30 days'
      and (s.post_key = ${key} or s.raw_url ~* ${pattern})
    order by s.current desc, s.first_seen asc
  `;
  return rows.map((row) => ({
    chain: row.chain,
    address: row.address,
    platform: row.platform,
    postKey: row.post_key,
    rawUrl: row.raw_url,
    source: row.source,
    linkField: row.link_field,
    linkOrigin: row.link_origin || "current",
    current: row.current,
    firstSeen: row.first_seen,
    logo: row.logo || undefined,
    dexUrl: row.dex_url || undefined,
    name: row.name || undefined,
    symbol: row.symbol || undefined,
    launchpad: row.launchpad || undefined,
    createdAt: row.created_at || undefined,
    marketCap: row.market_cap == null ? undefined : Number(row.market_cap),
  }));
}

/** Coins whose metadata cites the account itself. A post on that account is not a profile link. */
export async function findByProfileLink(platform: string, handle: string): Promise<IndexedLink[]> {
  const name = handle.toLowerCase();
  const pattern = accountProfilePattern(platform, name);
  if (!pattern) return [];
  await ensureHistorySchema();
  const sql = await getSql();
  const rows = await sql<{
    chain: string;
    address: string;
    platform: string;
    post_key: string;
    raw_url: string;
    source: string;
    link_field: string;
    link_origin: string | null;
    current: boolean;
    first_seen: string;
    logo: string | null;
    dex_url: string | null;
    name: string | null;
    symbol: string | null;
    launchpad: string | null;
    created_at: string | null;
    market_cap: number | string | null;
  }>`
    select s.chain, s.address, s.platform, s.post_key, s.raw_url, s.source, s.link_field, s.link_origin, s.current,
           s.first_seen::text as first_seen, t.logo, t.dex_url, t.name, t.symbol, t.launchpad,
           t.created_at::text as created_at, t.market_cap
    from token_socials s
    left join indexed_tokens t on t.chain = s.chain and t.address = s.address
    where t.created_at >= now() - interval '30 days'
      and s.raw_url ~* ${pattern}
    order by s.current desc, s.first_seen asc
  `;
  return rows.flatMap((row) => {
    const profile = profileFromUrl(row.raw_url);
    if (!profile || profile.platform !== platform || profile.handle.toLowerCase() !== name) return [];
    return [{
      chain: row.chain,
      address: row.address,
      platform: row.platform,
      postKey: row.post_key,
      rawUrl: row.raw_url,
      source: row.source,
      linkField: row.link_field,
      linkOrigin: row.link_origin || "current",
      current: row.current,
      firstSeen: row.first_seen,
      logo: row.logo || undefined,
      dexUrl: row.dex_url || undefined,
      name: row.name || undefined,
      symbol: row.symbol || undefined,
      launchpad: row.launchpad || undefined,
      createdAt: row.created_at || undefined,
      marketCap: row.market_cap == null ? undefined : Number(row.market_cap),
    }];
  });
}

export async function indexCoverage(): Promise<IndexCoverage> {
  await ensureHistorySchema();
  const sql = await getSql();
  const [counts] = await sql<{ records: number; posts: number }>`
    select
      count(*)::int as records,
      count(distinct s.post_key)::int as posts
    from token_socials s
    join indexed_tokens t on t.chain = s.chain and t.address = s.address
    where t.created_at >= now() - interval '30 days'
  `;
  const [catalog] = await sql<{ tokens: number }>`
    select count(*)::int as tokens from indexed_tokens where created_at >= now() - interval '30 days'
  `;
  const platforms = await sql<{ platform: string; posts: number }>`
    select s.platform, count(distinct s.post_key)::int as posts
    from token_socials s
    join indexed_tokens t on t.chain = s.chain and t.address = s.address
    where t.created_at >= now() - interval '30 days'
    group by s.platform
    order by s.platform
  `;
  const chainRows = await sql<{ chain: string }>`
    select distinct s.chain
    from token_socials s
    join indexed_tokens t on t.chain = s.chain and t.address = s.address
    where t.created_at >= now() - interval '30 days'
    order by s.chain
  `;
  const pads = await sql<{ launchpad: string }>`
    select distinct launchpad from indexed_tokens
    where launchpad is not null and created_at >= now() - interval '30 days'
    order by launchpad
  `;
  const providers = await sql<{
    provider: string;
    ok: boolean;
    fetched: number;
    stored: number;
    error: string | null;
    finished_at: string;
  }>`
    select distinct on (provider) provider, ok, fetched, stored, error, finished_at::text as finished_at
    from index_runs
    order by provider, id desc
  `;
  const [cursor] = await sql<{ cursor_offset: number }>`
    select cursor_offset from index_progress where provider = ${PUMP_CREATED}
  `;
  const [span] = await sql<{
    h24: number;
    d7: number;
    d30: number;
    oldest: string | null;
  }>`
    select
      count(*) filter (where created_at >= now() - interval '24 hours')::int as h24,
      count(*) filter (where created_at >= now() - interval '7 days')::int as d7,
      count(*) filter (where created_at >= now() - interval '30 days')::int as d30,
      min(created_at) filter (where created_at >= now() - interval '30 days')::text as oldest
    from indexed_tokens
  `;
  const history = await sql<{ provider: string; cursor_offset: number; oldest: string | null; note: string | null }>`
    select provider, cursor_offset, oldest_at::text as oldest, note
    from index_progress
    where provider in (
      'pump.fun-30d',
      'pump.fun-30d-graduated',
      'pump.fun-30d-bonding',
      'pump.fun-30d-mcap',
      'geckoterminal-history',
      'dexscreener-history',
      'birdeye-history'
    )
    order by provider
  `;
  const batches = await sql<{
    provider: string;
    ok: boolean;
    cursor_offset: number;
    fetched: number;
    stored: number;
    error: string | null;
    oldest: string | null;
    finished_at: string;
  }>`
    select provider, ok, cursor_offset, fetched, stored, error, oldest_at::text as oldest, finished_at::text as finished_at
    from index_batches
    order by id desc
    limit 12
  `;
  const walked = cursor?.cursor_offset ?? 0;
  const last = providers
    .filter((row) => row.ok)
    .map((row) => row.finished_at)
    .sort()
    .at(-1);
  const windowRows: [string, number, string][] = [
    ["Last 24 hours", span?.h24 ?? 0, "the last 24 hours"],
    ["Last 7 days", span?.d7 ?? 0, "the last 7 days"],
    ["Last 30 days", span?.d30 ?? 0, "the last 30 days"],
  ];
  return {
    records: counts?.records ?? 0,
    tokens: catalog?.tokens ?? 0,
    postLinks: counts?.posts ?? 0,
    chains: chainRows.map((row) => row.chain),
    platforms: platforms.map((row) => ({ platform: row.platform, posts: row.posts })),
    launchpads: pads.map((row) => row.launchpad),
    lastSuccess: last || null,
    oldestLaunch: span?.oldest || null,
    windows: windowRows.map(([label, tokens, phrase]) => ({ label, tokens, note: windowNote(phrase) })),
    history: history.map((row) => ({
      provider: row.provider,
      cursor: row.cursor_offset,
      oldest: row.oldest,
      note: row.note,
    })),
    batches: batches.map((row) => ({
      provider: row.provider,
      ok: row.ok,
      cursor: row.cursor_offset,
      fetched: row.fetched,
      stored: row.stored,
      error: row.error || undefined,
      oldest: row.oldest || undefined,
      finishedAt: row.finished_at,
    })),
    progress: `Indexing coins launched in the last 30 days. Newest-list offset ${walked}. Every in-window row the public lists return is stored. Oldest launch kept: ${span?.oldest?.slice(0, 19) || "none yet"}.`,
    note: "Pump.fun's public lists return about 1,050 rows and then an empty page. The newest and bonding lists only cover the last minutes. The graduated list covers about the last day. The market-cap list is scanned in full and only coins from the last 30 days are kept. An empty page before 30 days means the rest of the month is not in that list. This is not every memecoin launched in the month. DexScreener latest pages are not a catalog. GeckoTerminal new pools are about 10 pages. Birdeye needs an API key.",
    providers: providers
      .filter((row) =>
        row.provider === PUMP_CREATED ||
        MONTH_LISTS.some((list) => list.provider === row.provider) ||
        row.provider === GECKO_HISTORY ||
        row.provider === "geckoterminal" ||
        row.provider === "birdeye" ||
        row.provider === "dexscreener-metadata" ||
        FEEDS.some((feed) => feed.provider === row.provider),
      )
      .map((row) => ({
        provider: row.provider,
        ok: row.ok,
        fetched: row.fetched,
        stored: row.stored,
        error: row.error || undefined,
        finishedAt: row.finished_at,
      })),
  };
}

