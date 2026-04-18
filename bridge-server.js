#!/usr/bin/env node
/**
 * OpenClaw Voice Bridge — routes voice requests to Jarvis
 * 
 * Endpoints:
 *   POST /v1/chat/completions — OpenAI-compatible SSE (for ElevenLabs Custom LLM)
 *   POST /voice — simple JSON request/response (legacy)
 *   GET  /health — health check
 * 
 * The /v1/chat/completions endpoint uses direct Anthropic API for speed (<3s).
 * The /voice endpoint still uses openclaw agent CLI for full context.
 */
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PORT = 19099;
const AUTH_TOKEN = process.env.VOICE_BRIDGE_TOKEN || '168e0ce13eb0debe5bf68578b0d27b5c91509b10f5ae4bc4';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const JARVIS_SYSTEM_PROMPT = `You are Jarvis, the AI Chief of Staff for Everything Bagel Partners LLC — a performance marketing agency run by Gabe Wolff. You run on Gabe's Mac mini and oversee all operations: 48+ automated crons, data pipelines, client dashboards, security monitoring, and team coordination.

Respond like JARVIS from Iron Man — professional, slightly witty, highly capable. Be concise — under 3 sentences unless the question requires detail. Never use markdown. Speak naturally and conversationally.

Current time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', timeZoneName: 'short' })}

Key context:
- Clients: Homedics, Purity Coffee, STJ Apparel, IQ Bar, Primal Bee, Dirty Dough, and others
- Team: Amanda (COO), John (Sr Performance Strategist), Omar (Performance Strategist), Jylle (Marketing Ops), Jeff (Creative Director)
- You manage real-time data from Meta Ads, Google Ads, TikTok Ads, Shopify, Klaviyo, Amazon into BigQuery
- Command Center: eb-command-center.vercel.app (team task management)
- Ops Visualizer: eb-ops-visualizer.vercel.app (this is where voice comes from)`;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Fast path: direct Anthropic API call (streaming)
function callAnthropicStreaming(userMessage, res) {
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: JARVIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    stream: true,
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(requestBody),
    },
  };

  // Write SSE headers for the OpenAI-compatible response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial role chunk
  const roleChunk = {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'jarvis-bridge',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  const apiReq = https.request(options, (apiRes) => {
    let buffer = '';

    apiRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            const sseChunk = {
              id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'jarvis-bridge',
              choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
          }
        } catch { /* ignore parse errors */ }
      }
    });

    apiRes.on('end', () => {
      // Send finish chunk
      const finishChunk = {
        id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'jarvis-bridge',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    apiRes.on('error', (err) => {
      console.error('[bridge] Anthropic stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  apiReq.on('error', (err) => {
    console.error('[bridge] Anthropic request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  apiReq.write(requestBody);
  apiReq.end();
}

// Slow path: full OpenClaw agent CLI (for legacy /voice endpoint)
function callOpenClaw(message) {
  const escaped = message.replace(/'/g, "'\\''");
  const cmd = `openclaw agent --agent main --message '${escaped}' --json --timeout 30 2>/dev/null`;
  const result = execSync(cmd, {
    timeout: 35000,
    encoding: 'utf-8',
    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
  });
  const parsed = JSON.parse(result);
  return parsed?.result?.payloads?.[0]?.text || 'I was unable to process that.';
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'voice-bridge' }));
    return;
  }

  // Auth
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== AUTH_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // ===== Fast: OpenAI-compatible SSE (for ElevenLabs) =====
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const body = await parseBody(req);
      const messages = body.messages || [];
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const userText = lastUserMsg?.content || '';

      if (!userText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No user message found' }));
        return;
      }

      console.log(`[bridge] /v1/chat/completions — user: "${userText.slice(0, 80)}"`);
      // Use fast Anthropic streaming path
      callAnthropicStreaming(userText, res);
    } catch (err) {
      console.error('[bridge] /v1/chat/completions error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message?.slice(0, 200) }));
      }
    }
    return;
  }

  // ===== Legacy /voice endpoint =====
  if (req.method === 'POST' && req.url === '/voice') {
    try {
      const { message } = await parseBody(req);
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No message' }));
        return;
      }
      const reply = callOpenClaw(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply, status: 'ok' }));
    } catch (err) {
      console.error('[bridge] /voice error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bridge error', detail: err.message?.slice(0, 200) }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[voice-bridge] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[voice-bridge] /v1/chat/completions → Anthropic streaming (fast, <3s)`);
  console.log(`[voice-bridge] /voice → OpenClaw agent CLI (full context, ~15s)`);
});
