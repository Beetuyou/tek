import { NextRequest, NextResponse } from 'next/server';
import { discoverTokens } from '@/lib/discovery';
import { rateLimit } from '@/lib/cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  if (!rateLimit(ip, 15, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    const body = await req.json();
    const url = (body.url || '').trim();
    const text = (body.text || '').trim();

    if (!url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    const result = await discoverTokens(url, text || undefined);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('Discovery error', e);
    return NextResponse.json(
      { error: 'Internal discovery failure', detail: e.message },
      { status: 500 }
    );
  }
}