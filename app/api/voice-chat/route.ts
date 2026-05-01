import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

export async function POST(request: Request) {
  try {
    const { text } = await request.json() as { text: string };

    if (!text?.trim()) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: 'You are Jarvis, the AI operations agent for Everything Bagel Partners LLC. You are responding via voice, so keep answers concise (2-3 sentences max). Be direct and helpful.',
        messages: [{ role: 'user', content: text }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[voice-chat] Anthropic error:', err);
      return NextResponse.json({ error: 'API error' }, { status: 500 });
    }

    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const response = data.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || 'Sorry, I could not process that.';

    return NextResponse.json({ response: response.replace(/[*_`#]/g, '').trim() });
  } catch (err) {
    console.error('[voice-chat]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
