"""
Tweet Coin Bot - Web app to find crypto coins/CAs linked to a tweet.
Uses DexScreener public API + optional xAI Grok for analysis.
"""

import os
import re
import json
import requests
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

DEX_BASE = "https://api.dexscreener.com"

# Regex patterns
SOLANA_CA = re.compile(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b')
EVM_CA = re.compile(r'\b0x[a-fA-F0-9]{40}\b')
TICKER = re.compile(r'\$([A-Za-z]{2,10})\b')
TWEET_URL = re.compile(r'(?:twitter\.com|x\.com)/([A-Za-z0-9_]+)/status/(\d+)')

def extract_from_text(text: str):
    """Extract CAs, tickers, and potential handles from text."""
    sol_cas = list(set(SOLANA_CA.findall(text)))
    evm_cas = list(set(EVM_CA.findall(text)))
    tickers = list(set(TICKER.findall(text)))
    return {
        "solana_cas": sol_cas,
        "evm_cas": evm_cas,
        "tickers": tickers,
    }

def parse_tweet_url(url: str):
    m = TWEET_URL.search(url)
    if m:
        return {"handle": m.group(1), "tweet_id": m.group(2)}
    return None

def search_dex(query: str, limit=10):
    """Search DexScreener for pairs matching query."""
    try:
        r = requests.get(f"{DEX_BASE}/latest/dex/search", params={"q": query}, timeout=10)
        if r.status_code == 200:
            data = r.json()
            pairs = data.get("pairs") or []
            # Prefer higher liquidity
            pairs.sort(key=lambda p: p.get("liquidity", {}).get("usd", 0) or 0, reverse=True)
            return pairs[:limit]
    except Exception as e:
        print(f"Dex search error: {e}")
    return []

def get_token_pairs(chain: str, address: str):
    """Get pairs for a specific token address."""
    try:
        r = requests.get(f"{DEX_BASE}/tokens/v1/{chain}/{address}", timeout=10)
        if r.status_code == 200:
            return r.json() or []
    except Exception:
        pass
    return []

def enrich_pair(pair):
    """Clean pair data for frontend."""
    base = pair.get("baseToken", {})
    info = pair.get("info") or {}
    socials = info.get("socials") or []
    websites = info.get("websites") or []
    return {
        "chain": pair.get("chainId"),
        "symbol": base.get("symbol"),
        "name": base.get("name"),
        "address": base.get("address"),
        "price_usd": pair.get("priceUsd"),
        "liquidity_usd": pair.get("liquidity", {}).get("usd"),
        "volume_24h": pair.get("volume", {}).get("h24"),
        "market_cap": pair.get("marketCap"),
        "fdv": pair.get("fdv"),
        "price_change_24h": pair.get("priceChange", {}).get("h24"),
        "url": pair.get("url"),
        "dex": pair.get("dexId"),
        "socials": socials,
        "websites": websites,
        "image": info.get("imageUrl"),
        "pair_address": pair.get("pairAddress"),
    }

def find_coins_for_tweet(tweet_text: str, tweet_url: str = None, handle: str = None):
    """Main logic: extract + search DexScreener."""
    results = []
    seen_addresses = set()

    extracted = extract_from_text(tweet_text)
    
    # Direct CA lookups
    for ca in extracted["solana_cas"]:
        pairs = get_token_pairs("solana", ca)
        for p in pairs[:3]:
            addr = p.get("baseToken", {}).get("address")
            if addr and addr not in seen_addresses:
                seen_addresses.add(addr)
                results.append({"source": "direct_ca_solana", "pair": enrich_pair(p)})

    for ca in extracted["evm_cas"]:
        # Try common chains
        for chain in ["ethereum", "base", "bsc", "arbitrum"]:
            pairs = get_token_pairs(chain, ca)
            for p in pairs[:2]:
                addr = p.get("baseToken", {}).get("address")
                if addr and addr not in seen_addresses:
                    seen_addresses.add(addr)
                    results.append({"source": f"direct_ca_{chain}", "pair": enrich_pair(p)})

    # Ticker searches
    for ticker in extracted["tickers"]:
        pairs = search_dex(ticker, limit=5)
        for p in pairs:
            addr = p.get("baseToken", {}).get("address")
            if addr and addr not in seen_addresses:
                seen_addresses.add(addr)
                results.append({"source": f"ticker_{ticker}", "pair": enrich_pair(p)})

    # Handle / Twitter search (coins that list this Twitter)
    if handle:
        pairs = search_dex(handle, limit=8)
        for p in pairs:
            addr = p.get("baseToken", {}).get("address")
            if addr and addr not in seen_addresses:
                # Check if socials mention the handle
                socials = (p.get("info") or {}).get("socials") or []
                twitter_match = any(
                    handle.lower() in (s.get("handle") or "").lower() or 
                    handle.lower() in (s.get("url") or "").lower()
                    for s in socials
                )
                source = "twitter_handle_match" if twitter_match else "search_by_handle"
                seen_addresses.add(addr)
                results.append({"source": source, "pair": enrich_pair(p)})

    # Deduplicate and sort by liquidity
    results.sort(key=lambda r: r["pair"].get("liquidity_usd") or 0, reverse=True)
    return {
        "extracted": extracted,
        "handle": handle,
        "results": results[:20],  # top 20
        "count": len(results),
    }

# Optional Grok analysis placeholder
def grok_analyze(tweet_text: str, api_key: str = None):
    if not api_key:
        return {"note": "Provide XAI_API_KEY for Grok-powered analysis of the tweet."}
    # In production: call https://api.x.ai/v1/responses or chat completions
    # with tools for x_search if needed
    return {"note": "Grok analysis would run here with the provided key.", "status": "placeholder"}

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.get_json() or {}
    tweet_url = data.get("tweet_url", "").strip()
    tweet_text = data.get("tweet_text", "").strip()
    api_key = data.get("xai_api_key")  # optional, never store

    handle = None
    tweet_id = None
    if tweet_url:
        parsed = parse_tweet_url(tweet_url)
        if parsed:
            handle = parsed["handle"]
            tweet_id = parsed["tweet_id"]

    if not tweet_text and not tweet_url:
        return jsonify({"error": "Provide tweet_url or tweet_text"}), 400

    # If only URL, we still search by handle
    result = find_coins_for_tweet(tweet_text, tweet_url, handle)
    result["grok"] = grok_analyze(tweet_text, api_key)
    result["tweet_id"] = tweet_id
    return jsonify(result)

# Simple embedded HTML template
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tweet Coin Bot - Find Coins Linked to a Tweet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --accent: #58a6ff; --green: #3fb950; --text: #c9d1d9; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; }
  h1 { text-align: center; color: #fff; }
  .container { max-width: 900px; margin: 0 auto; }
  .form { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 20px; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; }
  input, textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid var(--border); background: #0d1117; color: var(--text); font-size: 14px; }
  button { background: var(--accent); color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 10px; }
  button:hover { opacity: 0.9; }
  .results { display: grid; gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card h3 { margin: 0 0 8px; color: #fff; }
  .meta { font-size: 13px; color: #8b949e; }
  .ca { font-family: monospace; background: #21262d; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #238636; color: #fff; margin-right: 6px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .loading { text-align: center; padding: 40px; }
  .extracted { background: #21262d; padding: 10px; border-radius: 6px; margin: 10px 0; font-size: 13px; }
</style>
</head>
<body>
<div class="container">
  <h1>🐦 Tweet Coin Bot</h1>
  <p style="text-align:center; color:#8b949e;">Paste a tweet URL or text → find linked coins + contract addresses across DexScreener / socials</p>

  <div class="form">
    <label>Tweet URL (optional, extracts handle)</label>
    <input type="text" id="tweetUrl" placeholder="https://x.com/username/status/1234567890">

    <label>Tweet Text (paste the tweet content for best results)</label>
    <textarea id="tweetText" rows="4" placeholder="Paste the full tweet text here, including any CAs or $tickers..."></textarea>

    <label>Optional: xAI API Key (for future Grok analysis — never stored)</label>
    <input type="password" id="apiKey" placeholder="xai-... (optional)">

    <button onclick="analyze()">Find Linked Coins</button>
  </div>

  <div id="output"></div>
</div>

<script>
async function analyze() {
  const url = document.getElementById('tweetUrl').value;
  const text = document.getElementById('tweetText').value;
  const key = document.getElementById('apiKey').value;
  const output = document.getElementById('output');
  output.innerHTML = '<div class="loading">Searching DexScreener and extracting...</div>';

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweet_url: url, tweet_text: text, xai_api_key: key || null })
    });
    const data = await res.json();
    render(data);
  } catch (e) {
    output.innerHTML = '<div class="card">Error: ' + e.message + '</div>';
  }
}

function render(data) {
  const output = document.getElementById('output');
  if (data.error) {
    output.innerHTML = '<div class="card">' + data.error + '</div>';
    return;
  }

  let html = '';
  if (data.extracted) {
    const e = data.extracted;
    html += `<div class="extracted">
      <strong>Extracted:</strong> 
      Solana CAs: ${e.solana_cas.length} · EVM CAs: ${e.evm_cas.length} · Tickers: ${e.tickers.join(', ') || 'none'}
      ${data.handle ? ' · Handle: @' + data.handle : ''}
    </div>`;
  }

  if (!data.results || data.results.length === 0) {
    html += '<div class="card">No matching coins found. Try pasting more of the tweet text or check if the account has linked tokens on DexScreener.</div>';
    output.innerHTML = html;
    return;
  }

  html += `<h2 style="color:#fff">${data.results.length} coin(s) found</h2><div class="results">`;
  for (const item of data.results) {
    const p = item.pair;
    const liq = p.liquidity_usd ? '$' + Number(p.liquidity_usd).toLocaleString() : '—';
    const mc = p.market_cap ? '$' + Number(p.market_cap).toLocaleString() : '—';
    const chg = p.price_change_24h != null ? (p.price_change_24h > 0 ? '+' : '') + p.price_change_24h.toFixed(1) + '%' : '';
    const socials = (p.socials || []).map(s => `<a href="${s.url || '#'}" target="_blank">${s.platform || s.type}: ${s.handle || ''}</a>`).join(' · ') || '—';

    html += `
      <div class="card">
        <span class="badge">${item.source}</span>
        <h3>${p.name || p.symbol} <span style="color:#8b949e">(${p.symbol})</span></h3>
        <div class="meta">
          Chain: <strong>${p.chain}</strong> · Liq: ${liq} · MC: ${mc} · 24h: ${chg}<br>
          CA: <span class="ca">${p.address}</span><br>
          Socials: ${socials}<br>
          <a href="${p.url}" target="_blank">Open on DexScreener →</a>
          ${p.image ? `<br><img src="${p.image}" style="max-height:40px; margin-top:6px; border-radius:4px;">` : ''}
        </div>
      </div>`;
  }
  html += '</div>';
  if (data.grok && data.grok.note) {
    html += `<div class="card" style="margin-top:16px; font-size:13px; color:#8b949e;">${data.grok.note}</div>`;
  }
  output.innerHTML = html;
}
</script>
</body>
</html>
"""

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
