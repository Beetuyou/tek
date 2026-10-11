'use client';

import { useState } from 'react';

export default function Home() {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '40px auto', padding: 20, fontFamily: 'system-ui' }}>
      <h1>Token Intel Engine</h1>
      <p>Paste a social URL (X / TikTok / Instagram) + optional text to discover linked tokens and contract addresses.</p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://x.com/user/status/123..."
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Optional: paste tweet/post text for better CA/ticker extraction"
          rows={4}
          style={{ padding: 10 }}
        />
        <button type="submit" disabled={loading} style={{ padding: '12px 24px', fontSize: 16 }}>
          {loading ? 'Discovering…' : 'Discover Tokens'}
        </button>
      </form>

      {error && <div style={{ color: 'red', marginBottom: 16 }}>{error}</div>}

      {result && (
        <div>
          <h2>Results ({result.candidates?.length || 0})</h2>
          <pre style={{ background: '#f4f4f4', padding: 12, fontSize: 12, overflow: 'auto' }}>
            Platform: {result.normalized?.platform} · Handle: {result.normalized?.handle || '—'}
            {'\n'}Extracted CAs: {result.extracted?.cas?.join(', ') || 'none'}
            {'\n'}Tickers: {result.extracted?.tickers?.join(', ') || 'none'}
          </pre>

          {result.candidates?.map((c: any) => (
            <div key={c.address} style={{ border: '1px solid #ddd', padding: 12, marginBottom: 12, borderRadius: 8 }}>
              <strong>{c.name} ({c.symbol})</strong> — {c.chain}
              <br />
              CA: <code>{c.address}</code>
              <br />
              Confidence: {(c.confidence * 100).toFixed(0)}% · Liq: ${c.liquidityUsd?.toLocaleString() || '—'}
              <br />
              Evidence: {c.evidence?.map((e: any) => e.detail).join(' · ') || '—'}
              <br />
              {c.pairUrl && <a href={c.pairUrl} target="_blank" rel="noreferrer">DexScreener</a>}
            </div>
          ))}

          {result.errors?.length > 0 && (
            <div style={{ color: '#a60', marginTop: 12 }}>
              Warnings: {result.errors.join('; ')}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
