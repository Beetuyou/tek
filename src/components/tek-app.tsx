import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2, ScanSearch, Sparkles } from "lucide-react";
import { narratePost } from "@/lib/intel/brief";
import { discoverTokens, readDeepSearch, startDeepSearch, stopDeepSearch, warmupIndex } from "@/lib/intel/discover";
import type { DeepSearchView } from "@/lib/intel/deep-plan";
import { agePhrase, originPhrase } from "@/lib/intel/history-plan";
import type { DiscoverResult, HistoryLink, IndexCoverage, SearchDiagnostics, TokenHit } from "@/lib/intel/types";

const HISTORY_KEY = "tek-links-v1";
const JOB_KEY = "tek-deep-job";

function loadHistory(): HistoryLink[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]") as HistoryLink[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function remember(result: DiscoverResult) {
  const prev = loadHistory();
  const next = [...prev];
  for (const token of result.tokens) {
    if (token.relationship !== "verified") continue;
    const known = next.some((link) => link.address === token.address && link.url === result.source.canonical);
    if (known) continue;
    next.unshift({
      address: token.address,
      chain: token.chain,
      handle: result.source.handle,
      url: result.source.canonical,
      recordedAt: new Date().toISOString(),
    });
  }
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(0, 40)));
}
function money(value?: number) {
  if (value == null || Number.isNaN(value)) return "—";
  if (value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function classLabel(token: TokenHit) {
  if (token.matchClass === "profile") return "Profile match";
  if (token.matchClass === "indirect") return "Indirect reference";
  if (token.matchClass === "historical") return "Historical";
  return "Exact match";
}

function CoveragePanel({ coverage }: { coverage: IndexCoverage }) {
  const failed = coverage.batches.filter((batch) => !batch.ok);
  return (
    <section className="mt-4 rounded-card border border-line bg-surface p-4 text-sm text-muted">
      <h2 className="text-base font-semibold text-fg">Index coverage</h2>
      <p className="mt-2 text-fg">
        {coverage.tokens} tokens indexed · {coverage.postLinks} post links · {coverage.records} records
      </p>
      <p className="mt-1">Oldest stored launch: {coverage.oldestLaunch?.slice(0, 19) || "none yet"}</p>
      <p>Last successful sync: {coverage.lastSuccess?.slice(0, 19) || "not yet"}</p>
      <p className="mt-1">Chains: {coverage.chains.join(", ") || "none yet"}</p>
      <p>
        Posts indexed:{" "}
        {coverage.platforms.length ? coverage.platforms.map((row) => `${row.platform} ${row.posts}`).join(", ") : "none yet"}
      </p>
      <ul className="mt-3 space-y-2">
        {coverage.windows.map((window) => (
          <li key={window.label}>
            <span className="text-fg">{window.label}: {window.tokens}</span>
            <span className="mt-0.5 block">{window.note}</span>
          </li>
        ))}
      </ul>
      {coverage.history.length ? (
        <ul className="mt-3 space-y-2">
          {coverage.history.map((row) => (
            <li key={row.provider}>
              <span className="text-fg">{row.provider}</span>
              {` · cursor ${row.cursor}`}
              {row.oldest ? ` · oldest seen ${row.oldest.slice(0, 19)}` : ""}
              {row.note ? <span className="mt-0.5 block">{row.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3">Historical checkpoints appear after the backfill worker’s first pass.</p>
      )}
      <p className="mt-3">{coverage.progress}</p>
      <p className="mt-2">{coverage.note}</p>
      <ul className="mt-2 space-y-1">
        {coverage.providers.map((provider) => (
          <li key={provider.provider}>
            {provider.provider}: {provider.ok ? `ok, ${provider.fetched} rows, ${provider.stored} links` : `failed (${provider.error || "unavailable"})`}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <p className="text-fg">Recent historical batches</p>
        {coverage.batches.length ? (
          <ul className="mt-1 space-y-1">
            {coverage.batches.map((batch) => (
              <li key={`${batch.provider}-${batch.finishedAt}-${batch.cursor}`}>
                {batch.provider} offset {batch.cursor}: {batch.ok ? "ok" : "failed"}
                {batch.error ? ` (${batch.error})` : ""} · {batch.fetched} fetched · {batch.stored} stored
                {batch.oldest ? ` · oldest ${batch.oldest.slice(0, 19)}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">No historical batches logged yet.</p>
        )}
        {!failed.length && coverage.batches.length ? <p className="mt-1">No failed batches in this log.</p> : null}
      </div>
    </section>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: SearchDiagnostics }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4 text-sm text-muted">
      <h2 className="text-base font-semibold text-fg">Search diagnostics</h2>
      <p className="mt-2 text-fg">{diagnostics.failure}</p>
      <dl className="mt-3 space-y-1">
        <div>Platform: {diagnostics.platform}</div>
        {diagnostics.searchKind === "profile" ? null : <div>Post id: {diagnostics.postId || "none"}</div>}
        <div>URL status: {diagnostics.normalization}. {diagnostics.normalizationDetail}</div>
        <div>Indexed tokens in the database: {diagnostics.tokensSearched}</div>
        <div>Indexed post links in the database: {diagnostics.postLinksSearched}</div>
        <div>Historical coverage: {diagnostics.historical}</div>
        <div>
          Matches: {diagnostics.exactMatches} exact, {diagnostics.profileMatches} profile, {diagnostics.indirectMatches} indirect, {diagnostics.historicalMatches} historical
        </div>
        <div>Live enrichment: {diagnostics.liveEnrichment}. {diagnostics.liveEnrichmentDetail}</div>
      </dl>
      <ul className="mt-3 space-y-1">
        {diagnostics.sourceNotes.map((note, index) => (
          <li key={`${index}-${note.slice(0, 48)}`}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

function DeepPanel({ job, onStop }: { job: DeepSearchView; onStop: () => void }) {
  const active = job.sources.find((source) => source.status === "running" || source.status === "waiting");
  const running = job.status === "running" || job.status === "waiting";
  const label =
    job.status === "complete"
      ? "Finished"
      : job.status === "incomplete"
        ? "Finished with limits"
        : job.status === "waiting"
          ? "Paused on a rate limit"
          : job.status === "missing"
            ? "Search not on this server"
            : "Scanning";
  return (
    <section className="mt-4 rounded-card border border-line bg-surface p-4 text-sm text-muted">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">Deep search</h2>
        <p className="text-fg">{label}{job.percent == null ? "" : ` · ${job.percent}% of connected ranges`}</p>
      </div>
      <p className="mt-2 text-fg">
        {job.discovered} tokens discovered · {job.scanned} rows scanned · {job.metadataOk} metadata reads succeeded · {job.matches} verified {job.matches === 1 ? "match" : "matches"}
      </p>
      <p className="mt-1">Launch times seen: {job.oldestLaunch?.slice(0, 19) || "none yet"} to {job.newestLaunch?.slice(0, 19) || "none yet"}</p>
      <p className="mt-1">Current source: {active ? active.label : running ? "between sources" : "none"}</p>
      <p className="mt-2">{job.note}</p>
      {running ? (
        <button
          type="button"
          onClick={onStop}
          className="mt-3 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-fg"
        >
          Stop search
        </button>
      ) : null}
      {job.errors.length ? (
        <ul className="mt-2 space-y-1 text-warn">
          {job.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-3 space-y-2">
        {job.sources.map((source) => (
          <li key={source.id}>
            <span className="text-fg">{source.label}</span>
            {` · ${source.status} · ${source.scanned} scanned · ${source.metadataOk} metadata`}
            {source.oldest ? ` · ${source.oldest.slice(0, 10)}` : ""}
            {source.newest ? ` to ${source.newest.slice(0, 10)}` : ""}
            <span className="mt-0.5 block">{source.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function statusLine(token: TokenHit) {
  if (token.existence === "verified") return "Verified on-chain";
  if (token.existence === "provider_unavailable") return "Provider unavailable";
  return "Not found on-chain";
}

function marketLine(token: TokenHit) {
  if (token.marketStatus === "available") return null;
  if (token.marketStatus === "provider_unavailable") return "Provider unavailable: pricing could not be retrieved.";
  return "Market data unavailable: the token exists but pricing or liquidity was not returned.";
}

function TokenCard({ token }: { token: TokenHit }) {
  const [copied, setCopied] = useState(false);
  const [logoOk, setLogoOk] = useState(true);
  const name = token.name?.value;
  const symbol = token.symbol?.value;

  async function copy() {
    await navigator.clipboard.writeText(token.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <article className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          {token.logo && logoOk ? (
            <img
              src={token.logo}
              alt=""
              className="size-12 shrink-0 rounded-md bg-surface-2 object-cover"
              onError={() => setLogoOk(false)}
            />
          ) : (
            <div className="size-12 shrink-0 rounded-md bg-surface-2" />
          )}
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-fg">
              {name || "Metadata unavailable"}
              {symbol ? <span className="font-mono text-sm text-muted"> ${symbol}</span> : null}
            </p>
            <p className="mt-1 text-sm text-muted">
              {token.chain}
              {token.launchpad ? ` · ${token.launchpad}` : ""}
              {token.dex ? ` · ${token.markets.length > 1 ? `${token.markets.length} pools` : token.dex}` : ""}
              {" · "}
              {statusLine(token)}
            </p>
            {token.createdAt ? (
              <p className="mt-1 text-xs text-muted">
                Launched {token.createdAt.slice(0, 10)}
                {agePhrase(token.createdAt) ? ` · ${agePhrase(token.createdAt)}` : ""}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">Launch date unavailable</p>
            )}
            {token.linkOrigin ? <p className="mt-1 text-xs text-muted">Link {originPhrase(token.linkOrigin)}.</p> : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className={`font-mono text-sm ${token.matchClass === "exact" || token.matchClass === "profile" ? "text-accent" : "text-warn"}`}>{classLabel(token)}</p>
        </div>
      </div>

      {!symbol ? <p className="mt-2 text-sm text-warn">Metadata unavailable: name or ticker could not be resolved.</p> : null}
      {marketLine(token) ? <p className="mt-2 text-sm text-warn">{marketLine(token)}</p> : null}
      {token.relationship === "historical" ? (
        <p className="mt-2 text-sm text-warn">Historical match: a later snapshot of this token no longer lists this post.</p>
      ) : null}
      {token.identityConflicts.map((conflict) => (
        <p key={conflict} className="mt-2 text-sm text-warn">
          {conflict}
        </p>
      ))}

      <code className="mt-3 block break-all rounded-md bg-surface-2 px-2 py-2 font-mono text-xs text-fg">{token.address}</code>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-11 items-center gap-1 rounded-md border border-line px-3 text-sm text-fg"
        >
          <Copy className="size-4" />
          {copied ? "Copied" : "Copy address"}
        </button>
        {token.launchpadUrl ? (
          <a
            href={token.launchpadUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 rounded-md border border-line px-3 text-sm text-accent"
          >
            Launchpad <ExternalLink className="size-4" />
          </a>
        ) : null}
        {token.pairUrl ? (
          <a
            href={token.pairUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 rounded-md border border-line px-3 text-sm text-accent"
          >
            Chart <ExternalLink className="size-4" />
          </a>
        ) : null}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted">Price</dt>
          <dd className="font-mono text-fg">{token.marketStatus === "available" ? money(token.priceUsd) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Liquidity</dt>
          <dd className="font-mono text-fg">{token.marketStatus === "available" ? money(token.liquidityUsd) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Mcap</dt>
          <dd className="font-mono text-fg">{token.marketStatus === "available" ? money(token.marketCap) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Volume</dt>
          <dd className="font-mono text-fg">{token.marketStatus === "available" ? money(token.volume24h) : "—"}</dd>
        </div>
      </dl>

      {token.name ? (
        <p className="mt-3 font-mono text-xs text-muted">
          Name from {token.name.source} · {token.name.status} · {token.name.retrievedAt.slice(0, 19)}
        </p>
      ) : null}
      {token.symbol ? (
        <p className="font-mono text-xs text-muted">
          Ticker from {token.symbol.source} · {token.symbol.status}
        </p>
      ) : null}

      {token.markets.length > 1 ? (
        <ul className="mt-3 space-y-1 text-sm text-muted">
          {token.markets.slice(0, 6).map((market) => (
            <li key={market.pairUrl || market.dex}>
              {market.dex || "pool"} · liq {money(market.liquidityUsd)} · vol {money(market.volume24h)}
              {market.pairUrl ? (
                <>
                  {" "}
                  <a href={market.pairUrl} target="_blank" rel="noreferrer" className="text-accent">
                    chart
                  </a>
                </>
              ) : null}
            </li>
          ))}
          {token.markets.length > 6 ? <li>and {token.markets.length - 6} more pools</li> : null}
        </ul>
      ) : null}
      <ul className="mt-3 space-y-1 text-sm text-muted">
        {token.evidence.map((item) => (
          <li key={`${item.kind}-${item.detail}`} className="break-all">
            {item.detail}
          </li>
        ))}
      </ul>
      {token.relationship === "unverified" ? (
        <p className="mt-2 text-sm text-warn">Relationship unverified: the token exists, but it is not tied to this post.</p>
      ) : null}
    </article>
  );
}

export function TekApp() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [coverage, setCoverage] = useState<IndexCoverage | null>(null);
  const [narrative, setNarrative] = useState("");
  const [narrating, setNarrating] = useState(false);
  const [page, setPage] = useState(0);
  const [job, setJob] = useState<DeepSearchView | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);
  const finishedJob = useRef("");
  const pageSize = 12;
  const searching = busy || deepBusy || job?.status === "running" || job?.status === "waiting";

  useEffect(() => {
    warmupIndex({ data: {} })
      .then((data) => setCoverage(data))
      .catch(() => undefined);
    const saved = sessionStorage.getItem(JOB_KEY);
    if (!saved) return;
    readDeepSearch({ data: { id: saved } })
      .then(setJob)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "waiting")) return;
    const timer = window.setInterval(() => {
      readDeepSearch({ data: { id: job.id } })
        .then(setJob)
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job || job.status === "running" || job.status === "waiting" || job.status === "missing") return;
    if (!job.url || finishedJob.current === job.id) return;
    finishedJob.current = job.id;
    setDeepBusy(false);
    discoverTokens({ data: { url: job.url, history: loadHistory() } })
      .then((data) => {
        setResult(data);
        if (data.coverage) setCoverage(data.coverage);
        setPage(0);
        remember(data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the finished search."));
  }, [job]);

  async function onScan(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNarrative("");
    try {
      const data = await discoverTokens({ data: { url, history: loadHistory() } });
      setResult(data);
      if (data.coverage) setCoverage(data.coverage);
      setPage(0);
      remember(data);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Scan failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    if (!job) return;
    setError("");
    try {
      const data = await stopDeepSearch({ data: { id: job.id } });
      setJob(data);
      setDeepBusy(false);
    } catch (err) {
      setDeepBusy(false);
      setError(err instanceof Error ? err.message : "Could not stop the search.");
    }
  }

  async function onDeep() {
    if (!url.trim()) return;
    setDeepBusy(true);
    setError("");
    setNarrative("");
    setResult(null);
    try {
      const data = await startDeepSearch({ data: { url } });
      setJob(data);
      sessionStorage.setItem(JOB_KEY, data.id);
      if (data.status !== "running" && data.status !== "waiting") setDeepBusy(false);
    } catch (err) {
      setDeepBusy(false);
      setError(err instanceof Error ? err.message : "Deep search failed.");
    }
  }

  async function onNarrative() {
    if (!url.trim()) return;
    setNarrating(true);
    setNarrative("");
    try {
      const reply = await narratePost({ data: { url } });
      setNarrative(reply.ok ? reply.text : reply.error);
    } catch (err) {
      setNarrative(err instanceof Error ? err.message : "Narrative failed.");
    } finally {
      setNarrating(false);
    }
  }

  const shown = result?.coverage || coverage;
  const exactCount = result?.tokens.filter((token) => token.matchClass === "exact").length ?? 0;
  const profileCount = result?.tokens.filter((token) => token.matchClass === "profile").length ?? 0;
  const indirectCount = result?.tokens.filter((token) => token.matchClass === "indirect").length ?? 0;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-8">
        <p className="font-mono text-xs tracking-widest text-accent">TEK</p>
        <h1 className="mt-2 text-3xl font-semibold text-fg">Post to coins</h1>
        <p className="mt-2 max-w-xl text-base leading-relaxed text-muted">
          Paste one X, TikTok, or Instagram post or profile. A post returns coins that cite that exact post, and also coins that cite that account's profile. A profile returns coins that cite that account, including a post on the account. Only coins launched in the last 30 days are kept.
        </p>
        <a
          href="/tek-project.zip"
          download="tek-project.zip"
          className="mt-4 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-fg"
        >
          Download project zip
        </a>
      </header>

      <form onSubmit={onScan} className="space-y-3 rounded-card border border-line bg-surface p-4">
        <label className="block text-sm text-muted" htmlFor="url">
          Post or profile link
        </label>
        <input
          id="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          placeholder="https://x.com/name or a status link"
          className="w-full rounded-md border border-line bg-bg px-3 py-3 text-fg outline-none placeholder:text-muted"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onDeep}
            disabled={searching || !url.trim()}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-60"
          >
            {job?.status === "running" || job?.status === "waiting" || deepBusy ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
            {job?.status === "running" || job?.status === "waiting" || deepBusy ? "Deep search running" : "Deep search"}
          </button>
          <button
            type="submit"
            disabled={searching || !url.trim()}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-4 py-2 font-medium text-fg disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
            {busy ? "Quick search" : "Quick search"}
          </button>
          <button
            type="button"
            onClick={onNarrative}
            disabled={narrating || !url.trim()}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm text-fg disabled:opacity-50"
          >
            {narrating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Unverified narrative
          </button>
        </div>
      </form>

      {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}
      {job ? <DeepPanel job={job} onStop={onStop} /> : null}
      {job && !result && job.hits.length ? (
        <section className="mt-4 space-y-2">
          <h2 className="text-lg font-semibold text-fg">{job.hits.length} verified {job.hits.length === 1 ? "match" : "matches"} so far</h2>
          <p className="text-sm text-muted">Matches stay visible while the lists finish. The search stops when those lists end, or sooner if metadata hits a rate limit.</p>
          {job.hits.map((hit) => (
            <article key={`${hit.chain}:${hit.address}`} className="rounded-card border border-line bg-surface p-4 text-sm">
              <p className="font-medium text-fg">{hit.name || "Unnamed"}{hit.symbol ? ` · ${hit.symbol}` : ""}</p>
              <p className="mt-1 break-all font-mono text-fg">{hit.address}</p>
              <p className="mt-1 text-muted">{hit.chain} · {hit.source} · {hit.linkField} · {hit.rawUrl}</p>
              <p className="mt-1 text-muted">Launch {hit.createdAt?.slice(0, 19) || "unknown"} · {originPhrase(hit.linkOrigin)}</p>
            </article>
          ))}
        </section>
      ) : null}
      {narrative && !result ? (
        <p className="mt-4 rounded-card border border-line bg-surface-2 p-4 text-sm leading-relaxed text-warn">
          Unverified narrative, not a match. {narrative}
        </p>
      ) : null}
      {!result && shown ? <CoveragePanel coverage={shown} /> : null}

      {result ? (
        <section className="mt-8 space-y-4">
          <div className="rounded-card border border-line bg-surface-2 p-4">
            <p className="text-sm text-muted">
              {result.diagnostics.searchKind === "profile" ? "Profile" : "Post"} {result.source.platform}
              {result.source.postId ? ` · ${result.source.postId}` : ""}
              {result.source.handle ? ` · @${result.source.handle}` : ""} · {result.durationMs} ms
            </p>
            <p className="mt-2 break-all text-sm text-fg">{result.source.canonical}</p>
            {result.source.text ? (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">{result.source.text}</p>
            ) : (
              <p className="mt-2 text-sm text-muted">
                {result.diagnostics.searchKind === "profile"
                  ? "Searched indexed token metadata for this profile. A coin counts when its metadata cites the account or a post on the account."
                  : result.source.handle
                    ? "Searched indexed token metadata for this exact post, and for coins that cite this account's profile. A profile link counts even when it is not this post."
                    : "Searched indexed token metadata for this exact post. This link has no account name, so profile links were not searched."}
              </p>
            )}
          </div>

          {result.warnings.map((warning) => (
            <p key={warning} className="text-sm text-warn">
              {warning}
            </p>
          ))}

          {result.tokens.length > 0 ? (
            <>
              <h2 className="text-lg font-semibold text-fg">
                {result.tokens.length} indexed · {exactCount} exact
                {profileCount ? ` · ${profileCount} profile` : ""}
                {indirectCount ? ` · ${indirectCount} indirect` : ""}
              </h2>
              <p className="text-sm text-muted">Every indexed age is included, including inactive and low-liquidity coins. Pages are only a display limit.</p>
            </>
          ) : null}

          {narrative ? (
            <p className="rounded-card border border-line bg-surface-2 p-4 text-sm leading-relaxed text-warn">
              Unverified narrative, not a match. {narrative}
            </p>
          ) : null}

          <div className="space-y-3">
            {result.tokens.slice(page * pageSize, page * pageSize + pageSize).map((token) => (
              <TokenCard key={`${token.chain}:${token.address}`} token={token} />
            ))}
          </div>
          {result.tokens.length > pageSize ? (
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                className="min-h-11 rounded-md border border-line px-3 text-sm text-fg disabled:opacity-40"
              >
                Previous
              </button>
              <p className="text-sm text-muted">
                {page + 1} / {Math.ceil(result.tokens.length / pageSize)}
              </p>
              <button
                type="button"
                disabled={(page + 1) * pageSize >= result.tokens.length}
                onClick={() => setPage((current) => current + 1)}
                className="min-h-11 rounded-md border border-line px-3 text-sm text-fg disabled:opacity-40"
              >
                Next
              </button>
            </div>
          ) : null}
          <DiagnosticsPanel diagnostics={result.diagnostics} />
          {shown ? <CoveragePanel coverage={shown} /> : null}
        </section>
      ) : null}
    </main>
  );
}
