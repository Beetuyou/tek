import type { ExistenceStatus, IdentityField } from "./types";

const SOL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOL_RPC = "https://api.mainnet-beta.solana.com";

const EVM_RPCS: { chain: string; rpc: string }[] = [
  { chain: "ethereum", rpc: "https://ethereum.publicnode.com" },
  { chain: "base", rpc: "https://base.publicnode.com" },
  { chain: "bsc", rpc: "https://bsc.publicnode.com" },
];

export type ChainRead = {
  chain: string;
  address: string;
  existence: ExistenceStatus;
  name?: IdentityField;
  symbol?: IdentityField;
  detail?: string;
};

async function postJson(url: string, body: unknown, ms = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!text.startsWith("{") && !text.startsWith("[")) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function field(value: string, source: string, status: IdentityField["status"]): IdentityField {
  return { value, source, retrievedAt: new Date().toISOString(), status };
}

function decodeAbi(hex?: string): string | null {
  if (!hex || hex === "0x") return null;
  const h = hex.slice(2);
  if (h.length === 64) {
    const raw = Buffer.from(h, "hex");
    const end = raw.indexOf(0);
    const text = raw.subarray(0, end === -1 ? raw.length : end).toString("utf8").trim();
    return /^[\x20-\x7E]{1,32}$/.test(text) ? text : null;
  }
  if (h.length < 128) return null;
  const len = Number.parseInt(h.slice(64, 128), 16);
  if (!Number.isFinite(len) || len <= 0 || len > 64) return null;
  const text = Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8").trim();
  return text || null;
}

export async function readSolanaMint(address: string): Promise<ChainRead> {
  try {
    const body = (await postJson(SOL_RPC, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "jsonParsed" }],
    })) as { result?: { value?: { owner?: string; data?: { parsed?: { type?: string; info?: { extensions?: { extension: string; state?: { name?: string; symbol?: string } }[] } } } } | null }; error?: { message?: string } };
    if (body.error) {
      return { chain: "solana", address, existence: "provider_unavailable", detail: body.error.message };
    }
    const value = body.result?.value;
    if (!value) return { chain: "solana", address, existence: "not_found", detail: "No Solana account at this address." };
    const owner = value.owner;
    const parsed = value.data?.parsed;
    if ((owner !== SOL_TOKEN && owner !== SOL_TOKEN_2022) || parsed?.type !== "mint") {
      return { chain: "solana", address, existence: "not_found", detail: "Account is not an SPL mint." };
    }
    const meta = parsed.info?.extensions?.find((item) => item.extension === "tokenMetadata")?.state;
    const read: ChainRead = { chain: "solana", address, existence: "verified" };
    if (meta?.name) read.name = field(meta.name, "solana-token-metadata", "verified");
    if (meta?.symbol) read.symbol = field(meta.symbol, "solana-token-metadata", "verified");
    if (!read.symbol) read.detail = "Mint exists. On-chain token metadata extension has no symbol.";
    return read;
  } catch (err) {
    return {
      chain: "solana",
      address,
      existence: "provider_unavailable",
      detail: err instanceof Error ? err.message : "Solana RPC failed",
    };
  }
}

async function evmString(rpc: string, address: string, selector: string): Promise<string | null> {
  const body = (await postJson(rpc, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: address, data: selector }, "latest"],
  })) as { result?: string };
  return decodeAbi(body.result);
}

export async function readEvmToken(address: string): Promise<ChainRead> {
  let lastError = "No EVM RPC responded.";
  for (const target of EVM_RPCS) {
    try {
      const codeBody = (await postJson(target.rpc, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      })) as { result?: string };
      const code = codeBody.result || "0x";
      if (code === "0x" || code === "0x0") continue;
      const name = await evmString(target.rpc, address, "0x06fdde03");
      const symbol = await evmString(target.rpc, address, "0x95d89b41");
      const read: ChainRead = { chain: target.chain, address, existence: "verified" };
      if (name) read.name = field(name, `${target.chain}:name()`, "verified");
      if (symbol) read.symbol = field(symbol, `${target.chain}:symbol()`, "verified");
      if (!read.symbol) read.detail = "Contract code exists. name() or symbol() did not return a string.";
      return read;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "RPC failed";
    }
  }
  const failedAll = lastError.includes("HTTP") || lastError.includes("RPC") || lastError.includes("abort");
  if (failedAll && lastError !== "No EVM RPC responded.") {
    return { chain: "evm", address, existence: "provider_unavailable", detail: lastError };
  }
  return { chain: "evm", address, existence: "not_found", detail: "No contract code on Ethereum, Base, or BNB Chain." };
}

export async function readChain(address: string): Promise<ChainRead> {
  if (address.startsWith("0x")) return readEvmToken(address);
  return readSolanaMint(address);
}
