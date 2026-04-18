'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Custom Conversational AI Voice — JARVIS HUD styled
 * Uses ElevenLabs WebSocket API via signed URLs.
 * Mic capture via ScriptProcessorNode with iOS workarounds.
 */

const AMBER = '#F59E0B';
const GOLD  = '#FCD34D';
const GREEN = '#22C55E';
const CYAN  = '#22D3EE';

type ConvState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

interface ConvAIVoiceProps {
  onStateChange?: (state: ConvState) => void;
}

export default function ConvAIVoice({ onStateChange }: ConvAIVoiceProps) {
  const [state, setState] = useState<ConvState>('idle');
  const [transcript, setTranscript] = useState('');
  const [agentText, setAgentText] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [debugMsg, setDebugMsg] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const chunksSentRef = useRef(0);

  const updateState = useCallback((s: ConvState) => {
    setState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // ─── Audio Helpers ────────────────────────────────────────

  function downsample(buf: Float32Array, from: number, to: number): Float32Array {
    if (from === to) return buf;
    const ratio = from / to;
    const len = Math.round(buf.length / ratio);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = buf[Math.min(Math.round(i * ratio), buf.length - 1)];
    }
    return out;
  }

  function float32ToPCM16(samples: Float32Array): ArrayBuffer {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm.buffer;
  }

  function toBase64(buf: ArrayBuffer): string {
    const u8 = new Uint8Array(buf);
    let s = '';
    // Process in chunks to avoid call stack overflow on large buffers
    const CHUNK = 8192;
    for (let i = 0; i < u8.length; i += CHUNK) {
      const slice = u8.subarray(i, Math.min(i + CHUNK, u8.length));
      for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j]);
    }
    return btoa(s);
  }

  function playAudioBase64(base64: string) {
    let ctx = playCtxRef.current;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext();
      playCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') ctx.resume();

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const audioBuf = ctx.createBuffer(1, float32.length, 16000);
    audioBuf.getChannelData(0).set(float32);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const start = Math.max(now + 0.01, nextPlayTimeRef.current);
    src.start(start);
    nextPlayTimeRef.current = start + audioBuf.duration;
  }

  // ─── Start Conversation ───────────────────────────────────

  async function startConversation() {
    if (isActive) return;
    setIsActive(true);
    updateState('connecting');
    setTranscript('');
    setAgentText('');
    setDebugMsg('Getting mic...');
    nextPlayTimeRef.current = 0;
    chunksSentRef.current = 0;

    try {
      // 1. Get mic FIRST (user gesture on iOS)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      micStreamRef.current = stream;
      setDebugMsg('Mic granted. Getting token...');

      // 2. Warm up playback context with user gesture
      const pCtx = new AudioContext();
      playCtxRef.current = pCtx;
      if (pCtx.state === 'suspended') await pCtx.resume();

      // 3. Get signed URL
      const res = await fetch('/api/voice-token');
      const data = await res.json() as { signed_url?: string; error?: string };
      if (!data.signed_url) throw new Error(data.error || 'No signed URL');
      setDebugMsg('Connecting WebSocket...');

      // 4. Open WebSocket
      const ws = new WebSocket(data.signed_url);
      wsRef.current = ws;

      ws.onopen = () => {
        setDebugMsg('Connected! Setting up mic...');
        
        // Create mic AudioContext
        const micCtx = new AudioContext();
        micCtxRef.current = micCtx;
        
        // Resume (iOS requirement)
        const resumeAndSetup = () => {
          const nativeRate = micCtx.sampleRate;
          setDebugMsg(`Mic rate: ${nativeRate}Hz`);

          const source = micCtx.createMediaStreamSource(stream);
          sourceNodeRef.current = source;

          const processor = micCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const raw = e.inputBuffer.getChannelData(0);
            const down = downsample(raw, nativeRate, 16000);
            const pcm = float32ToPCM16(down);
            const b64 = toBase64(pcm);
            ws.send(JSON.stringify({ user_audio_chunk: b64 }));
            chunksSentRef.current++;
            if (chunksSentRef.current <= 3 || chunksSentRef.current % 20 === 0) {
              setDebugMsg(`Sending audio... (${chunksSentRef.current} chunks)`);
            }
          };

          source.connect(processor);
          // Silent output to keep processor alive (iOS/Safari requirement)
          const silentGain = micCtx.createGain();
          silentGain.gain.value = 0;
          processor.connect(silentGain);
          silentGain.connect(micCtx.destination);

          updateState('listening');
          setDebugMsg('');
        };

        if (micCtx.state === 'suspended') {
          micCtx.resume().then(resumeAndSetup);
        } else {
          resumeAndSetup();
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === 'user_transcript') {
            const txt = msg.user_transcription_event?.user_transcript;
            if (txt) {
              setTranscript(txt);
              setDebugMsg('');
            }
          }

          if (msg.type === 'agent_response') {
            const txt = msg.agent_response_event?.agent_response;
            if (txt) {
              setAgentText(prev => prev + txt);
              updateState('thinking');
            }
          }

          if (msg.type === 'audio') {
            const b64 = msg.audio_event?.audio_base_64;
            if (b64) {
              updateState('speaking');
              playAudioBase64(b64);
            }
          }

          if (msg.type === 'interruption') {
            nextPlayTimeRef.current = 0;
            setAgentText('');
            updateState('listening');
          }

          if (msg.type === 'agent_response_correction') {
            const txt = msg.agent_response_correction_event?.corrected_agent_response;
            if (txt) setAgentText(txt);
          }

          if (msg.type === 'ping' && msg.ping_event) {
            const delay = msg.ping_event.ping_ms || 0;
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
              }
            }, delay);
          }
        } catch { /* ignore */ }
      };

      ws.onclose = (e) => {
        const reason = e.reason || `code ${e.code}`;
        console.log('[convai] WS closed:', reason);
        if (e.code === 3000) {
          setDebugMsg(`Error: ${reason}`);
          updateState('error');
        } else {
          cleanup();
          updateState('idle');
          setIsActive(false);
        }
      };

      ws.onerror = () => {
        setDebugMsg('WebSocket error');
        cleanup();
        updateState('error');
        setTimeout(() => {
          updateState('idle');
          setIsActive(false);
          setDebugMsg('');
        }, 3000);
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[convai]', msg);
      setDebugMsg(`Error: ${msg}`);
      cleanup();
      updateState('error');
      setTimeout(() => {
        updateState('idle');
        setIsActive(false);
        setDebugMsg('');
      }, 3000);
    }
  }

  function stopConversation() {
    wsRef.current?.close();
    cleanup();
    updateState('idle');
    setIsActive(false);
    setDebugMsg('');
  }

  function cleanup() {
    processorRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micCtxRef.current?.close().catch(() => {});
    playCtxRef.current?.close().catch(() => {});
    wsRef.current = null;
    micCtxRef.current = null;
    playCtxRef.current = null;
    micStreamRef.current = null;
    processorRef.current = null;
    sourceNodeRef.current = null;
    nextPlayTimeRef.current = 0;
    chunksSentRef.current = 0;
  }

  useEffect(() => () => { cleanup(); }, []);

  // ─── Render ───────────────────────────────────────────────

  const stateLabel: Record<ConvState, string> = {
    idle: '', connecting: 'CONNECTING', error: '⚠ ERROR',
    listening: '◉ LISTENING', thinking: '◈ PROCESSING', speaking: '◆ SPEAKING',
  };

  const stateColor: Record<ConvState, string> = {
    idle: 'rgba(245,158,11,0.3)', connecting: CYAN, error: '#EF4444',
    listening: AMBER, thinking: CYAN, speaking: GREEN,
  };

  const color = stateColor[state];

  return (
    <>
      {/* Mic Button */}
      <button
        onClick={isActive ? stopConversation : startConversation}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 100,
          width: 56, height: 56, borderRadius: '50%',
          border: `2px solid ${isActive ? color : 'rgba(245,158,11,0.4)'}`,
          background: isActive
            ? `radial-gradient(circle, ${color}22, rgba(5,5,16,0.9))`
            : 'rgba(5,5,16,0.85)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: isActive
            ? `0 0 20px ${color}44, 0 0 40px ${color}22`
            : '0 0 10px rgba(245,158,11,0.15)',
          transition: 'all 0.3s ease',
          animation: state === 'listening' ? 'cv-pulse 1.5s ease-in-out infinite' : 'none',
        }}
        title={isActive ? 'End conversation' : 'Talk to Jarvis'}
      >
        {isActive ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="2">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}

        {isActive && state !== 'idle' && (
          <>
            <div style={{
              position: 'absolute', inset: -4, borderRadius: '50%',
              border: `1px solid ${color}`, opacity: 0.4,
              animation: 'cv-ring 2s ease-out infinite',
            }} />
            <div style={{
              position: 'absolute', inset: -8, borderRadius: '50%',
              border: `1px solid ${color}`, opacity: 0.2,
              animation: 'cv-ring 2s ease-out 0.5s infinite',
            }} />
          </>
        )}
      </button>

      {/* Status + Debug */}
      {isActive && (state !== 'idle' || debugMsg) && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 100,
          textAlign: 'right', maxWidth: 240,
        }}>
          {stateLabel[state] && (
            <div style={{
              fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.2em', color,
              textShadow: `0 0 8px ${color}`,
              whiteSpace: 'nowrap',
            }}>
              {stateLabel[state]}
            </div>
          )}
          {debugMsg && (
            <div style={{
              fontSize: 8, fontFamily: "'JetBrains Mono', monospace",
              color: 'rgba(245,158,11,0.4)', marginTop: 2,
            }}>
              {debugMsg}
            </div>
          )}
        </div>
      )}

      {/* Transcript Overlay */}
      {isActive && (transcript || agentText) && (
        <div style={{
          position: 'fixed', bottom: 108, right: 24, zIndex: 99,
          maxWidth: 360, display: 'flex', flexDirection: 'column',
          gap: 8, animation: 'cv-up 0.3s ease-out',
        }}>
          {transcript && (
            <div style={{
              padding: '8px 14px', borderRadius: 8,
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
              backdropFilter: 'blur(8px)',
            }}>
              <div style={{
                fontSize: 8, color: 'rgba(245,158,11,0.5)',
                letterSpacing: '0.2em', marginBottom: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>YOU</div>
              <div style={{
                fontSize: 12, color: GOLD, lineHeight: 1.5,
                fontFamily: "'JetBrains Mono', monospace",
              }}>{transcript}</div>
            </div>
          )}

          {agentText && (
            <div style={{
              padding: '8px 14px', borderRadius: 8,
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.2)',
              backdropFilter: 'blur(8px)',
            }}>
              <div style={{
                fontSize: 8, color: 'rgba(34,197,94,0.5)',
                letterSpacing: '0.2em', marginBottom: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>JARVIS</div>
              <div style={{
                fontSize: 12, color: GREEN, lineHeight: 1.5,
                fontFamily: "'JetBrains Mono', monospace",
                maxHeight: 200, overflowY: 'auto',
              }}>{agentText}</div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes cv-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes cv-ring { 0% { transform: scale(1); opacity: 0.4; } 100% { transform: scale(1.8); opacity: 0; } }
        @keyframes cv-up { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
    </>
  );
}
