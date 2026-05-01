import { NextResponse } from 'next/server';

const CC_URL = process.env.CC_API_URL || process.env.NEXT_PUBLIC_CC_API_URL || 'https://eb-command-center.vercel.app';

/* ─── Types ──────────────────────────────────────────────────── */
export interface SlackMessage {
  time: string;        // "10:32 AM"
  timestamp: number;   // unix seconds
  person: string;
  userId?: string;
  channel: string;     // "DM" / "#activity" etc.
  text: string;
  isBot: boolean;
  isGabe: boolean;
}

/* ─── Helpers ────────────────────────────────────────────────── */
function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

const GABE_IDS = new Set(['U037PNKPY5V']);

/* ─── Route ─────────────────────────────────────────────────── */
export async function GET() {
  try {
    const res = await fetch(`${CC_URL}/api/ops-interactions`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) throw new Error(`CC returned ${res.status}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSlack: any[] = Array.isArray(data.slack) ? data.slack : [];

    const messages: SlackMessage[] = rawSlack
      .filter(m => m && (m.text || m.message))
      .map(m => {
        const ts: number = typeof m.timestamp === 'number'
          ? m.timestamp
          : parseFloat(String(m.ts ?? m.timestamp ?? '0'));
        const userId = String(m.userId ?? m.user ?? '');
        const isGabe  = GABE_IDS.has(userId) || String(m.person ?? '').toLowerCase() === 'gabe';
        const isBot   = !!(m.isBot ?? m.bot_id ?? m.app_id ?? false);

        return {
          time:      m.time ?? (ts > 0 ? formatTime(ts) : '—'),
          timestamp: ts,
          person:    String(m.person ?? m.user ?? (isBot ? 'Bot' : 'Unknown')),
          userId:    userId || undefined,
          channel:   String(m.channel ?? 'Slack'),
          text:      String(m.text ?? m.message ?? '').trim(),
          isBot,
          isGabe,
        };
      })
      .filter(m => m.text.length > 0 && m.text !== 'HEARTBEAT_OK')
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 15);

    return NextResponse.json({ messages }, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return NextResponse.json({ messages: [] }, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
