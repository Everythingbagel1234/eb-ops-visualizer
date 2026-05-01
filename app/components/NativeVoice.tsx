'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

// Web Speech API types (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
}

const AMBER = '#F59E0B';
const GREEN = '#22C55E';
const CYAN = '#22D3EE';

export type NativeVoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

interface NativeVoiceProps {
  onStateChange?: (state: NativeVoiceState) => void;
}

export default function NativeVoice({ onStateChange }: NativeVoiceProps) {
  const [state, setState] = useState<NativeVoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);

  const updateState = useCallback((s: NativeVoiceState) => {
    setState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // Check browser support
  const supported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getSpeechRecognition = (): (new () => SpeechRecognitionInstance) | null => {
    if (typeof window === 'undefined') return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
  };

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const sendToJarvis = useCallback(async (text: string) => {
    if (!text.trim()) {
      updateState('idle');
      return;
    }

    updateState('processing');
    setError(null);

    try {
      const res = await fetch('/api/voice-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`API error: ${res.status}`);

      const data = await res.json() as { response?: string; error?: string };
      const reply = data.response || data.error || 'No response';

      setResponse(reply);
      updateState('speaking');

      // Speak the response
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(reply);
        utter.rate = 1.05;
        utter.pitch = 0.95;

        // Try to find a good voice
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find(v =>
          /daniel|james|google uk|british/i.test(v.name)
        ) || voices.find(v => /english/i.test(v.lang) && /male/i.test(v.name))
          || voices[0];
        if (preferred) utter.voice = preferred;

        utter.onend = () => {
          updateState('idle');
          setTranscript('');
          setResponse('');
        };
        utter.onerror = () => updateState('idle');

        synthRef.current = utter;
        window.speechSynthesis.speak(utter);
      } else {
        // No TTS — just show text
        setTimeout(() => {
          updateState('idle');
          setTranscript('');
          setResponse('');
        }, 4000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice error');
      updateState('idle');
    }
  }, [updateState]);

  const startListening = useCallback(() => {
    if (!supported) {
      setError('Speech recognition not supported in this browser');
      return;
    }

    setTranscript('');
    setResponse('');
    setError(null);
    window.speechSynthesis?.cancel();

    const SpeechRec = getSpeechRecognition();
    if (!SpeechRec) return;

    const recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += t + ' ';
        } else {
          interim = t;
        }
      }
      setTranscript((finalTranscript + interim).trim());

      // Reset silence timer
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        recognition.stop();
      }, 3000);
    };

    recognition.onend = () => {
      const text = finalTranscript.trim();
      if (text) {
        sendToJarvis(text);
      } else {
        updateState('idle');
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        setError(`Mic error: ${event.error}`);
      }
      updateState('idle');
    };

    recognitionRef.current = recognition;
    recognition.start();
    updateState('listening');

    // Safety timeout: 15s max
    silenceTimerRef.current = setTimeout(() => {
      recognition.stop();
    }, 15000);
  }, [supported, sendToJarvis, updateState]);

  const toggleVoice = useCallback(() => {
    if (state === 'listening') {
      stopListening();
    } else if (state === 'speaking') {
      window.speechSynthesis?.cancel();
      updateState('idle');
    } else if (state === 'idle') {
      startListening();
    }
  }, [state, startListening, stopListening, updateState]);

  // Load voices
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
  }, []);

  if (!supported) return null;

  const stateConfig = {
    idle:       { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', color: AMBER, icon: '🎙️', label: '' },
    listening:  { bg: 'rgba(34,197,94,0.2)',    border: GREEN,                  color: GREEN, icon: '◉',   label: 'LISTENING' },
    processing: { bg: 'rgba(245,158,11,0.2)',   border: AMBER,                  color: AMBER, icon: '◈',   label: 'THINKING' },
    speaking:   { bg: 'rgba(34,211,238,0.15)',  border: CYAN,                   color: CYAN,  icon: '◆',   label: 'SPEAKING' },
  };

  const cfg = stateConfig[state];

  return (
    <>
      {/* Transcript / Response overlay */}
      {(transcript || response || error) && (
        <div style={{
          position: 'fixed',
          bottom: 90,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 50,
          maxWidth: 420,
          width: '90vw',
          background: 'rgba(14,6,0,0.95)',
          border: `1px solid ${cfg.border}`,
          borderRadius: 12,
          padding: '12px 16px',
          fontFamily: "'JetBrains Mono', monospace",
          backdropFilter: 'blur(12px)',
          boxShadow: `0 0 30px rgba(245,158,11,0.1)`,
        }}>
          {error && (
            <div style={{ fontSize: 10, color: '#EF4444', marginBottom: 4 }}>
              ✗ {error}
            </div>
          )}
          {transcript && state !== 'speaking' && (
            <div style={{ fontSize: 11, color: 'rgba(245,158,11,0.7)', marginBottom: response ? 8 : 0 }}>
              <span style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.15em' }}>YOU: </span>
              {transcript}
            </div>
          )}
          {response && (
            <div style={{ fontSize: 11, color: AMBER }}>
              <span style={{ fontSize: 8, color: 'rgba(34,211,238,0.6)', letterSpacing: '0.15em' }}>JARVIS: </span>
              {response}
            </div>
          )}
        </div>
      )}

      {/* Mic button */}
      <button
        onClick={toggleVoice}
        disabled={state === 'processing'}
        style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 45,
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: cfg.bg,
          border: `2px solid ${cfg.border}`,
          cursor: state === 'processing' ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 2,
          boxShadow: state !== 'idle' ? `0 0 20px ${cfg.border}` : 'none',
          transition: 'all 0.3s ease',
          animation: state === 'listening' ? 'voice-pulse 1.5s ease-in-out infinite' : state === 'speaking' ? 'voice-pulse 2s ease-in-out infinite' : 'none',
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1 }}>{cfg.icon}</span>
        {cfg.label && (
          <span style={{
            fontSize: 6,
            color: cfg.color,
            letterSpacing: '0.15em',
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
          }}>
            {cfg.label}
          </span>
        )}
      </button>

      <style>{`
        @keyframes voice-pulse {
          0%, 100% { box-shadow: 0 0 8px ${cfg.border}; }
          50% { box-shadow: 0 0 24px ${cfg.border}, 0 0 48px ${cfg.border}40; }
        }
      `}</style>
    </>
  );
}
