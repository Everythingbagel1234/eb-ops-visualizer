'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

const AMBER = '#F59E0B';
const GREEN = '#22C55E';
const RED   = '#EF4444';

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

interface VoiceInterfaceProps {
  onStateChange?: (state: VoiceState) => void;
  cronContext?: { ok: number; error: number; total: number };
  errorContext?: string[];
}

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
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

export default function VoiceInterface({ onStateChange, cronContext, errorContext }: VoiceInterfaceProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [micPermission, setMicPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [isSupported, setIsSupported] = useState(false);
  const [isOverlayVisible, setIsOverlayVisible] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const commandBufferRef = useRef('');
  const wakeWordDetectedRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const updateState = useCallback((s: VoiceState) => {
    setVoiceState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // Check support
  useEffect(() => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    setIsSupported(!!SpeechRec);

    // Check stored permission
    const stored = localStorage.getItem('jarvis-mic-permission');
    if (stored === 'granted') setMicPermission('granted');
  }, []);

  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }

  function playActivationSound() {
    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);

      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    } catch { /* ignore audio errors */ }
  }

  async function requestMicPermission(): Promise<boolean> {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicPermission('granted');
      localStorage.setItem('jarvis-mic-permission', 'granted');
      return true;
    } catch {
      setMicPermission('denied');
      return false;
    }
  }

  async function sendCommand(text: string) {
    if (!text.trim()) return;

    updateState('processing');
    setTranscript(text);
    setResponse('');

    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          context: {
            cronHealth: cronContext,
            errors: errorContext,
          },
        }),
      });

      const data = await res.json() as { response?: string; audio?: string | null };

      if (data.response) {
        setResponse(data.response);
      }

      if (data.audio) {
        updateState('speaking');
        const audioData = `data:audio/mpeg;base64,${data.audio}`;
        const audio = new Audio(audioData);
        currentAudioRef.current = audio;

        audio.onended = () => {
          updateState('idle');
          setIsOverlayVisible(false);
          setTimeout(() => {
            setTranscript('');
            setResponse('');
          }, 2000);
        };

        await audio.play();
      } else {
        // No audio — just show text response
        setTimeout(() => {
          updateState('idle');
          setIsOverlayVisible(false);
          setTimeout(() => {
            setTranscript('');
            setResponse('');
          }, 3000);
        }, 4000);
      }
    } catch (err) {
      console.error('[voice] Error sending command:', err);
      updateState('idle');
      setIsOverlayVisible(false);
    }
  }

  function startListening() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    // Stop any existing recognition
    recognitionRef.current?.abort();

    const recognition = new SpeechRec();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.toLowerCase() || '';

        if (!wakeWordDetectedRef.current) {
          // Listen for wake word "jarvis"
          if (/\bjarvis\b/.test(text)) {
            wakeWordDetectedRef.current = true;
            commandBufferRef.current = '';
            playActivationSound();
            setIsOverlayVisible(true);
            updateState('listening');

            // Extract anything after "jarvis"
            const afterJarvis = text.replace(/.*\bjarvis\b\s*/i, '').trim();
            if (afterJarvis) {
              commandBufferRef.current = afterJarvis;
              setTranscript(afterJarvis);
            }
          }
        } else {
          // We're capturing the command
          if (result.isFinal) {
            const finalText = result[0]?.transcript || '';
            commandBufferRef.current += ' ' + finalText;
            commandBufferRef.current = commandBufferRef.current.trim();
            setTranscript(commandBufferRef.current);

            // Reset silence timer
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = setTimeout(() => {
              // 4s of silence — send command (was 2s, too aggressive)
              if (commandBufferRef.current.trim()) {
                recognition.stop();
                sendCommand(commandBufferRef.current.trim());
                commandBufferRef.current = '';
                wakeWordDetectedRef.current = false;
              }
            }, 4000);
          } else {
            // Show interim transcript
            const interim = commandBufferRef.current + ' ' + (result[0]?.transcript || '');
            setTranscript(interim.trim());
          }
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') return; // ignore — restart
      console.warn('[voice] Recognition error:', event.error);
    };

    recognition.onend = () => {
      // Auto-restart if we're still in idle/listening state
      if (voiceState === 'idle' || voiceState === 'listening') {
        setTimeout(() => {
          try { recognitionRef.current?.start(); } catch { /* ignore */ }
        }, 500);
      }
    };

    try {
      recognition.start();
    } catch { /* ignore */ }
  }

  async function handleOrbClick() {
    if (voiceState === 'speaking') {
      // Stop audio
      currentAudioRef.current?.pause();
      updateState('idle');
      setIsOverlayVisible(false);
      return;
    }

    if (micPermission !== 'granted') {
      const granted = await requestMicPermission();
      if (!granted) {
        alert('Microphone access is required for voice interaction. Please allow microphone access in your browser settings.');
        return;
      }
    }

    if (!isSupported) {
      alert('Your browser does not support voice recognition. Please use Chrome or Edge.');
      return;
    }

    if (voiceState === 'idle') {
      startListening();
    }
  }

  // Auto-start wake word detection when mic permission is granted
  useEffect(() => {
    if (micPermission === 'granted' && isSupported) {
      startListening();
    }
    return () => {
      recognitionRef.current?.abort();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micPermission, isSupported]);

  // Mic icon color
  const micColor = micPermission === 'granted' ? GREEN
    : micPermission === 'denied' ? RED
    : 'rgba(245,158,11,0.4)';

  return (
    <>
      {/* Orb click handler overlay (transparent, positioned over the orb) */}
      <div
        onClick={handleOrbClick}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 120,
          height: 120,
          borderRadius: '50%',
          cursor: 'pointer',
          zIndex: 5,
        }}
        title="Click to activate voice / Say 'Jarvis' to wake"
      />

      {/* Mic indicator - shown on orb */}
      <div style={{
        position: 'absolute',
        left: '50%',
        top: 'calc(50% + 85px)',
        transform: 'translateX(-50%)',
        zIndex: 6,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}>
        <span style={{ fontSize: 10, color: micColor }}>
          {micPermission === 'granted' ? '🎤' : '🎤'}
        </span>
      </div>

      {/* Voice overlay */}
      {isOverlayVisible && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          background: 'rgba(5, 5, 16, 0.85)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
          backdropFilter: 'blur(8px)',
        }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              // Click outside — cancel
              recognitionRef.current?.abort();
              currentAudioRef.current?.pause();
              updateState('idle');
              setIsOverlayVisible(false);
              wakeWordDetectedRef.current = false;
              commandBufferRef.current = '';
            }
          }}
        >
          {/* Status indicator */}
          <div style={{
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.3em',
            color: voiceState === 'listening' ? AMBER
              : voiceState === 'processing' ? '#60A5FA'
              : voiceState === 'speaking' ? GREEN
              : 'rgba(245,158,11,0.5)',
            textShadow: `0 0 10px currentColor`,
            animation: voiceState !== 'idle' ? 'jarvis-glow 1.5s ease-in-out infinite' : 'none',
          }}>
            {voiceState === 'listening' && '◉ LISTENING...'}
            {voiceState === 'processing' && '◈ PROCESSING...'}
            {voiceState === 'speaking' && '◆ SPEAKING'}
          </div>

          {/* Waveform visualization rings */}
          <div style={{ position: 'relative', width: 200, height: 200 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                position: 'absolute',
                inset: `${i * 20}px`,
                borderRadius: '50%',
                border: `1px solid ${AMBER}`,
                opacity: voiceState === 'listening' ? 0.6 - i * 0.15 : 0.2,
                animation: voiceState === 'listening' || voiceState === 'speaking'
                  ? `voice-ring ${1.2 + i * 0.4}s ease-in-out infinite`
                  : voiceState === 'processing'
                  ? `voice-ring ${0.6 + i * 0.2}s ease-in-out infinite`
                  : 'none',
              }} />
            ))}
            <div style={{
              position: 'absolute',
              inset: '60px',
              borderRadius: '50%',
              background: `radial-gradient(circle, rgba(245,158,11,0.3) 0%, rgba(245,158,11,0.1) 50%, transparent 100%)`,
              border: `2px solid ${AMBER}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              color: AMBER,
              textShadow: `0 0 20px ${AMBER}`,
            }}>
              {voiceState === 'processing' ? '◈' : voiceState === 'speaking' ? '◆' : '◉'}
            </div>
          </div>

          {/* Transcript */}
          {transcript && (
            <div style={{
              maxWidth: 500,
              textAlign: 'center',
              padding: '12px 24px',
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.2)',
              borderRadius: 8,
            }}>
              <div style={{
                fontSize: 9,
                color: 'rgba(245,158,11,0.5)',
                letterSpacing: '0.2em',
                marginBottom: 8,
                fontFamily: "'JetBrains Mono', monospace",
              }}>YOU SAID</div>
              <div style={{
                fontSize: 13,
                color: AMBER,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.6,
              }}>
                {transcript}
              </div>
            </div>
          )}

          {/* Response */}
          {response && (
            <div style={{
              maxWidth: 500,
              textAlign: 'center',
              padding: '12px 24px',
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 8,
            }}>
              <div style={{
                fontSize: 9,
                color: 'rgba(34,197,94,0.5)',
                letterSpacing: '0.2em',
                marginBottom: 8,
                fontFamily: "'JetBrains Mono', monospace",
              }}>J.A.R.V.I.S.</div>
              <div style={{
                fontSize: 13,
                color: GREEN,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.6,
              }}>
                {response}
              </div>
            </div>
          )}

          <div style={{
            fontSize: 9,
            color: 'rgba(245,158,11,0.3)',
            letterSpacing: '0.15em',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            CLICK ANYWHERE TO DISMISS
          </div>
        </div>
      )}

      <style>{`
        @keyframes voice-ring {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.08); opacity: 0.9; }
        }
      `}</style>
    </>
  );
}
