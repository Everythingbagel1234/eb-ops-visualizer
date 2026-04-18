'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * JARVIS Voice Interface — Browser STT → Bridge → ElevenLabs TTS
 * No ElevenLabs ConvAI dependency. Uses proven components:
 * - Web Speech API for speech recognition
 * - /api/voice endpoint (bridge → Anthropic → ElevenLabs TTS)
 * - Returns real Jarvis responses with voice
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
  const bufferRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortedRef = useRef(false);
  const listeningStartRef = useRef(0);

  const updateState = useCallback((s: VState) => {
    setState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  async function sendToJarvis(text: string) {
    updateState('processing');
    setAgentText('');

    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context: {} }),
      });

      const data = await res.json() as { response?: string; audio?: string | null };

      if (data.response) {
        setAgentText(data.response);
      }

      if (data.audio) {
        updateState('speaking');
        const audio = new Audio(`data:audio/mpeg;base64,${data.audio}`);
        audioRef.current = audio;

        audio.onended = () => {
          updateState('listening');
          startRecognition(); // Resume listening after speaking
        };

        await audio.play();
      } else {
        // No audio — resume listening after showing text
        setTimeout(() => {
          updateState('listening');
          startRecognition();
        }, 2000);
      }
    } catch (err) {
      console.error('[voice] Error:', err);
      updateState('listening');
      startRecognition();
    }
  }

  function startRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    recognitionRef.current?.abort();
    abortedRef.current = false;

    const rec = new SpeechRec();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let fullTranscript = '';
      for (let i = 0; i < event.results.length; i++) {
        fullTranscript += event.results[i][0]?.transcript || '';
      }
      bufferRef.current = fullTranscript.trim();
      setTranscript(bufferRef.current);

      // Auto-send after 3s of no new results
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (bufferRef.current.trim()) {
          const cmd = bufferRef.current.trim();
          bufferRef.current = '';
          abortedRef.current = true;
          rec.stop();
          sendToJarvis(cmd);
        }
      }, 3000);
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('[voice] Recognition error:', e.error);
    };

    rec.onend = () => {
      // If we have buffered text and haven't sent yet, send it now
      if (bufferRef.current.trim() && !abortedRef.current) {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        const cmd = bufferRef.current.trim();
        bufferRef.current = '';
        sendToJarvis(cmd);
        return;
      }
      // Auto-restart if still in listening mode
      if (!abortedRef.current && isActive) {
        setTimeout(() => {
          try {
            abortedRef.current = false;
            recognitionRef.current?.start();
          } catch { /* ignore */ }
        }, 300);
      }
    };

    try { rec.start(); } catch { /* ignore */ }

    // Safety: if no speech after 15s, auto-send whatever we have or reset
    listeningStartRef.current = Date.now();
    setTimeout(() => {
      if (Date.now() - listeningStartRef.current >= 14000 && !abortedRef.current) {
        if (bufferRef.current.trim()) {
          const cmd = bufferRef.current.trim();
          bufferRef.current = '';
          abortedRef.current = true;
          rec.stop();
          sendToJarvis(cmd);
        }
      }
    }, 15000);
  }

  function startConversation() {
    if (isActive) return;
    setIsActive(true);
    setTranscript('');
    setAgentText('');
    bufferRef.current = '';
    updateState('listening');
    startRecognition();
  }

  function stopConversation() {
    abortedRef.current = true;
    recognitionRef.current?.abort();
    audioRef.current?.pause();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current = null;
    audioRef.current = null;
    bufferRef.current = '';
    updateState('idle');
    setIsActive(false);
    setTranscript('');
    setAgentText('');
  }

  useEffect(() => () => { stopConversation(); }, []);

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
