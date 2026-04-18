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
  const [, setMicGranted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);

  const updateState = useCallback((s: ConvState) => {
    setState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // Convert base64 to Float32Array (PCM 16-bit → float)
  function base64ToFloat32(base64: string): Float32Array {
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
    return float32;
  }

  // Play audio chunks
  function playAudioChunk(float32Data: Float32Array) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    const buffer = ctx.createBuffer(1, float32Data.length, 16000);
    buffer.getChannelData(0).set(float32Data);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    const startTime = Math.max(currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;

    source.onended = () => {
      // Check if more audio in queue
      if (audioQueueRef.current.length > 0) {
        const next = audioQueueRef.current.shift()!;
        playAudioChunk(next);
      } else {
        isPlayingRef.current = false;
        // Don't go to idle yet — wait for agent to finish
      }
    };
  }

  function queueAudio(float32Data: Float32Array) {
    if (isPlayingRef.current) {
      audioQueueRef.current.push(float32Data);
    } else {
      isPlayingRef.current = true;
      playAudioChunk(float32Data);
    }
  }

  // AudioWorklet processor code as a blob URL
  function createWorkletUrl(): string {
    const code = `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._buffer = new Float32Array(0);
        }
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) {
            const samples = input[0];
            // Accumulate and send when we have enough
            const newBuf = new Float32Array(this._buffer.length + samples.length);
            newBuf.set(this._buffer);
            newBuf.set(samples, this._buffer.length);
            this._buffer = newBuf;
            
            // Send every ~4096 samples (256ms at 16kHz)
            if (this._buffer.length >= 4096) {
              // Convert to 16-bit PCM
              const pcm = new Int16Array(this._buffer.length);
              for (let i = 0; i < this._buffer.length; i++) {
                const s = Math.max(-1, Math.min(1, this._buffer[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              this.port.postMessage(pcm.buffer, [pcm.buffer]);
              this._buffer = new Float32Array(0);
            }
          }
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }

  async function startConversation() {
    if (isActive) return;
    setIsActive(true);
    updateState('connecting');
    setTranscript('');
    setAgentText('');
    audioQueueRef.current = [];
    isPlayingRef.current = false;

    try {
      // 1. Get signed URL
      const tokenRes = await fetch('/api/voice-token');
      const tokenData = await tokenRes.json() as { signed_url?: string; error?: string };
      if (!tokenData.signed_url) {
        throw new Error(tokenData.error || 'No signed URL');
      }

      // 2. Set up AudioContext at 16kHz
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      nextPlayTimeRef.current = 0;

      // 3. Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      streamRef.current = stream;
      setMicGranted(true);

      // 4. Connect WebSocket
      const ws = new WebSocket(tokenData.signed_url);
      wsRef.current = ws;

      ws.onopen = async () => {
        updateState('listening');

        // Set up audio worklet for mic capture
        const workletUrl = createWorkletUrl();
        await ctx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
        workletRef.current = worklet;

        worklet.port.onmessage = (e: MessageEvent) => {
          if (ws.readyState === WebSocket.OPEN) {
            // Send raw PCM bytes as binary
            const pcmBuffer = e.data as ArrayBuffer;
            // Base64 encode for ElevenLabs
            const uint8 = new Uint8Array(pcmBuffer);
            let binary = '';
            for (let i = 0; i < uint8.length; i++) {
              binary += String.fromCharCode(uint8[i]);
            }
            const b64 = btoa(binary);
            ws.send(JSON.stringify({
              user_audio_chunk: b64,
            }));
          }
        };

        source.connect(worklet);
        worklet.connect(ctx.destination); // needed to keep worklet running
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);

          switch (msg.type) {
            case 'conversation_initiation_metadata':
              // Agent is ready
              break;

            case 'user_transcript':
              if (msg.user_transcript_event?.user_transcript) {
                setTranscript(msg.user_transcript_event.user_transcript);
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
                const float32 = base64ToFloat32(msg.audio_event.audio_base_64);
                queueAudio(float32);
              }
              break;

            case 'interruption':
              // User interrupted — clear audio queue
              audioQueueRef.current = [];
              isPlayingRef.current = false;
              nextPlayTimeRef.current = 0;
              setAgentText('');
              updateState('listening');
              break;

            case 'agent_response_correction':
              if (msg.agent_response_correction_event?.corrected_agent_response) {
                setAgentText(msg.agent_response_correction_event.corrected_agent_response);
              }
              break;

            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
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

      ws.onerror = () => {
        cleanup();
        updateState('idle');
        setIsActive(false);
      };

    } catch (err) {
      console.error('[convai] Error:', err);
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
    workletRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    wsRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    workletRef.current = null;
    sourceRef.current = null;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => { cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stateLabel = {
    idle: '',
    connecting: 'CONNECTING',
    listening: '◉ LISTENING',
    thinking: '◈ PROCESSING',
    speaking: '◆ SPEAKING',
  };

  const stateColor = {
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
          animation: state === 'listening' ? 'voice-pulse 1.5s ease-in-out infinite' : 'none',
        }}
        title={isActive ? 'End conversation' : 'Talk to Jarvis'}
      >
        {/* Mic / Stop icon */}
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

        {/* Pulse rings when active */}
        {isActive && state !== 'idle' && (
          <>
            <div style={{
              position: 'absolute',
              inset: -4,
              borderRadius: '50%',
              border: `1px solid ${stateColor[state]}`,
              opacity: 0.4,
              animation: 'voice-ring-out 2s ease-out infinite',
            }} />
            <div style={{
              position: 'absolute',
              inset: -8,
              borderRadius: '50%',
              border: `1px solid ${stateColor[state]}`,
              opacity: 0.2,
              animation: 'voice-ring-out 2s ease-out 0.5s infinite',
            }} />
          </>
        )}
      </button>

      {/* Status label above button */}
      {isActive && state !== 'idle' && (
        <div style={{
          position: 'fixed',
          bottom: 88,
          right: 24,
          zIndex: 100,
          fontSize: 9,
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.2em',
          color: stateColor[state],
          textShadow: `0 0 8px ${stateColor[state]}`,
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}>
          {stateLabel[state]}
        </div>
      )}

      {/* Transcript/Response overlay — slides up from bottom */}
      {isActive && (transcript || agentText) && (
        <div style={{
          position: 'fixed',
          bottom: 96,
          right: 24,
          zIndex: 99,
          maxWidth: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          animation: 'slide-up 0.3s ease-out',
        }}>
          {/* User transcript */}
          {transcript && (
            <div style={{
              padding: '8px 14px',
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
              borderRadius: 8,
              backdropFilter: 'blur(8px)',
            }}>
              <div style={{
                fontSize: 8,
                color: 'rgba(245,158,11,0.5)',
                letterSpacing: '0.2em',
                marginBottom: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>YOU</div>
              <div style={{
                fontSize: 12,
                color: GOLD,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.5,
              }}>
                {transcript}
              </div>
            </div>
          )}

          {/* Agent response */}
          {agentText && (
            <div style={{
              padding: '8px 14px',
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 8,
              backdropFilter: 'blur(8px)',
            }}>
              <div style={{
                fontSize: 8,
                color: 'rgba(34,197,94,0.5)',
                letterSpacing: '0.2em',
                marginBottom: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>JARVIS</div>
              <div style={{
                fontSize: 12,
                color: GREEN,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.5,
                maxHeight: 200,
                overflowY: 'auto',
              }}>
                {agentText}
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes voice-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes voice-ring-out {
          0% { transform: scale(1); opacity: 0.4; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes slide-up {
          from { transform: translateY(10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}
