# Token Intel Engine

A modular, evidence-based system that discovers memecoins linked to social media posts (X, TikTok, Instagram) and returns real contract addresses with supporting evidence.

## Root Cause of Previous Version

The earlier Flask app only performed:
- Regex extraction of CAs and `$TICKER`s from pasted text
- DexScreener search by handle

It never retrieved the actual social content, never analyzed images, never scored evidence strength, and never distinguished real associations from name collisions. That is why it only “recognized social accounts” rather than discovering tokens with proof.

## Architecture

```
lib/
  url-normalizer.ts          # Platform detection + canonical URL
  discovery.ts               # Orchestrator
  evidence.ts                # Scoring & evidence types
  adapters/
    dexscreener.ts           # Real public API
    (future: x.ts, tiktok.ts, birdeye.ts, helius.ts)
app/
  api/discover/route.ts      # Next.js route
  page.tsx                   # Minimal UI
prisma/schema.prisma         # Scan result persistence
```

## Required Setup

### 1. Database (recommended)
```bash
# Vercel Postgres / Neon / Supabase
DATABASE_URL=postgresql://...
npx prisma generate
npx prisma db push
```

### 2. Optional but high-value API keys
| Key | Purpose | Where to get |
|-----|---------|--------------|
| `X_BEARER_TOKEN` | Fetch full tweet + replies | developer.x.com |
| `BIRDEYE_API_KEY` | Extra Solana market + social data | birdeye.so |
| `HELIUS_API_KEY` | On-chain verification / metadata | helius.dev |
| `XAI_API_KEY` | Vision + reasoning over images/text | console.x.ai |

Without these, the engine still works using DexScreener public search + any text you paste.

## Deploy on Vercel

1. Push this folder to GitHub
2. Import on Vercel (Next.js auto-detected)
3. Add environment variables
4. Deploy

`maxDuration` is set to 30s on the API route.

## Testing

```bash
npm install
npm test
```

Tests live in `/tests` and must be run against real public URLs. Do not invent results.

## Current Limitations

- Social content retrieval is limited to text you paste + handle-based DexScreener search until X/TikTok/Instagram adapters are added.
- No image similarity yet (requires vision model or perceptual hash service).
- No background job queue (Vercel Cron or external worker recommended for long scans).
- No trading / wallet signing (intentionally omitted per security requirements).

## Next Implementation Steps

1. Add X API adapter for full tweet + media retrieval
2. Add Birdeye + Helius adapters
3. Implement image embedding / similarity evidence
4. Persist scans to Postgres and add caching layer
5. Expand automated tests with known real token–tweet pairs
