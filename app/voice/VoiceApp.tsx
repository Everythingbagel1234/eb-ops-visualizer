'use client';

import { useState, useCallback, useEffect } from 'react';
import { useConversation } from '@elevenlabs/react';

const BG = '#050510';
const AMBER = '#F59E0B';
const GREEN = '#22C55E';

export default function VoiceApp() {
  const [isActive, setIsActive] = useState(false);
  const [transcript, setTranscript] = useState<Array<{role: string; text: string}>>([]);
  const [status, setStatus] = useState('Tap to connect');

  const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || '';

  const conversation = useConversation({
    onConnect: () => {
      setStatus('Listening...');
      setIsActive(true);
    },
    onDisconnect: () => {
      setStatus('Tap to connect');
      setIsActive(false);
    },
    onMessage: ({ message, source }: { message: string; source: string }) => {
      setTranscript(prev => [...prev.slice(-10), { 
        role: source === 'user' ? 'You' : 'Jarvis', 
        text: message 
      }]);
      if (source === 'ai') setStatus('Speaking...');
      if (source === 'user') setStatus('Processing...');
    },
    onError: (error: string) => {
      console.error('[voice]', error);
      setStatus('Error — tap to retry');
      setIsActive(false);
    },
  });

  useEffect(() => {
    if (conversation.isSpeaking === false && isActive) {
      setStatus('Listening...');
    }
  }, [conversation.isSpeaking, isActive]);

  const handleToggle = useCallback(async () => {
    if (isActive) {
      await conversation.endSession();
      return;
    }
    try {
      setStatus('Connecting...');
      await navigator.mediaDevices.getUserMedia({ audio: true });
      await conversation.startSession({ agentId });
    } catch (err) {
      console.error('[voice] Start failed:', err);
      setStatus('Mic access denied');
    }
  }, [isActive, conversation, agentId]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: BG,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', fontFamily: "'SF Pro', -apple-system, sans-serif",
      overflow: 'hidden',
    }}>
      {/* Ambient glow */}
      <div style={{
        position: 'absolute', width: 300, height: 300, borderRadius: '50%',
        background: `radial-gradient(circle, ${isActive ? 'rgba(245,158,11,0.15)' : 'rgba(245,158,11,0.05)'} 0%, transparent 70%)`,
        transition: 'all 0.5s ease',
      }} />

      {/* Orb button */}
      <button
        onClick={handleToggle}
        style={{
          width: 120, height: 120, borderRadius: '50%',
          border: `2px solid ${isActive ? AMBER : 'rgba(245,158,11,0.3)'}`,
          background: isActive 
            ? `radial-gradient(circle at 40% 40%, rgba(245,158,11,0.2), rgba(245,158,11,0.05))` 
            : 'rgba(245,158,11,0.03)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.3s ease',
          boxShadow: isActive ? `0 0 40px rgba(245,158,11,0.2), 0 0 80px rgba(245,158,11,0.1)` : 'none',
          position: 'relative', zIndex: 2,
        }}
      >
        <span style={{ fontSize: 32 }}>
          {isActive ? '🎤' : '⚡'}
        </span>
      </button>

      {/* Status */}
      <div style={{
        marginTop: 20, fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase',
        color: isActive ? GREEN : 'rgba(245,158,11,0.5)',
        fontFamily: "'JetBrains Mono', monospace",
        transition: 'color 0.3s',
      }}>
        {status}
      </div>

      {/* Transcript */}
      <div style={{
        position: 'absolute', bottom: 40, left: 20, right: 20,
        maxHeight: '35vh', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {transcript.map((msg, i) => (
          <div key={i} style={{
            padding: '8px 12px',
            borderRadius: 10,
            background: msg.role === 'You' ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
            borderLeft: `2px solid ${msg.role === 'You' ? AMBER : GREEN}`,
          }}>
            <div style={{ fontSize: 9, color: msg.role === 'You' ? AMBER : GREEN, fontWeight: 600, marginBottom: 2 }}>
              {msg.role}
            </div>
            <div style={{ fontSize: 13, color: '#e5e5e5', lineHeight: 1.4 }}>
              {msg.text}
            </div>
          </div>
        ))}
      </div>

      {/* Header */}
      <div style={{
        position: 'absolute', top: 20, left: 20, right: 20,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ fontSize: 10, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.15em', fontFamily: "'JetBrains Mono', monospace" }}>
          JARVIS VOICE
        </div>
        <a href="/" style={{ fontSize: 10, color: 'rgba(245,158,11,0.3)', textDecoration: 'none' }}>
          ← Dashboard
        </a>
      </div>
    </div>
  );
}
