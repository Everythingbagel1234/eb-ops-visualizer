import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const AGENT_ID = 'agent_1701kph7km8mew78ehcqezs9nv43';

export async function GET() {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
      {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error('[voice-token] ElevenLabs error:', err);
      return NextResponse.json({ error: 'Failed to get token' }, { status: 500 });
    }

    const data = await res.json() as { signed_url: string };
    return NextResponse.json({ signed_url: data.signed_url });
  } catch (err) {
    console.error('[voice-token] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
