# Tweet Coin Bot

Web-hosted tool (Flask) that takes a tweet URL or text and finds linked crypto coins + contract addresses (CA) across DexScreener and socials.

**Zero-config deployable to Vercel.**

## What it does

- Extracts Solana CAs, EVM CAs, and `$TICKER`s from the tweet text.
- Looks up those CAs/tickers on DexScreener for live data (price, liquidity, MC, socials).
- Searches by the Twitter/X handle from the tweet URL to find tokens that list that account in their socials.
- Shows source of match (direct CA, ticker, twitter handle match, etc.).
- Optional placeholder for xAI Grok API analysis (pass key in the form; never stored).

## Deploy to Vercel (recommended)

Vercel now supports Flask with zero configuration. It looks for an `app = Flask(...)` instance in `app.py`.

### Option 1: Vercel CLI (fastest)

```bash
# Install Vercel CLI (once)
npm i -g vercel

# From the project folder
cd tweet-coin-bot
vercel
```

Follow the prompts (link to your Vercel account). Then:

```bash
vercel --prod
```

### Option 2: Git push

1. Push this folder to a GitHub/GitLab/Bitbucket repo.
2. Go to [vercel.com/new](https://vercel.com/new), import the repo.
3. Framework preset: **Other** (or it may auto-detect Flask).
4. Deploy. Vercel installs from `requirements.txt` and serves the Flask app.

### Local test with Vercel runtime

```bash
npm i -g vercel
vercel dev
```

Opens at `http://localhost:3000`.

### Notes for Vercel

- The app is packaged as a single Vercel Function (Fluid compute).
- `vercel.json` sets `maxDuration` to 30s so DexScreener lookups don't timeout on the free tier.
- Frontend is fully embedded in `app.py` — no separate static build needed.
- CORS is already enabled via `flask-cors`.

## Quick start (local, non-Vercel)

```bash
cd tweet-coin-bot
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000

## Usage

1. Paste a tweet URL (to auto-extract the author handle).
2. Paste the tweet text (highly recommended for CA/ticker extraction).
3. Click "Find Linked Coins".
4. Results show CA, chain, liquidity, market cap, socials, and DexScreener link.

## Extending with Grok

The `/api/analyze` endpoint accepts an optional `xai_api_key`. You can extend `grok_analyze()` to call:

```
POST https://api.x.ai/v1/responses
Authorization: Bearer <key>
{
  "model": "grok-4.7",
  "input": "Analyze this tweet for linked meme coins or launches: ...",
  "tools": [{"type": "x_search"}, {"type": "web_search"}]
}
```

This lets Grok pull the full tweet, replies, and related socials for deeper linking.

## Notes

- DexScreener public API has rate limits (~300 req/min for search/pairs). Be polite.
- No official reverse-index of “all tokens linking to this exact tweet” exists publicly; this uses extraction + handle/social search, which covers the majority of launch announcements.
- Always DYOR — many tokens are scams. This is a discovery tool only.
- On Vercel free tier, function timeouts and cold starts apply. Upgrade if you need higher limits.

## Files

- `app.py` — full backend + embedded frontend (Vercel entrypoint)
- `requirements.txt`
- `vercel.json` — function config
- `.gitignore`
