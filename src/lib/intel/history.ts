import type { Evidence, HistoryLink, RelationshipStatus, TokenHit } from "./types";

export function historyForContext(history: HistoryLink[], handle?: string, url?: string): HistoryLink[] {
  const handleKey = handle?.toLowerCase();
  return history.filter((link) => {
    if (url && link.url && link.url === url) return true;
    if (handleKey && link.handle && link.handle.toLowerCase() === handleKey) return true;
    return false;
  });
}

export function historicalEvidence(link: HistoryLink): Evidence {
  const when = link.recordedAt.slice(0, 10);
  const where = link.url || (link.handle ? `@${link.handle}` : "an earlier scan");
  return {
    kind: "historical",
    score: 0.8,
    detail: `Retained link from ${when} (${where}). A later change to the token's social profile does not erase this record.`,
  };
}

export function attachHistory(token: TokenHit, links: HistoryLink[]): TokenHit {
  const match = links.find((link) => link.address.toLowerCase() === token.address.toLowerCase());
  if (!match) return token;
  if (token.evidence.some((item) => item.kind === "historical")) return token;
  const evidence = [...token.evidence, historicalEvidence(match)];
  const relationship: RelationshipStatus =
    token.relationship === "verified" ? "verified" : "historical";
  return { ...token, evidence, relationship, confidence: Math.max(token.confidence, 0.7) };
}
