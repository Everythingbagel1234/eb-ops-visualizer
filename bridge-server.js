#!/usr/bin/env node
/**
 * OpenClaw Voice Bridge — HTTP API → OpenClaw CLI
 * Runs on Mac mini, exposed via Cloudflare tunnel
 * 
 * Endpoints:
 *   POST /voice — simple JSON request/response (legacy)
 *   POST /v1/chat/completions — OpenAI-compatible SSE (for ElevenLabs Custom LLM)
 *   GET /health — health check
 */
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PORT = 19099;
const AUTH_TOKEN = process.env.VOICE_BRIDGE_TOKEN || '168e0ce13eb0debe5bf68578b0d27b5c91509b10f5ae4bc4';

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

function callOpenClaw(message) {
  const escaped = message.replace(/'/g, "'\\''");
  const cmd = `openclaw agent --agent main --message '${escaped}' --json --timeout 30 2>/dev/null`;
  const result = execSync(cmd, {
    timeout: 35000,
    encoding: 'utf-8',
    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
  });
  const parsed = JSON.parse(result);
  return parsed?.result?.payloads?.[0]?.text || 'I was unable to process that.';
}

function makeSSEChunk(content, finishReason = null) {
  const chunk = {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'jarvis-bridge',
    choices: [{
      index: 0,
      delta: finishReason ? {} : { content },
      finish_reason: finishReason
    }]
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'voice-bridge' }));
    return;
  }

  // Auth check — support Bearer token and OpenAI-style API key
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== AUTH_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // ===== OpenAI-compatible /v1/chat/completions (for ElevenLabs Custom LLM) =====
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const body = await parseBody(req);
      const messages = body.messages || [];
      
      // Extract the last user message — that's what ElevenLabs sends as the user's speech
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const userText = lastUserMsg?.content || '';
      
      if (!userText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No user message found' }));
        return;
      }

      console.log(`[bridge] /v1/chat/completions — user: "${userText.slice(0, 80)}..."`);
      
      // Get real Jarvis response
      const reply = callOpenClaw(userText);
      console.log(`[bridge] Jarvis replied: "${reply.slice(0, 80)}..."`);

      // Stream response as SSE chunks (word-by-word for natural TTS pacing)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send role chunk first
      const roleChunk = {
        id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'jarvis-bridge',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      // Split reply into sentence chunks for natural streaming
      // (word-by-word is too slow, full-text is fine but sentence chunks feel more natural)
      const sentences = reply.match(/[^.!?]+[.!?]+\s*/g) || [reply];
      for (const sentence of sentences) {
        res.write(makeSSEChunk(sentence));
      }

      // Send finish chunk
      res.write(makeSSEChunk('', 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (err) {
      console.error('[bridge] /v1/chat/completions error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bridge error', detail: err.message?.slice(0, 200) }));
      } else {
        res.write(`data: ${JSON.stringify({ error: err.message?.slice(0, 200) })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
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
  console.log(`[voice-bridge] Endpoints:`);
  console.log(`  POST /v1/chat/completions — OpenAI-compatible SSE (ElevenLabs Custom LLM)`);
  console.log(`  POST /voice — Legacy JSON endpoint`);
  console.log(`  GET  /health — Health check`);
});
