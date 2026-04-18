import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface VoiceRequest {
  text: string;
  context?: {
    cronHealth?: { ok: number; error: number; total: number };
    errors?: string[];
    alerts?: string[];
  };
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Daniel — Steady British Broadcaster. Closest to MCU J.A.R.V.I.S. (Paul Bettany) tone.
const ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9';

export async function POST(request: Request) {
  try {
    const body = await request.json() as VoiceRequest;
    const { text, context } = body;

    if (!text?.trim()) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    // Build context string for Anthropic
    let contextStr = '';
    if (context) {
      if (context.cronHealth) {
        contextStr += `Current cron health: ${context.cronHealth.ok} OK, ${context.cronHealth.error} errors out of ${context.cronHealth.total} total. `;
      }
      if (context.errors?.length) {
        contextStr += `Active errors: ${context.errors.join(', ')}. `;
      }
      if (context.alerts?.length) {
        contextStr += `Active alerts: ${context.alerts.join(', ')}. `;
      }
    }

    // Route through OpenClaw Voice Bridge for full Jarvis context (memory, tools, sessions)
    // Bridge runs on Mac mini, exposed via Cloudflare tunnel with token auth
    // Falls back to direct Anthropic if bridge is unavailable
    let responseText = '';
    const BRIDGE_URL = process.env.VOICE_BRIDGE_URL || '';
    const BRIDGE_TOKEN = process.env.VOICE_BRIDGE_TOKEN || '';
    
    if (BRIDGE_URL && BRIDGE_TOKEN) {
      try {
        const gwRes = await fetch(`${BRIDGE_URL}/voice`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${BRIDGE_TOKEN}`,
          },
          body: JSON.stringify({
            message: `[Voice from Gabe — respond conversationally, no markdown, under 3 sentences unless detail needed] ${text}`,
          }),
          signal: AbortSignal.timeout(35000),
        });
        
        if (gwRes.ok) {
          const gwData = await gwRes.json() as { reply?: string; status?: string };
          responseText = gwData.reply || '';
        }
      } catch {
        console.log('[voice] Voice bridge unavailable, falling back to direct Anthropic');
      }
    }
    
    // Fallback: direct Anthropic call if gateway didn't respond
    if (!responseText) {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 200,
          system: `You are Jarvis, the AI operations assistant for Gabe Wolff at Everything Bagel Partners LLC. You run on his Mac mini and oversee 48+ automated crons, agents, and data pipelines. Respond concisely and conversationally, exactly like JARVIS from Iron Man — professional, slightly witty, highly capable. Keep responses under 3 sentences unless the question requires detail. Never use markdown in your response, speak naturally.${contextStr ? ` Ops context: ${contextStr}` : ''}`,
          messages: [{ role: 'user', content: text }],
        }),
      });

      if (!anthropicRes.ok) {
        const err = await anthropicRes.text();
        console.error('[voice] Anthropic error:', err);
        return NextResponse.json({ error: 'API error' }, { status: 500 });
      }

      const anthropicData = await anthropicRes.json() as {
        content: Array<{ type: string; text: string }>;
      };
      responseText = anthropicData.content?.[0]?.text || 'I apologize, I was unable to process that request.';
    }
    
    // Strip any markdown that might have come through
    responseText = responseText.replace(/[*_`#\[\]]/g, '').replace(/\n+/g, ' ').trim();

    // Call ElevenLabs TTS
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: responseText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.82,
            similarity_boost: 0.90,
            style: 0.15,
          },
        }),
      }
    );

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('[voice] ElevenLabs error:', err);
      // Return text response without audio
      return NextResponse.json({ response: responseText, audio: null });
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    return NextResponse.json({
      response: responseText,
      audio: audioBase64,
    });
  } catch (err) {
    console.error('[voice] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
