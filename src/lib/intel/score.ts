import type { Evidence, RelationshipStatus, TokenHit } from "./types";

function handleOf(urlOrHandle?: string): string | undefined {
  if (!urlOrHandle) return undefined;
  const fromUrl = urlOrHandle.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return urlOrHandle.replace(/^@/, "").toLowerCase();
}

export function relateToken(
  token: Omit<TokenHit, "confidence" | "relationship" | "evidence"> & { evidence?: Evidence[] },
  ctx: { handle?: string; cas: string[]; tickers: string[] },
): TokenHit {
  const evidence: Evidence[] = [...(token.evidence ?? [])];
  const address = token.address.toLowerCase();
  const symbol = token.symbol?.value;

  if (ctx.cas.some((ca) => ca.toLowerCase() === address) && !evidence.some((item) => item.kind === "ca_in_post")) {
    evidence.push({
      kind: "ca_in_post",
      score: 1,
      detail: "This contract was in the optional caption. It was not found via indexed post metadata.",
    });
  }

  const socialHandle = handleOf(token.twitter);
  if (ctx.handle && socialHandle && socialHandle === ctx.handle.toLowerCase()) {
    evidence.push({
      kind: "author_social",
      score: 0.9,
      detail: `A provider lists @${ctx.handle} on the token. A profile is not this post.`,
    });
  }

  if (symbol && ctx.tickers.some((ticker) => ticker.toUpperCase() === symbol.toUpperCase())) {
    evidence.push({
      kind: "ticker_match",
      score: 0.72,
      detail: `On-record ticker $${symbol} is written in the post. This is not proof by itself.`,
    });
  }

  const verified = evidence.some((item) => item.kind === "ca_in_post" || item.kind === "historical" || item.kind === "indexed_post");
  const relationship: RelationshipStatus = verified ? "verified" : "unverified";
  const confidence = verified
    ? Math.min(1, evidence.reduce((sum, item) => sum + item.score, 0) / 1.15)
    : 0;

  return { ...token, evidence, relationship, confidence, identityConflicts: token.identityConflicts ?? [] };
}
