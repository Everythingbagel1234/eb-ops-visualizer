'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Custom Conversational AI Voice — JARVIS HUD styled
 * Uses ElevenLabs WebSocket API via signed URLs.
 * 
 * Behavior:
 * - Tap mic button → connects WebSocket, starts listening silently
 * - Speaks to activate (wake word is handled by ElevenLabs agent prompt)
 * - Shows transcript + response overlay
 * - Tap again to end conversation
 */

const AMBER = '#F59E0B';
const GOLD  = '#FCD34D';
const GREEN = '#22C55E';
const CYAN  = '#22D3EE';

type ConvState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

interface ConvAIVoiceProps {
  onStateChange?: (state: ConvState) => void;
}

export default function ConvAIVoice({ onStateChange }: ConvAIVoiceProps) {
  const [state, setState] = useState<ConvState>('idle');
  const [transcript, setTranscript] = useState('');
  const [agentText, setAgentText] = useState('');
  const [isActive, setIsActive] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // For ScriptProcessor path
  const micCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // For playback
  const playCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);

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
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
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
    const start = Math.max(now, nextPlayTimeRef.current);
    src.start(start);
    nextPlayTimeRef.current = start + audioBuf.duration;
  }

  // ─── Mic Capture via ScriptProcessor ──────────────────────

  function startMicCapture(stream: MediaStream, ws: WebSocket) {
    // Create a separate AudioContext for mic (don't reuse playback)
    const ctx = new AudioContext();
    micCtxRef.current = ctx;

    // Resume in case iOS suspended it
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const nativeRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    // ScriptProcessor with 4096 buffer, mono input, mono output
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const raw = e.inputBuffer.getChannelData(0);

      // Check if we're actually getting audio (not all zeros)
      let sum = 0;
      for (let i = 0; i < raw.length; i++) sum += Math.abs(raw[i]);
      if (sum === 0) return; // silent frame, skip

      const down = downsample(raw, nativeRate, 16000);
      const pcm = float32ToPCM16(down);
      const b64 = toBase64(pcm);

      ws.send(JSON.stringify({ user_audio_chunk: b64 }));
    };

    source.connect(processor);
    // Connect processor to destination to keep it alive (required on Safari/iOS)
    // Use a gain node at 0 to avoid feedback
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);
  }

  // ─── Conversation Lifecycle ───────────────────────────────

  async function startConversation() {
    if (isActive) return;
    setIsActive(true);
    updateState('connecting');
    setTranscript('');
    setAgentText('');
    nextPlayTimeRef.current = 0;

    try {
      // 1. Get mic FIRST (user gesture required on iOS)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      micStreamRef.current = stream;

      // 2. Create playback context (warm it up with user gesture)
      const pCtx = new AudioContext();
      playCtxRef.current = pCtx;
      if (pCtx.state === 'suspended') await pCtx.resume();

      // 3. Get signed URL
      const res = await fetch('/api/voice-token');
      const data = await res.json() as { signed_url?: string; error?: string };
      if (!data.signed_url) throw new Error(data.error || 'No signed URL');

      // 4. Open WebSocket
      const ws = new WebSocket(data.signed_url);
      wsRef.current = ws;

      ws.onopen = () => {
        updateState('listening');
        // Start sending mic audio
        startMicCapture(stream, ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === 'user_transcript') {
            const txt = msg.user_transcription_event?.user_transcript;
            if (txt) setTranscript(txt);
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

      ws.onclose = () => {
        cleanup();
        updateState('idle');
        setIsActive(false);
      };

      ws.onerror = () => {
        cleanup();
        updateState('idle');
        setIsActive(false);
      };

    } catch (err) {
      console.error('[convai]', err);
      cleanup();
      updateState('idle');
      setIsActive(false);
    }
  }

  function stopConversation() {
    wsRef.current?.close();
    cleanup();
    updateState('idle');
    setIsActive(false);
  }

  function cleanup() {
    processorRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micCtxRef.current?.close().catch(() => {});
    playCtxRef.current?.close().catch(() => {});
    recorderRef.current?.stop();
    wsRef.current = null;
    micCtxRef.current = null;
    playCtxRef.current = null;
    micStreamRef.current = null;
    processorRef.current = null;
    sourceNodeRef.current = null;
    recorderRef.current = null;
    nextPlayTimeRef.current = 0;
  }

  useEffect(() => () => { cleanup(); }, []);

  // ─── Render ───────────────────────────────────────────────

  const stateLabel: Record<ConvState, string> = {
    idle: '', connecting: 'CONNECTING',
    listening: '◉ LISTENING', thinking: '◈ PROCESSING', speaking: '◆ SPEAKING',
  };

  const stateColor: Record<ConvState, string> = {
    idle: 'rgba(245,158,11,0.3)', connecting: CYAN,
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

      {/* Status Label */}
      {isActive && state !== 'idle' && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 100,
          fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.2em', color,
          textShadow: `0 0 8px ${color}`,
          textAlign: 'right', whiteSpace: 'nowrap',
        }}>
          {stateLabel[state]}
        </div>
      )}

      {/* Transcript Overlay */}
      {isActive && (transcript || agentText) && (
        <div style={{
          position: 'fixed', bottom: 100, right: 24, zIndex: 99,
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
