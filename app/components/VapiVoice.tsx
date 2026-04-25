'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

const AMBER = '#F59E0B';
const GOLD = '#FCD34D';
const GREEN = '#22C55E';
const CYAN = '#22D3EE';

export type VapiVoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'processing';

interface VapiVoiceProps {
  onStateChange?: (state: VapiVoiceState) => void;
}

export default function VapiVoice({ onStateChange }: VapiVoiceProps) {
  const [state, setState] = useState<VapiVoiceState>('idle');
  const [isActive, setIsActive] = useState(false);
  const [userTranscript, setUserTranscript] = useState('');
  const [agentText, setAgentText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vapiRef = useRef<any>(null);

  const updateState = useCallback((s: VapiVoiceState) => {
    setState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  const startCall = useCallback(async () => {
    if (isActive) return;

    const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
    const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;

    if (!publicKey || !assistantId) {
      setError('Vapi not configured');
      setTimeout(() => setError(null), 3000);
      return;
    }

    setIsActive(true);
    setError(null);
    setUserTranscript('');
    setAgentText('');
    updateState('connecting');

    const { default: Vapi } = await import('@vapi-ai/web');
    const vapi = new Vapi(publicKey);
    vapiRef.current = vapi;

    vapi.on('call-start', () => {
      updateState('listening');
    });

    vapi.on('call-end', () => {
      updateState('idle');
      setIsActive(false);
      vapiRef.current = null;
    });

    vapi.on('speech-start', () => {
      updateState('speaking');
    });

    vapi.on('speech-end', () => {
      updateState('listening');
    });

    vapi.on('message', (msg: Record<string, unknown>) => {
      if (msg.type === 'transcript') {
        if (msg.role === 'user' && msg.transcriptType === 'final') {
          setUserTranscript(String(msg.transcript ?? ''));
        } else if (msg.role === 'assistant') {
          setAgentText(String(msg.transcript ?? ''));
        }
      }
    });

    vapi.on('error', (err: Record<string, unknown> & { message?: string; error?: { message?: string } }) => {
      console.error('[vapi]', err);
      const errMsg = (err?.error as { message?: string })?.message || err?.message || 'Connection error';
      setError(errMsg);
      setTimeout(() => setError(null), 4000);
      updateState('idle');
      setIsActive(false);
      vapiRef.current = null;
    });

    try {
      await vapi.start(assistantId);
    } catch (err: unknown) {
      const e = err as { message?: string };
      console.error('[vapi start]', err);
      setError(e?.message || 'Failed to start call');
      setTimeout(() => setError(null), 4000);
      updateState('idle');
      setIsActive(false);
      vapiRef.current = null;
    }
  }, [isActive, updateState]);

  const stopCall = useCallback(() => {
    vapiRef.current?.stop();
    updateState('idle');
    setIsActive(false);
    vapiRef.current = null;
  }, [updateState]);

  useEffect(() => () => { vapiRef.current?.stop(); }, []);

  const stateLabel: Record<VapiVoiceState, string> = {
    idle: '',
    connecting: 'CONNECTING',
    listening: '◉ LISTENING',
    speaking: '◆ SPEAKING',
    processing: '◈ PROCESSING',
  };

  const stateColor: Record<VapiVoiceState, string> = {
    idle: 'rgba(245,158,11,0.3)',
    connecting: CYAN,
    listening: AMBER,
    speaking: GREEN,
    processing: CYAN,
  };

  const color = stateColor[state];

  return (
    <>
      <button
        onClick={isActive ? stopCall : startCall}
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
          animation: state === 'listening' ? 'vapi-pulse 1.5s ease-in-out infinite' : 'none',
        }}
        title={isActive ? 'End conversation' : 'Talk to Jarvis (Vapi)'}
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
            <div style={{ position: 'absolute', inset: -4, borderRadius: '50%', border: `1px solid ${color}`, opacity: 0.4, animation: 'vapi-ring 2s ease-out infinite' }} />
            <div style={{ position: 'absolute', inset: -8, borderRadius: '50%', border: `1px solid ${color}`, opacity: 0.2, animation: 'vapi-ring 2s ease-out 0.5s infinite' }} />
          </>
        )}
      </button>

      {isActive && state !== 'idle' && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 100,
          fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.2em', color, textShadow: `0 0 8px ${color}`,
          textAlign: 'right',
        }}>
          {stateLabel[state]}
        </div>
      )}

      {error && (
        <div style={{
          position: 'fixed', bottom: 88, right: 24, zIndex: 101,
          padding: '6px 12px', borderRadius: 6,
          background: 'rgba(228,60,41,0.15)', border: '1px solid rgba(228,60,41,0.4)',
          fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
          color: '#E43C29', letterSpacing: '0.1em',
          animation: 'vapi-up 0.3s ease-out',
        }}>
          ⚠ {error}
        </div>
      )}

      {isActive && (userTranscript || agentText) && (
        <div style={{
          position: 'fixed', bottom: 100, right: 24, zIndex: 99,
          maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 8,
          animation: 'vapi-up 0.3s ease-out',
        }}>
          {userTranscript && (
            <div style={{
              padding: '8px 14px', borderRadius: 8,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
              backdropFilter: 'blur(8px)',
            }}>
              <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.5)', letterSpacing: '0.2em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>YOU</div>
              <div style={{ fontSize: 12, color: GOLD, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace" }}>{userTranscript}</div>
            </div>
          )}
          {agentText && (
            <div style={{
              padding: '8px 14px', borderRadius: 8,
              background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)',
              backdropFilter: 'blur(8px)',
            }}>
              <div style={{ fontSize: 8, color: 'rgba(34,197,94,0.5)', letterSpacing: '0.2em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>JARVIS</div>
              <div style={{ fontSize: 12, color: GREEN, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace", maxHeight: 200, overflowY: 'auto' }}>{agentText}</div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes vapi-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes vapi-ring { 0% { transform: scale(1); opacity: 0.4; } 100% { transform: scale(1.8); opacity: 0; } }
        @keyframes vapi-up { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
    </>
  );
}
