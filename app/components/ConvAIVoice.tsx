'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Custom Conversational AI Voice Interface
 * Uses ElevenLabs WebSocket API via signed URLs — no widget, fully custom UI.
 * Matches the JARVIS HUD aesthetic.
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
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);

  const updateState = useCallback((s: ConvState) => {
    setState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // Downsample from native sample rate to 16000Hz
  function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const index = Math.round(i * ratio);
      result[i] = buffer[Math.min(index, buffer.length - 1)];
    }
    return result;
  }

  // Convert Float32 samples to 16-bit PCM ArrayBuffer
  function float32ToPCM16(samples: Float32Array): ArrayBuffer {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm.buffer;
  }

  // ArrayBuffer to base64
  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Base64 PCM16 to AudioBuffer for playback
  function base64ToAudioBuffer(base64: string, ctx: AudioContext): AudioBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buffer = ctx.createBuffer(1, float32.length, 16000);
    buffer.getChannelData(0).set(float32);
    return buffer;
  }

  function playAudioBase64(base64: string) {
    const ctx = playbackCtxRef.current;
    if (!ctx) return;

    const audioBuffer = base64ToAudioBuffer(base64, ctx);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  }

  async function startConversation() {
    if (isActive) return;
    setIsActive(true);
    updateState('connecting');
    setTranscript('');
    setAgentText('');
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;

    try {
      // 1. Get signed URL from our API
      const tokenRes = await fetch('/api/voice-token');
      const tokenData = await tokenRes.json() as { signed_url?: string; error?: string };
      if (!tokenData.signed_url) {
        throw new Error(tokenData.error || 'No signed URL');
      }

      // 2. Get microphone FIRST (requires user gesture on mobile)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      micStreamRef.current = stream;

      // 3. Create playback AudioContext (can be any sample rate)
      const playCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      playbackCtxRef.current = playCtx;

      // 4. Create mic AudioContext (native rate, we'll downsample)
      const micCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      micCtxRef.current = micCtx;
      const nativeSampleRate = micCtx.sampleRate;

      // 5. Connect WebSocket
      const ws = new WebSocket(tokenData.signed_url);
      wsRef.current = ws;

      ws.onopen = () => {
        updateState('listening');

        // Set up mic capture using ScriptProcessorNode (broad compatibility)
        const source = micCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        // 4096 buffer size — balanced latency/performance
        const processor = micCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e: AudioProcessingEvent) => {
          if (ws.readyState !== WebSocket.OPEN) return;

          const inputData = e.inputBuffer.getChannelData(0);
          // Downsample to 16kHz
          const downsampled = downsample(inputData, nativeSampleRate, 16000);
          // Convert to 16-bit PCM
          const pcmBuffer = float32ToPCM16(downsampled);
          // Base64 encode
          const b64 = arrayBufferToBase64(pcmBuffer);
          // Send to ElevenLabs
          ws.send(JSON.stringify({
            user_audio_chunk: b64,
          }));
        };

        source.connect(processor);
        processor.connect(micCtx.destination);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);

          switch (msg.type) {
            case 'conversation_initiation_metadata':
              // Agent ready — conversation_id available
              break;

            case 'user_transcript':
              if (msg.user_transcription_event?.user_transcript) {
                setTranscript(msg.user_transcription_event.user_transcript);
              }
              break;

            case 'agent_response':
              if (msg.agent_response_event?.agent_response) {
                setAgentText(prev => prev + msg.agent_response_event.agent_response);
                updateState('thinking');
              }
              break;

            case 'audio':
              if (msg.audio_event?.audio_base_64) {
                updateState('speaking');
                playAudioBase64(msg.audio_event.audio_base_64);
              }
              break;

            case 'interruption':
              // User interrupted — stop audio
              nextPlayTimeRef.current = 0;
              isPlayingRef.current = false;
              setAgentText('');
              updateState('listening');
              break;

            case 'agent_response_correction':
              if (msg.agent_response_correction_event?.corrected_agent_response) {
                setAgentText(msg.agent_response_correction_event.corrected_agent_response);
              }
              break;

            case 'ping':
              if (msg.ping_event) {
                const delay = msg.ping_event.ping_ms || 0;
                setTimeout(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'pong',
                      event_id: msg.ping_event.event_id,
                    }));
                  }
                }, delay);
              }
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        cleanup();
        updateState('idle');
        setIsActive(false);
      };

      ws.onerror = (err) => {
        console.error('[convai] WebSocket error:', err);
        cleanup();
        updateState('idle');
        setIsActive(false);
      };

    } catch (err) {
      console.error('[convai] Start error:', err);
      cleanup();
      updateState('idle');
      setIsActive(false);
    }
  }

  function stopConversation() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    cleanup();
    updateState('idle');
    setIsActive(false);
  }

  function cleanup() {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micCtxRef.current?.close().catch(() => {});
    playbackCtxRef.current?.close().catch(() => {});
    wsRef.current = null;
    micCtxRef.current = null;
    playbackCtxRef.current = null;
    micStreamRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
  }

  useEffect(() => {
    return () => { cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stateLabel: Record<ConvState, string> = {
    idle: '',
    connecting: 'CONNECTING',
    listening: '◉ LISTENING',
    thinking: '◈ PROCESSING',
    speaking: '◆ SPEAKING',
  };

  const stateColor: Record<ConvState, string> = {
    idle: 'rgba(245,158,11,0.3)',
    connecting: 'rgba(34,211,238,0.7)',
    listening: AMBER,
    thinking: CYAN,
    speaking: GREEN,
  };

  return (
    <>
      {/* Voice Mic Button — fixed bottom-right, JARVIS-styled */}
      <button
        onClick={isActive ? stopConversation : startConversation}
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 100,
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: `2px solid ${isActive ? stateColor[state] : 'rgba(245,158,11,0.4)'}`,
          background: isActive
            ? `radial-gradient(circle, ${stateColor[state]}22, rgba(5,5,16,0.9))`
            : 'rgba(5,5,16,0.85)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: isActive
            ? `0 0 20px ${stateColor[state]}44, 0 0 40px ${stateColor[state]}22`
            : `0 0 10px rgba(245,158,11,0.15)`,
          transition: 'all 0.3s ease',
          animation: state === 'listening' ? 'voice-btn-pulse 1.5s ease-in-out infinite' : 'none',
        }}
        title={isActive ? 'End conversation' : 'Talk to Jarvis'}
      >
        {isActive ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stateColor[state]} strokeWidth="2">
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
              border: `1px solid ${stateColor[state]}`, opacity: 0.4,
              animation: 'voice-ring-out 2s ease-out infinite',
            }} />
            <div style={{
              position: 'absolute', inset: -8, borderRadius: '50%',
              border: `1px solid ${stateColor[state]}`, opacity: 0.2,
              animation: 'voice-ring-out 2s ease-out 0.5s infinite',
            }} />
          </>
        )}
      </button>

      {/* Status label */}
      {isActive && state !== 'idle' && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 100,
          fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.2em', color: stateColor[state],
          textShadow: `0 0 8px ${stateColor[state]}`,
          textAlign: 'right', whiteSpace: 'nowrap',
        }}>
          {stateLabel[state]}
        </div>
      )}

      {/* Transcript/Response overlay */}
      {isActive && (transcript || agentText) && (
        <div style={{
          position: 'fixed', bottom: 96, right: 24, zIndex: 99,
          maxWidth: 360, display: 'flex', flexDirection: 'column',
          gap: 8, animation: 'convai-slide-up 0.3s ease-out',
        }}>
          {transcript && (
            <div style={{
              padding: '8px 14px',
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
              borderRadius: 8, backdropFilter: 'blur(8px)',
            }}>
              <div style={{
                fontSize: 8, color: 'rgba(245,158,11,0.5)',
                letterSpacing: '0.2em', marginBottom: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>YOU</div>
              <div style={{
                fontSize: 12, color: GOLD,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.5,
              }}>{transcript}</div>
            </div>
          )}

          {agentText && (
            <div style={{
              padding: '8px 14px',
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 8, backdropFilter: 'blur(8px)',
            }}>
              <div style={{
                fontSize: 8, color: 'rgba(34,197,94,0.5)',
                letterSpacing: '0.2em', marginBottom: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>JARVIS</div>
              <div style={{
                fontSize: 12, color: GREEN,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.5, maxHeight: 200, overflowY: 'auto',
              }}>{agentText}</div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes voice-btn-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes voice-ring-out {
          0% { transform: scale(1); opacity: 0.4; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes convai-slide-up {
          from { transform: translateY(10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}
