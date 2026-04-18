'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';

const OpsVisualizer = dynamic(() => import('./components/OpsVisualizer'), { ssr: false });

const AMBER = '#F59E0B';
const BG    = '#050510';

function verifyLocalToken(): boolean {
  try {
    const stored = localStorage.getItem('jarvis-auth-token');
    if (!stored) return false;
    const { token, expiresAt } = JSON.parse(stored) as { token: string; expiresAt: number };
    if (!token || !expiresAt) return false;
    if (Date.now() > expiresAt) {
      localStorage.removeItem('jarvis-auth-token');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function OrbAnimation() {
  return (
    <div style={{
      position: 'absolute',
      width: 180,
      height: 180,
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -200px)',
      opacity: 0.35,
    }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          position: 'absolute',
          inset: `${i * 18}px`,
          borderRadius: '50%',
          border: `${1.5 - i * 0.3}px solid ${AMBER}`,
          animation: `orbRing ${2 + i * 0.5}s ease-in-out infinite`,
          animationDelay: `${i * 0.4}s`,
        }} />
      ))}
      <div style={{
        position: 'absolute',
        inset: '55px',
        borderRadius: '50%',
        background: `radial-gradient(circle, rgba(245,158,11,0.6) 0%, rgba(245,158,11,0.2) 50%, transparent 100%)`,
        border: `2px solid ${AMBER}`,
        boxShadow: `0 0 30px rgba(245,158,11,0.4), 0 0 60px rgba(220,107,10,0.2)`,
      }} />
    </div>
  );
}

export default function Home() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setAuthed(verifyLocalToken());
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json() as { token?: string; expiresAt?: number; error?: string };

      if (!res.ok || !data.token) {
        setError(data.error || 'Invalid password');
        setLoading(false);
        return;
      }

      localStorage.setItem('jarvis-auth-token', JSON.stringify({
        token: data.token,
        expiresAt: data.expiresAt,
      }));
      setAuthed(true);
    } catch {
      setError('Connection error. Try again.');
    }
    setLoading(false);
  }

  // Loading state
  if (authed === null) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: BG,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: AMBER, boxShadow: `0 0 10px ${AMBER}`,
          animation: 'blink-red 0.8s ease-in-out infinite',
        }} />
      </div>
    );
  }

  // Authenticated
  if (authed) {
    return <OpsVisualizer transparent={false} />;
  }

  // Login screen
  return (
    <div style={{
      position: 'fixed', inset: 0, background: BG,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'JetBrains Mono', monospace",
      overflow: 'hidden',
    }}>
      {/* Background grid */}
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.3,
        backgroundImage: `
          linear-gradient(rgba(245,158,11,0.05) 1px, transparent 1px),
          linear-gradient(90deg, rgba(245,158,11,0.05) 1px, transparent 1px)
        `,
        backgroundSize: '64px 64px',
      }} />

      {/* Dimmed orb animation */}
      <OrbAnimation />

      {/* Login card */}
      <div style={{
        position: 'relative',
        zIndex: 10,
        marginTop: 80,
        background: 'rgba(20, 12, 0, 0.9)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 8,
        padding: '40px 48px',
        width: 360,
        boxShadow: '0 0 60px rgba(245,158,11,0.08), 0 0 120px rgba(220,107,10,0.04)',
        backdropFilter: 'blur(12px)',
      }}>
        {/* Corner brackets */}
        <div style={{
          position: 'absolute', top: 8, left: 8,
          width: 14, height: 14,
          borderTop: '2px solid rgba(245,158,11,0.5)',
          borderLeft: '2px solid rgba(245,158,11,0.5)',
        }} />
        <div style={{
          position: 'absolute', bottom: 8, right: 8,
          width: 14, height: 14,
          borderBottom: '2px solid rgba(245,158,11,0.5)',
          borderRight: '2px solid rgba(245,158,11,0.5)',
        }} />

        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            fontSize: 22, fontWeight: 700, color: AMBER,
            textShadow: `0 0 20px ${AMBER}, 0 0 40px rgba(220,107,10,0.5)`,
            letterSpacing: '0.2em',
            marginBottom: 6,
          }}>
            J.A.R.V.I.S.
          </div>
          <div style={{
            fontSize: 9, color: 'rgba(245,158,11,0.4)',
            letterSpacing: '0.25em',
          }}>
            EB OPS CENTER v4 · AUTHENTICATION REQUIRED
          </div>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 8, color: 'rgba(245,158,11,0.45)',
              letterSpacing: '0.2em', marginBottom: 8,
            }}>
              ACCESS CODE
            </div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              placeholder="••••••••"
              style={{
                width: '100%',
                background: 'rgba(0,0,0,0.4)',
                border: `1px solid ${error ? '#EF4444' : 'rgba(245,158,11,0.25)'}`,
                borderRadius: 4,
                padding: '10px 14px',
                color: AMBER,
                fontSize: 16,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.2em',
                outline: 'none',
                transition: 'border-color 0.2s',
              }}
              onFocus={e => (e.target.style.borderColor = 'rgba(245,158,11,0.6)')}
              onBlur={e => (e.target.style.borderColor = error ? '#EF4444' : 'rgba(245,158,11,0.25)')}
            />
          </div>

          {error && (
            <div style={{
              fontSize: 9, color: '#EF4444',
              letterSpacing: '0.15em',
              marginBottom: 12,
              textShadow: '0 0 6px rgba(239,68,68,0.5)',
            }}>
              ✗ {error.toUpperCase()}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: '100%',
              padding: '11px',
              background: loading ? 'rgba(245,158,11,0.1)' : 'rgba(245,158,11,0.12)',
              border: `1px solid rgba(245,158,11,${loading ? '0.2' : '0.4'})`,
              borderRadius: 4,
              color: loading ? 'rgba(245,158,11,0.4)' : AMBER,
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.2em',
              cursor: loading || !password ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {loading ? '◈ AUTHENTICATING...' : '▶ AUTHENTICATE'}
          </button>
        </form>

        <div style={{
          marginTop: 24,
          textAlign: 'center',
          fontSize: 8, color: 'rgba(245,158,11,0.2)',
          letterSpacing: '0.15em',
        }}>
          EVERYTHING BAGEL PARTNERS LLC
        </div>
      </div>

      <style>{`
        @keyframes orbRing {
          0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.5; }
          50% { transform: scale(1.05) rotate(180deg); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
