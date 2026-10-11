const EVM = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
const URLS = /https?:\/\/[^\s)>"']+/gi;

const PUMP = /pump\.fun\/(?:coin\/|token\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/i;
const DEX_PATH = /dexscreener\.com\/([a-z0-9]+)\/([A-Za-z0-9]{32,66})/i;

function looksLikeMint(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  if (!/\d/.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  return true;
}

export function extractSignals(text: string): { cas: string[]; tickers: string[]; links: string[] } {
  const cas = new Set<string>();
  const links = new Set<string>();

  for (const match of text.matchAll(EVM)) cas.add(match[0]);

  for (const raw of text.matchAll(URLS)) {
    const link = raw[0].replace(/[.,;]+$/, "");
    links.add(link);
    const pump = link.match(PUMP);
    if (pump) cas.add(pump[1]);
    const dex = link.match(DEX_PATH);
    if (dex && looksLikeMint(dex[2])) cas.add(dex[2]);
    if (dex && /^0x[a-fA-F0-9]{40}$/.test(dex[2])) cas.add(dex[2]);
  }

  for (const match of text.matchAll(SOL)) {
    if (looksLikeMint(match[0])) cas.add(match[0]);
  }

  const tickers = [...new Set([...text.matchAll(TICKER)].map((m) => m[1].toUpperCase()))];
  return { cas: [...cas], tickers, links: [...links] };
}
