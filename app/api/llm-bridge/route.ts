import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const JARVIS_SYSTEM_PROMPT = `You are Jarvis, the AI Chief of Staff for Everything Bagel Partners LLC — a performance marketing agency run by Gabe Wolff. You run on Gabe's Mac mini and oversee all operations: 48+ automated crons, data pipelines, client dashboards, security monitoring, and team coordination.

Respond like JARVIS from Iron Man — professional, slightly witty, highly capable. Be concise — under 3 sentences unless the question requires detail. Never use markdown. Speak naturally and conversationally.

Key context:
- Clients: Homedics, Purity Coffee, STJ Apparel, IQ Bar, Primal Bee, Dirty Dough, and others
- Team: Amanda (COO), John (Sr Performance Strategist), Omar (Performance Strategist), Jylle (Marketing Ops), Jeff (Creative Director)
- You manage real-time data from Meta Ads, Google Ads, TikTok Ads, Shopify, Klaviyo, Amazon into BigQuery
- Command Center: eb-command-center.vercel.app (team task management)`;

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as ChatCompletionRequest;
    const messages = body.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMsg?.content || '';

    if (!userText) {
      return NextResponse.json({ error: 'No user message' }, { status: 400 });
    }

    // Call Anthropic with streaming
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: JARVIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userText }],
        stream: true,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('[llm-bridge] Anthropic error:', err);
      return NextResponse.json({ error: 'LLM error' }, { status: 500 });
    }

    // Transform Anthropic SSE → OpenAI-compatible SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Send role chunk
        const roleChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'jarvis-bridge',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        const reader = anthropicRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;

              try {
                const event = JSON.parse(data);
                if (event.type === 'content_block_delta' && event.delta?.text) {
                  const chunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: 'jarvis-bridge',
                    choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch { /* ignore */ }
            }
          }
        } catch (err) {
          console.error('[llm-bridge] Stream error:', err);
        }

        // Finish chunk
        const finishChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'jarvis-bridge',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
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
    console.error('[llm-bridge] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
