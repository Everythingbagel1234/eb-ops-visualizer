import { NextResponse } from 'next/server';

/* ─── Config ─────────────────────────────────────────────────── */

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';

if (!SLACK_TOKEN) {
  console.warn('[slack/route] SLACK_BOT_TOKEN not set — Slack feed will be empty');
}

// Jarvis bot/app IDs to filter out self-messages (unless substantive)
const JARVIS_BOT_IDS = new Set(['B0AK17QKEUS', 'A0AK17QKEUS']);
// Jarvis user ID when it posts as a user
const JARVIS_USER_ID = 'U0AK17QKEUS';

// Gabe's user ID — gets warm gold color
const GABE_USER_ID = 'U037PNKPY5V';

const CHANNELS: Array<{ id: string; label: string }> = [
  { id: 'D0AK17QKEUS', label: 'DM' },
  { id: 'C0AUK7H8E1E', label: '#activity' },
  { id: 'C0ARHEXFQVA', label: '#feedback' },
  { id: 'C057SHS1KCP', label: '#internal' },
];

/* ─── Types ─────────────────────────────────────────────────────*/

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

/* ─── Module-level user cache ────────────────────────────────── */

const userCache = new Map<string, string>();

async function resolveUser(userId: string): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  try {
    const res = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
        // 5 second timeout
        signal: AbortSignal.timeout(5000),
      }
    );
    const data = await res.json() as {
      ok: boolean;
      user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } };
    };

    if (data.ok && data.user) {
      const name =
        data.user.profile?.display_name?.trim() ||
        data.user.profile?.real_name?.trim() ||
        data.user.real_name?.trim() ||
        userId;
      userCache.set(userId, name);
      return name;
    }
  } catch { /* ignore */ }

  userCache.set(userId, userId);
  return userId;
}

/* ─── Fetch one channel ──────────────────────────────────────── */

async function fetchChannel(
  channelId: string,
  label: string,
  oldestTs: number
): Promise<SlackMessage[]> {
  try {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('oldest', String(oldestTs));
    url.searchParams.set('limit', '10');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });

    const data = await res.json() as {
      ok: boolean;
      messages?: Array<{
        ts?: string;
        text?: string;
        user?: string;
        bot_id?: string;
        app_id?: string;
        subtype?: string;
      }>;
    };

    if (!data.ok || !Array.isArray(data.messages)) return [];

    const results: SlackMessage[] = [];

    for (const msg of data.messages) {
      const text = (msg.text || '').trim();

      // Skip empty messages
      if (!text) continue;

      // Skip heartbeat-only messages
      if (text === 'HEARTBEAT_OK') continue;

      const ts = parseFloat(msg.ts || '0');
      const botId = msg.bot_id || msg.app_id || '';
      const isJarvisBot = JARVIS_BOT_IDS.has(botId) || msg.user === JARVIS_USER_ID;

      // Filter Jarvis bot messages that aren't substantive
      if (isJarvisBot && text.length <= 20) continue;

      // Skip message subtypes (joins, leaves, etc.)
      if (msg.subtype && msg.subtype !== 'bot_message') continue;

      const isBot   = !!botId || msg.subtype === 'bot_message';
      const userId  = msg.user || '';
      const isGabe  = userId === GABE_USER_ID;

      // Resolve display name
      let person: string;
      if (isJarvisBot) {
        person = 'Jarvis';
      } else if (isGabe) {
        person = 'Gabe';
      } else if (userId) {
        person = await resolveUser(userId);
      } else {
        person = 'Bot';
      }

      const d = new Date(ts * 1000);
      const time = d.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      results.push({
        time,
        timestamp: ts,
        person,
        userId: userId || undefined,
        channel: label,
        text,
        isBot,
        isGabe,
      });
    }

    return results;
  } catch {
    return [];
  }
}

/* ─── Route ─────────────────────────────────────────────────── */

export async function GET() {
  const twoHoursAgo = (Date.now() / 1000) - 7200;

  // Fetch all channels in parallel
  const allMessages = (
    await Promise.all(
      CHANNELS.map(ch => fetchChannel(ch.id, ch.label, twoHoursAgo))
    )
  ).flat();

  // Sort by timestamp descending (newest first)
  allMessages.sort((a, b) => b.timestamp - a.timestamp);

  // Cap at 15 messages
  const messages = allMessages.slice(0, 15);

  return NextResponse.json({ messages }, {
    headers: {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
