'use client';

import type { SlackMessage } from '../api/slack/route';

/* ─── Types ─────────────────────────────────────────────────── */
interface GmailData {
  unreadCount?: number;
  threads?: unknown[];
}

interface InteractionGraphProps {
  slack: SlackMessage[];
  gmail: GmailData | null;
  asana: unknown[] | null;
  sessions: unknown[];
}

/* ─── Node config ────────────────────────────────────────────── */
const AMBER  = '#F59E0B';
const CYAN   = '#22D3EE';
const GREEN  = '#22C55E';
const PURPLE = '#A78BFA';
const BLUE   = '#60A5FA';
const BG     = 'rgba(14,6,0,0.92)';

interface NodeDef {
  id: string;
  label: string;
  sublabel?: string;
  color: string;
  angle: number; // degrees from top (0 = top, 90 = right)
  radius: number;
}

const NODES: NodeDef[] = [
  { id: 'slack',   label: 'SLACK',   color: AMBER,  angle: -90,  radius: 78 },
  { id: 'gmail',   label: 'GMAIL',   color: BLUE,   angle: -18,  radius: 78 },
  { id: 'asana',   label: 'ASANA',   color: PURPLE, angle:  54,  radius: 78 },
  { id: 'webchat', label: 'WEBCHAT', color: CYAN,   angle: 126,  radius: 78 },
  { id: 'cron',    label: 'CRON',    color: GREEN,  angle: 198,  radius: 78 },
];

function toRad(deg: number) { return (deg * Math.PI) / 180; }

function nodePos(node: NodeDef, cx: number, cy: number) {
  return {
    x: cx + node.radius * Math.cos(toRad(node.angle)),
    y: cy + node.radius * Math.sin(toRad(node.angle)),
  };
}

export default function InteractionGraph({ slack, gmail, asana, sessions }: InteractionGraphProps) {
  const cx = 110;
  const cy = 110;
  const size = 220;

  // Compute activity counts per node
  const counts: Record<string, number> = {
    slack:   slack.length,
    gmail:   gmail?.unreadCount ?? (gmail?.threads?.length ?? 0),
    asana:   Array.isArray(asana) ? asana.length : 0,
    webchat: sessions.length,
    cron:    0,
  };

  // Recency for pulse animation: is there activity in last 15 min?
  const slackRecent = slack.some(m => Date.now() - m.timestamp * 1000 < 15 * 60_000);
  const recentMap: Record<string, boolean> = {
    slack:   slackRecent,
    gmail:   (gmail?.unreadCount ?? 0) > 0,
    asana:   counts.asana > 0,
    webchat: sessions.length > 0,
    cron:    false,
  };

  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
      {/* SVG layer: lines */}
      <svg
        width={size}
        height={size}
        style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
      >
        <defs>
          {NODES.map(node => {
            const pos = nodePos(node, cx, cy);
            const isRecent = recentMap[node.id];
            const pathLen = Math.hypot(pos.x - cx, pos.y - cy);
            return (
              <style key={`style-${node.id}`}>{`
                @keyframes pulse-${node.id} {
                  0%   { stroke-dashoffset: ${pathLen * 2}; opacity: 0.3; }
                  50%  { opacity: 1; }
                  100% { stroke-dashoffset: 0; opacity: 0.3; }
                }
                .line-${node.id} {
                  stroke-dasharray: ${isRecent ? `${pathLen * 0.15} ${pathLen * 0.1}` : `${pathLen * 0.08} ${pathLen * 0.12}`};
                  stroke-dashoffset: 0;
                  animation: ${isRecent ? `pulse-${node.id} 1.8s linear infinite` : `pulse-${node.id} 3.5s linear infinite`};
                }
              `}</style>
            );
          })}
        </defs>

        {NODES.map(node => {
          const pos = nodePos(node, cx, cy);
          const alpha = counts[node.id] > 0 ? 0.7 : 0.25;
          return (
            <line
              key={`line-${node.id}`}
              className={`line-${node.id}`}
              x1={cx}
              y1={cy}
              x2={pos.x}
              y2={pos.y}
              stroke={node.color}
              strokeOpacity={alpha}
              strokeWidth={recentMap[node.id] ? 1.5 : 0.8}
            />
          );
        })}
      </svg>

      {/* Center node: JARVIS */}
      <div style={{
        position: 'absolute',
        left: cx - 26,
        top:  cy - 26,
        width: 52,
        height: 52,
        borderRadius: '50%',
        background: `radial-gradient(circle at 35% 35%, rgba(252,211,77,0.95), rgba(245,158,11,0.85) 50%, rgba(120,50,0,0.8))`,
        border: `1.5px solid ${AMBER}`,
        boxShadow: `0 0 18px rgba(245,158,11,0.45), inset 0 0 10px rgba(0,0,0,0.3)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2,
      }}>
        <span style={{
          fontSize: 7,
          fontWeight: 800,
          color: '#0D0D0D',
          letterSpacing: '0.1em',
          fontFamily: "'JetBrains Mono', monospace",
          lineHeight: 1.2,
          textAlign: 'center',
        }}>
          J.A.R.V.I.S
        </span>
      </div>

      {/* Outer nodes */}
      {NODES.map(node => {
        const pos  = nodePos(node, cx, cy);
        const cnt  = counts[node.id];
        const isRc = recentMap[node.id];
        const r    = 20;

        return (
          <div
            key={node.id}
            style={{
              position: 'absolute',
              left: pos.x - r,
              top:  pos.y - r,
              width:  r * 2,
              height: r * 2,
              borderRadius: '50%',
              background: BG,
              border: `1.5px solid ${isRc ? node.color : `${node.color}55`}`,
              boxShadow: isRc ? `0 0 10px ${node.color}55` : 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2,
              animation: isRc ? 'pulse-amber 1.8s ease-in-out infinite' : 'none',
            }}
          >
            <span style={{
              fontSize: 6.5,
              fontWeight: 700,
              color: node.color,
              letterSpacing: '0.06em',
              fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1.1,
            }}>
              {node.label}
            </span>
            {cnt > 0 && (
              <span style={{
                fontSize: 8,
                fontWeight: 700,
                color: '#fff',
                background: node.color,
                borderRadius: 6,
                padding: '0 3px',
                marginTop: 1,
                lineHeight: 1.3,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {cnt > 99 ? '99+' : cnt}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
