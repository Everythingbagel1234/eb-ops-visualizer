'use client';

import { useMemo } from 'react';

const AMBER = '#F59E0B';
const GREEN = '#22C55E';
const RED   = '#EF4444';
const GRAY  = '#6B7280';
const CYAN  = '#22D3EE';

interface Session {
  key?: string;
  kind?: string;
  channel?: string;
  displayName?: string;
  model?: string;
  status?: string;
  updatedAt?: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
  label?: string;
  childSessions?: unknown[];
  runtimeMs?: number;
}

function formatRuntime(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins  = Math.floor((totalSecs % 3600) / 60);
  const secs  = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0)  return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatCost(usd?: number): string {
  if (!usd || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function channelIcon(channel?: string): string {
  const ch = (channel || '').toLowerCase();
  if (ch.includes('slack'))                     return '◈';
  if (ch.includes('cron') || ch.includes('scheduled')) return '⏱';
  return '◎';
}

function statusColor(status?: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'running' || s === 'active')  return GREEN;
  if (s === 'error'   || s === 'failed')  return RED;
  if (s === 'done'    || s === 'completed') return AMBER;
  return GRAY;
}

export default function ActiveWork({ sessions }: { sessions: Array<unknown> }) {
  const parsed = useMemo<Session[]>(() => {
    if (!Array.isArray(sessions)) return [];
    return sessions
      .map((s): Session => {
        if (typeof s === 'string') return { key: s, displayName: s, status: 'running' };
        if (s && typeof s === 'object') return s as Session;
        return {};
      })
      .filter(s => s.key || s.displayName || s.label);
  }, [sessions]);

  return (
    <div>
      {/* Header */}
      <div style={{
        padding: '5px 14px 4px',
        borderBottom: '1px solid rgba(245,158,11,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: parsed.length > 0 ? GREEN : GRAY,
            boxShadow: parsed.length > 0 ? `0 0 6px ${GREEN}` : 'none',
            animation: parsed.length > 0 ? 'aw-pulse 1.4s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }} />
          <span style={{
            fontSize: 8.5, color: AMBER, letterSpacing: '0.2em', fontWeight: 700,
            fontFamily: "'Inter', sans-serif",
          }}>
            ⚡ ACTIVE WORK
          </span>
        </div>
        <span style={{
          fontSize: 7.5, color: 'rgba(245,158,11,0.4)',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {parsed.length} TASK{parsed.length !== 1 ? 'S' : ''}
        </span>
      </div>

      {/* Session list */}
      <div style={{ padding: '2px 0' }}>
        {parsed.length === 0 ? (
          <div style={{
            padding: '8px 14px',
            fontSize: 9, color: 'rgba(245,158,11,0.22)',
            fontFamily: "'JetBrains Mono', monospace",
            textAlign: 'center',
          }}>
            All clear — no active tasks
          </div>
        ) : (
          parsed.map((session, i) => {
            const name = session.displayName || session.label || session.key || 'Session';
            const sc   = statusColor(session.status);
            const ch   = channelIcon(session.channel);
            const channelLabel = session.channel
              ? session.channel.charAt(0).toUpperCase() + session.channel.slice(1).toLowerCase()
              : 'Task';

            return (
              <div
                key={session.key || i}
                style={{
                  padding: '4px 14px 4px 12px',
                  borderLeft: `2px solid ${sc}50`,
                  marginBottom: 1,
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
              >
                {/* Row 1: status dot + name */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: sc,
                    boxShadow: sc === GREEN ? `0 0 5px ${sc}` : 'none',
                    flexShrink: 0,
                    animation: sc === GREEN ? 'aw-pulse 1.4s ease-in-out infinite' : 'none',
                  }} />
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, color: AMBER,
                    fontFamily: "'JetBrains Mono', monospace",
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    textShadow: `0 0 5px ${AMBER}40`,
                    flex: 1,
                  }}>
                    {name}
                  </span>
                </div>

                {/* Row 2: channel badge, model, runtime, cost, sub-agents */}
                <div style={{
                  display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                  fontSize: 7.5, color: 'rgba(245,158,11,0.4)',
                  fontFamily: "'JetBrains Mono', monospace",
                  paddingLeft: 10,
                }}>
                  {session.channel && (
                    <span style={{
                      background: 'rgba(245,158,11,0.1)',
                      border: '1px solid rgba(245,158,11,0.2)',
                      borderRadius: 3, padding: '0 4px', fontSize: 7,
                      color: 'rgba(245,158,11,0.7)',
                    }}>
                      {ch} {channelLabel}
                    </span>
                  )}
                  {session.model && (
                    <span style={{ color: 'rgba(245,158,11,0.35)', fontSize: 7 }}>
                      {session.model.replace('claude-', '').replace('-latest', '')}
                    </span>
                  )}
                  {!!session.runtimeMs && session.runtimeMs > 0 && (
                    <span style={{ color: CYAN, fontSize: 7 }}>
                      ⏱ {formatRuntime(session.runtimeMs)}
                    </span>
                  )}
                  {!!session.estimatedCostUsd && session.estimatedCostUsd > 0 && (
                    <span style={{ color: AMBER, fontSize: 7 }}>
                      {formatCost(session.estimatedCostUsd)}
                    </span>
                  )}
                  {!!session.childSessions?.length && (
                    <span style={{ color: 'rgba(34,211,238,0.6)', fontSize: 7 }}>
                      ↳ {session.childSessions.length} sub-agent{session.childSessions.length > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <style>{`
        @keyframes aw-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}
