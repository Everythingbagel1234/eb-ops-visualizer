'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * JARVIS Mic Button — Browser STT → Anthropic → ElevenLabs TTS
 * Uses the EXACT same Speech Recognition pattern as the working orb VoiceInterface,
 * minus the wake word requirement.
 */

const AMBER = '#F59E0B';
const GOLD = '#FCD34D';
const GREEN = '#22C55E';
const CYAN = '#22D3EE';

type VState = 'idle' | 'listening' | 'processing' | 'speaking';

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}
interface SpeechRecognitionErrorEvent extends Event { error: string; }
interface SpeechRecognitionResultList { readonly length: number; [i: number]: SpeechRecognitionResult; }
interface SpeechRecognitionResult { readonly length: number; isFinal: boolean; [i: number]: { transcript: string; confidence: number }; }

interface ConvAIVoiceProps {
  onStateChange?: (state: VState) => void;
}

export default function ConvAIVoice({ onStateChange }: ConvAIVoiceProps) {
  const [state, setState] = useState<VState>('idle');
  const [transcript, setTranscript] = useState('');
  const [agentText, setAgentText] = useState('');
  const [isActive, setIsActive] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const commandBufferRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Use voiceState string ref to avoid stale closures (same pattern as working VoiceInterface)
  const voiceStateRef = useRef<VState>('idle');

  const updateState = useCallback((s: VState) => {
    setState(s);
    voiceStateRef.current = s;
    onStateChange?.(s);
  }, [onStateChange]);

  // ─── Send to Jarvis (same as orb's sendCommand) ──────────

  async function sendCommand(text: string) {
    if (!text.trim()) return;
    updateState('processing');
    setTranscript(text);
    setAgentText('');

    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context: {} }),
      });

      const data = await res.json() as { response?: string; audio?: string | null };
      if (data.response) setAgentText(data.response);

      if (data.audio) {
        updateState('speaking');
        const audio = new Audio(`data:audio/mpeg;base64,${data.audio}`);
        audioRef.current = audio;
        audio.onended = () => {
          updateState('idle');
          // Auto-restart listening after response
          setTimeout(() => {
            if (voiceStateRef.current === 'idle') {
              startListening();
            }
          }, 500);
        };
        await audio.play();
      } else {
        updateState('idle');
        setTimeout(() => startListening(), 1000);
      }
    } catch (err) {
      console.error('[mic] Error:', err);
      updateState('idle');
      setTimeout(() => startListening(), 1000);
    }
  }

  // ─── Speech Recognition (copied from working VoiceInterface) ──

  function startListening() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    recognitionRef.current?.abort();

    const recognition = new SpeechRec();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    commandBufferRef.current = '';
    updateState('listening');

    // EXACT same pattern as the working orb VoiceInterface
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];

        if (result.isFinal) {
          const finalText = result[0]?.transcript || '';
          commandBufferRef.current += ' ' + finalText;
          commandBufferRef.current = commandBufferRef.current.trim();
          setTranscript(commandBufferRef.current);

          // Reset silence timer — 4s of silence then send
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            if (commandBufferRef.current.trim()) {
              recognition.stop();
              sendCommand(commandBufferRef.current.trim());
              commandBufferRef.current = '';
            }
          }, 4000);
        } else {
          // Show interim transcript
          const interim = commandBufferRef.current + ' ' + (result[0]?.transcript || '');
          setTranscript(interim.trim());
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') return;
      console.warn('[mic] Recognition error:', event.error);
    };

    // EXACT same restart pattern as working VoiceInterface
    recognition.onend = () => {
      if (voiceStateRef.current === 'idle' || voiceStateRef.current === 'listening') {
        setTimeout(() => {
          try { recognitionRef.current?.start(); } catch { /* ignore */ }
        }, 500);
      }
    };

    try { recognition.start(); } catch { /* ignore */ }
  }

  function startConversation() {
    if (isActive) return;
    setIsActive(true);
    setTranscript('');
    setAgentText('');
    startListening();
  }

  function stopConversation() {
    setIsActive(false);
    recognitionRef.current?.abort();
    audioRef.current?.pause();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current = null;
    audioRef.current = null;
    commandBufferRef.current = '';
    updateState('idle');
    setTranscript('');
    setAgentText('');
  }

  useEffect(() => () => {
    recognitionRef.current?.abort();
    audioRef.current?.pause();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  }, []);

  // ─── Render ───────────────────────────────────────────────

  const stateLabel: Record<VState, string> = {
    idle: '', listening: '◉ LISTENING', processing: '◈ PROCESSING', speaking: '◆ SPEAKING',
  };
  const stateColor: Record<VState, string> = {
    idle: 'rgba(245,158,11,0.3)', listening: AMBER, processing: CYAN, speaking: GREEN,
  };
  const color = stateColor[state];

  return (
    <>
      <button
        onClick={isActive ? stopConversation : startConversation}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 100,
          width: 56, height: 56, borderRadius: '50%',
          border: `2px solid ${isActive ? color : 'rgba(245,158,11,0.4)'}`,
          background: isActive ? `radial-gradient(circle, ${color}22, rgba(5,5,16,0.9))` : 'rgba(5,5,16,0.85)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: isActive ? `0 0 20px ${color}44, 0 0 40px ${color}22` : '0 0 10px rgba(245,158,11,0.15)',
          transition: 'all 0.3s ease',
          animation: state === 'listening' ? 'cv-pulse 1.5s ease-in-out infinite' : 'none',
        }}
        title={isActive ? 'End conversation' : 'Talk to Jarvis'}
      >
        {isActive ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="2">
            <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}
        {isActive && state !== 'idle' && (
          <>
            <div style={{ position: 'absolute', inset: -4, borderRadius: '50%', border: `1px solid ${color}`, opacity: 0.4, animation: 'cv-ring 2s ease-out infinite' }} />
            <div style={{ position: 'absolute', inset: -8, borderRadius: '50%', border: `1px solid ${color}`, opacity: 0.2, animation: 'cv-ring 2s ease-out 0.5s infinite' }} />
          </>
        )}
      </button>

      {isActive && state !== 'idle' && (
        <div style={{ position: 'fixed', bottom: 88, right: 24, zIndex: 100, fontSize: 9, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.2em', color, textShadow: `0 0 8px ${color}`, textAlign: 'right' }}>
          {stateLabel[state]}
        </div>
      )}

      {isActive && (transcript || agentText) && (
        <div style={{ position: 'fixed', bottom: 100, right: 24, zIndex: 99, maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 8, animation: 'cv-up 0.3s ease-out' }}>
          {transcript && (
            <div style={{ padding: '8px 14px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', backdropFilter: 'blur(8px)' }}>
              <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.5)', letterSpacing: '0.2em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>YOU</div>
              <div style={{ fontSize: 12, color: GOLD, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace" }}>{transcript}</div>
            </div>
          )}
          {agentText && (
            <div style={{ padding: '8px 14px', borderRadius: 8, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', backdropFilter: 'blur(8px)' }}>
              <div style={{ fontSize: 8, color: 'rgba(34,197,94,0.5)', letterSpacing: '0.2em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>JARVIS</div>
              <div style={{ fontSize: 12, color: GREEN, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace", maxHeight: 200, overflowY: 'auto' }}>{agentText}</div>
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
