'use client';

import { useCallback, useState, useEffect } from 'react';
import { useConversation } from '@elevenlabs/react';

const AMBER = '#F59E0B';
const GREEN = '#22C55E';
// const RED   = '#EF4444';

export type ConvVoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

interface VoiceConversationProps {
  onStateChange?: (state: ConvVoiceState) => void;
}

export default function VoiceConversation({ onStateChange }: VoiceConversationProps) {
  const [isActive, setIsActive] = useState(false);
  const [voiceState, setVoiceState] = useState<ConvVoiceState>('idle');
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastResponse, setLastResponse] = useState('');

  const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || '';

  const conversation = useConversation({
    onConnect: () => {
      console.log('[voice] Connected to ElevenLabs Conversational AI');
      updateState('listening');
    },
    onDisconnect: () => {
      console.log('[voice] Disconnected');
      updateState('idle');
      setIsActive(false);
    },
    onMessage: ({ message, source }: { message: string; source: string }) => {
      if (source === 'user') {
        setLastTranscript(message);
        updateState('processing');
      } else if (source === 'ai') {
        setLastResponse(message);
        updateState('speaking');
      }
    },
    onError: (error: string) => {
      console.error('[voice] Error:', error);
      updateState('idle');
    },
  });

  const updateState = useCallback((s: ConvVoiceState) => {
    setVoiceState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // When speaking finishes, go back to listening
  useEffect(() => {
    if (conversation.isSpeaking === false && isActive && voiceState === 'speaking') {
      updateState('listening');
    }
  }, [conversation.isSpeaking, isActive, voiceState, updateState]);

  const handleOrbClick = useCallback(async () => {
    if (isActive) {
      await conversation.endSession();
      setIsActive(false);
      updateState('idle');
      return;
    }

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      await conversation.startSession({ agentId });
      setIsActive(true);
    } catch (err) {
      console.error('[voice] Failed to start:', err);
      alert('Microphone access is required. Please allow it in your browser settings.');
    }
  }, [isActive, conversation, agentId, updateState]);

  const micColor = isActive ? GREEN : 'rgba(245,158,11,0.4)';

  return (
    <>
      {/* Orb click handler (transparent overlay) */}
      <div
        onClick={handleOrbClick}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 140,
          height: 140,
          borderRadius: '50%',
          cursor: 'pointer',
          zIndex: 5,
        }}
        title={isActive ? 'Tap to end conversation' : 'Tap to start voice conversation'}
      />

      {/* Mic indicator */}
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
        <span style={{ fontSize: 12, color: micColor }}>
          {isActive ? '🎤' : '🎤'}
        </span>
        {isActive && (
          <span style={{
            fontSize: 8, color: GREEN,
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.1em',
          }}>
            LIVE
          </span>
        )}
      </div>

      {/* Active conversation overlay with transcript */}
      {isActive && (lastTranscript || lastResponse) && (
        <div style={{
          position: 'absolute',
          bottom: 80,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
          background: 'rgba(14,6,0,0.9)',
          border: `1px solid rgba(245,158,11,0.3)`,
          borderRadius: 12,
          padding: '10px 16px',
          maxWidth: '80vw',
          minWidth: 250,
          fontFamily: "'JetBrains Mono', monospace",
          backdropFilter: 'blur(8px)',
        }}>
          {lastTranscript && (
            <div style={{ fontSize: 9, color: 'rgba(245,158,11,0.5)', marginBottom: 4 }}>
              You: {lastTranscript}
            </div>
          )}
          {lastResponse && (
            <div style={{ fontSize: 10, color: AMBER }}>
              Jarvis: {lastResponse}
            </div>
          )}
        </div>
      )}
    </>
  );
}
