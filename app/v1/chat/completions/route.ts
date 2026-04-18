import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const JARVIS_SYSTEM_PROMPT = `You are Jarvis, the AI Chief of Staff for Everything Bagel Partners LLC — a performance marketing agency run by Gabe Wolff. Respond like JARVIS from Iron Man — professional, slightly witty, highly capable. Be concise — under 3 sentences. Never use markdown. Speak naturally.`;

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionRequest {
  messages?: ChatMessage[];
  model?: string;
  stream?: boolean;
}

export async function POST(request: Request) {
  // Log that we received a request (visible in Vercel logs)
  console.log('[v1/chat/completions] Request received');

  try {
    const body = await request.json() as ChatCompletionRequest;
    const messages = body.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMsg?.content || '';

    console.log('[v1/chat/completions] User text:', userText?.slice(0, 100));

    if (!userText) {
      return NextResponse.json({ error: 'No user message' }, { status: 400 });
    }

    // Call Anthropic API (non-streaming for simplicity, then format as SSE)
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
        system: JARVIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('[v1/chat/completions] Anthropic error:', err?.slice(0, 200));
      return NextResponse.json({ error: 'LLM error' }, { status: 500 });
    }

    const anthropicData = await anthropicRes.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const replyText = anthropicData.content?.[0]?.text || 'I apologize, I could not process that.';

    console.log('[v1/chat/completions] Reply:', replyText?.slice(0, 100));

    // Return as OpenAI-compatible SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const ts = Math.floor(Date.now() / 1000);

        // Role chunk
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: `chatcmpl-${ts}`,
          object: 'chat.completion.chunk',
          created: ts,
          model: 'jarvis-bridge',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        })}\n\n`));

        // Content chunk (send full response at once for speed)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: `chatcmpl-${ts}-1`,
          object: 'chat.completion.chunk',
          created: ts,
          model: 'jarvis-bridge',
          choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
        })}\n\n`));

        // Finish chunk
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: `chatcmpl-${ts}-2`,
          object: 'chat.completion.chunk',
          created: ts,
          model: 'jarvis-bridge',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`));

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    console.error('[v1/chat/completions] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
