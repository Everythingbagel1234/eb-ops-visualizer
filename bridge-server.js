#!/usr/bin/env node
/**
 * OpenClaw Voice Bridge — HTTP API → OpenClaw CLI
 * Runs on Mac mini, exposed via Cloudflare tunnel
 * Accepts POST /voice with { message: "..." } 
 * Routes through openclaw agent CLI and returns response
 */
const http = require('http');
const { execSync } = require('child_process');

const PORT = 19099;
const AUTH_TOKEN = process.env.VOICE_BRIDGE_TOKEN || '168e0ce13eb0debe5bf68578b0d27b5c91509b10f5ae4bc4';

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'voice-bridge' }));
    return;
  }
  
  // Auth check
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  
  // Voice endpoint
  if (req.method === 'POST' && req.url === '/voice') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { message } = JSON.parse(body);
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No message' }));
          return;
        }
        
        // Route through OpenClaw agent CLI
        const escaped = message.replace(/'/g, "'\\''");
        const cmd = `openclaw agent --agent main --message '${escaped}' --json --timeout 30 2>/dev/null`;
        
        const result = execSync(cmd, { 
          timeout: 35000, 
          encoding: 'utf-8',
          env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
        });
        
        const parsed = JSON.parse(result);
        const reply = parsed?.result?.payloads?.[0]?.text || 'I was unable to process that.';
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, status: 'ok' }));
      } catch (err) {
        console.error('[bridge] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bridge error', detail: err.message?.slice(0, 200) }));
      }
    });
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[voice-bridge] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[voice-bridge] Auth token: ${AUTH_TOKEN.slice(0, 8)}...`);
});
