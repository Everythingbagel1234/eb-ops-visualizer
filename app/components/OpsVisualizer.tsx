'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { CronJob, CommEntry, SecurityData, StatusResponse } from '../api/status/route';
import type { SlackMessage } from '../api/slack/route';

/* ─── Constants ──────────────────────────────────────────────── */
const AMBER   = '#F59E0B';
const AMBER2  = '#DC6B0A';
const GOLD    = '#FCD34D';
const GREEN   = '#22C55E';
const RED     = '#EF4444';
const GRAY    = '#6B7280';
const BG      = '#050510';


const STATUS_COLORS: Record<string, string> = {
  ok: GREEN, error: RED, idle: GRAY, running: AMBER, unknown: GRAY,
};

const CRON_CATEGORIES = [
  'Data Connectors',
  'Core Agents',
  'Operations',
  'Monitoring',
  'Scheduled Reports',
] as const;

const CAT_COLORS: Record<string, string> = {
  'Data Connectors':  '#a78bfa',
  'Core Agents':      AMBER,
  'Operations':       GOLD,
  'Monitoring':       GREEN,
  'Scheduled Reports':'#60a5fa',
};

/* ─── Helpers ────────────────────────────────────────────────── */
function timeAgo(iso?: string): string {
  if (!iso) return '—';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0)          return 'just now';
    if (ms < 60_000)     return `${Math.floor(ms / 1_000)}s ago`;
    if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  } catch { return '—'; }
}

function isRecent(iso?: string): boolean {
  if (!iso) return false;
  try { return Date.now() - new Date(iso).getTime() < 20 * 60_000; }
  catch { return false; }
}

function militaryTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const date = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
    .toUpperCase().replace(',', '');
  return `${hh}:${mm}:${ss}Z · ${date}`;
}

function groupCrons(crons: CronJob[]): Record<string, CronJob[]> {
  const groups: Record<string, CronJob[]> = {};
  CRON_CATEGORIES.forEach(k => { groups[k] = []; });
  crons.forEach(job => {
    const cat = job.category || 'Monitoring';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(job);
  });
  return groups;
}

function freshnessColor(days: number): string {
  if (days <= 1)  return GREEN;
  if (days <= 3)  return AMBER;
  return RED;
}

/* ─── Particle system ────────────────────────────────────────── */
interface Particle {
  id: number;
  x: number; y: number;
  tx: number; ty: number;
  progress: number;
  speed: number;
  color: string;
  size: number;
  trail: Array<{ x: number; y: number }>;
}

let _pid = 0;

function spawnParticle(cx: number, cy: number, hasErrors: boolean): Particle {
  const r = Math.random();
  const color = hasErrors && r < 0.18 ? RED
    : r < 0.5  ? AMBER
    : r < 0.75 ? GOLD
    : GREEN;

  const angle    = Math.random() * Math.PI * 2;
  const dist     = 70 + Math.random() * 170;
  const fromCtr  = Math.random() > 0.45;

  return {
    id:       _pid++,
    x:        fromCtr ? cx : cx + Math.cos(angle) * (dist + 90),
    y:        fromCtr ? cy : cy + Math.sin(angle) * (dist + 90),
    tx:       fromCtr ? cx + Math.cos(angle) * dist : cx + Math.cos(angle) * 16,
    ty:       fromCtr ? cy + Math.sin(angle) * dist : cy + Math.sin(angle) * 16,
    progress: 0,
    speed:    0.006 + Math.random() * 0.012,
    color,
    size:     1.2 + Math.random() * 2.2,
    trail:    [],
  };
}

function tickParticles(ctx: CanvasRenderingContext2D, particles: Particle[]): Particle[] {
  const alive: Particle[] = [];
  for (const p of particles) {
    if (p.progress >= 1) continue;
    p.progress = Math.min(1, p.progress + p.speed);
    const ease = 1 - Math.pow(1 - p.progress, 2);
    const x = p.x + (p.tx - p.x) * ease;
    const y = p.y + (p.ty - p.y) * ease;

    p.trail.push({ x, y });
    if (p.trail.length > 10) p.trail.shift();

    const fade = p.progress > 0.72 ? 1 - (p.progress - 0.72) / 0.28 : 1;

    for (let i = 1; i < p.trail.length; i++) {
      ctx.globalAlpha = (i / p.trail.length) * 0.25 * fade;
      ctx.fillStyle   = p.color;
      ctx.beginPath();
      ctx.arc(p.trail[i].x, p.trail[i].y, p.size * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = fade;
    ctx.shadowBlur  = 8;
    ctx.shadowColor = p.color;
    ctx.fillStyle   = p.color;
    ctx.beginPath();
    ctx.arc(x, y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;

    alive.push(p);
  }
  return alive;
}

/* ─── Canvas: background ─────────────────────────────────────── */
function drawBg(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Warm center vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.65);
  g.addColorStop(0,   'rgba(40, 18, 0, 0.45)');
  g.addColorStop(0.5, 'rgba(18, 6, 0, 0.15)');
  g.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.028)';
  ctx.lineWidth   = 1;
  const step = 64;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

/* ─── Canvas: JARVIS Orb ─────────────────────────────────────── */
function drawOrb(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, minDim: number, t: number,
  crons: CronJob[], gwHealthy: boolean, sessions: number,
) {
  const orbR = minDim * 0.14;    // sphere radius
  const tickR = minDim * 0.32;   // outer cron tick ring

  // ── 1. Ambient glow behind orb ─────────────────────────
  const ambientGlow = ctx.createRadialGradient(cx, cy, orbR * 0.2, cx, cy, orbR * 4.5);
  ambientGlow.addColorStop(0,   'rgba(245, 158, 11, 0.22)');
  ambientGlow.addColorStop(0.3, 'rgba(180, 80, 0,  0.08)');
  ambientGlow.addColorStop(0.7, 'rgba(100, 40, 0,  0.03)');
  ambientGlow.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = ambientGlow;
  ctx.beginPath(); ctx.arc(cx, cy, orbR * 4.5, 0, Math.PI * 2); ctx.fill();

  // ── 2. Orbiting rings (drawn before sphere so sphere occludes inner parts) ──
  const pulse = 0.85 + Math.sin(t * 1.2) * 0.15;  // breathing pulse

  const rings = [
    { rx: orbR * 1.28, ry: orbR * 0.26, angle: t * 0.5,   color: `rgba(245,158,11,${0.55 * pulse})`,  lw: 1.5, nodes: 3 },
    { rx: orbR * 1.42, ry: orbR * 0.44, angle: -t * 0.32 + 1.0, color: `rgba(220,107,10,${0.42 * pulse})`, lw: 1.2, nodes: 4 },
    { rx: orbR * 1.55, ry: orbR * 0.60, angle:  t * 0.22 + 2.1,  color: `rgba(252,211,77,${0.28 * pulse})`, lw: 0.8, nodes: 2 },
    { rx: orbR * 1.70, ry: orbR * 0.30, angle: -t * 0.16 + 0.5,  color: `rgba(245,158,11,${0.16 * pulse})`, lw: 0.6, nodes: 2 },
  ];

  for (const ring of rings) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ring.angle);

    // Ring itself
    ctx.strokeStyle = ring.color;
    ctx.lineWidth   = ring.lw;
    ctx.shadowBlur  = 10;
    ctx.shadowColor = AMBER;
    ctx.beginPath();
    ctx.ellipse(0, 0, ring.rx, ring.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Bright accent arc (about 30° arc on the ring)
    ctx.strokeStyle = `rgba(252, 211, 77, ${0.7 * pulse})`;
    ctx.lineWidth   = ring.lw * 1.8;
    ctx.shadowBlur  = 14;
    ctx.shadowColor = GOLD;
    ctx.beginPath();
    ctx.ellipse(0, 0, ring.rx, ring.ry, 0, -0.25, 0.25);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Nodes traveling along ring
    for (let n = 0; n < ring.nodes; n++) {
      const theta = (n / ring.nodes) * Math.PI * 2 + t * 0.6;
      const px    = ring.rx * Math.cos(theta);
      const py    = ring.ry * Math.sin(theta);
      ctx.fillStyle  = GOLD;
      ctx.shadowBlur = 8;
      ctx.shadowColor = AMBER;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // ── 3. Sphere: outer halo ──────────────────────────────
  const halo = ctx.createRadialGradient(cx, cy, orbR * 0.75, cx, cy, orbR * 1.55);
  halo.addColorStop(0, `rgba(245, 158, 11, ${0.4 * pulse})`);
  halo.addColorStop(0.6, `rgba(180, 80, 0, ${0.12 * pulse})`);
  halo.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, orbR * 1.55, 0, Math.PI * 2); ctx.fill();

  // ── 4. Sphere: 3D fill ─────────────────────────────────
  // Offset the highlight toward upper-left for 3D illusion
  const hlX = cx - orbR * 0.28;
  const hlY = cy - orbR * 0.28;
  const sphereFill = ctx.createRadialGradient(hlX, hlY, orbR * 0.04, cx, cy, orbR);
  sphereFill.addColorStop(0,    `rgba(255, 240, 170, ${0.98 * pulse})`);
  sphereFill.addColorStop(0.18, `rgba(252, 211, 77,  ${0.92 * pulse})`);
  sphereFill.addColorStop(0.38, `rgba(245, 158, 11,  ${0.85 * pulse})`);
  sphereFill.addColorStop(0.62, `rgba(190, 85,  5,   ${0.75})`);
  sphereFill.addColorStop(0.82, `rgba(60,  18,  0,   0.85)`);
  sphereFill.addColorStop(1,    'rgba(5,   5,   16,  0.95)');
  ctx.fillStyle = sphereFill;
  ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.fill();

  // ── 5. Sphere: wireframe grid lines (subtle) ──────────
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.clip();

  ctx.strokeStyle = `rgba(245, 158, 11, 0.12)`;
  ctx.lineWidth   = 0.5;

  // Latitude-like ellipses
  for (let i = 1; i <= 3; i++) {
    const lat = (i / 4) * Math.PI / 2;
    const r   = orbR * Math.cos(lat);
    const oy  = orbR * Math.sin(lat);
    ctx.beginPath(); ctx.ellipse(cx, cy + oy, r, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy - oy, r, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // Meridian-like lines (rotating slowly)
  for (let i = 0; i < 5; i++) {
    const rot = (i / 5) * Math.PI + t * 0.04;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, orbR * 0.12, orbR, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // ── 6. Sphere: edge ring ──────────────────────────────
  ctx.strokeStyle = `rgba(245, 158, 11, ${0.6 + Math.sin(t * 1.4) * 0.25})`;
  ctx.lineWidth   = 2;
  ctx.shadowBlur  = 22;
  ctx.shadowColor = AMBER;
  ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur  = 0;

  // ── 7. Specular highlight + lens flare ────────────────
  const specX = cx - orbR * 0.28;
  const specY = cy - orbR * 0.28;

  // Main highlight
  const spec = ctx.createRadialGradient(specX, specY, 0, specX, specY, orbR * 0.35);
  spec.addColorStop(0,   `rgba(255, 248, 210, ${0.75 * pulse})`);
  spec.addColorStop(0.4, `rgba(255, 220, 130, ${0.35 * pulse})`);
  spec.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = spec;
  ctx.beginPath(); ctx.arc(specX, specY, orbR * 0.35, 0, Math.PI * 2); ctx.fill();

  // Cross flare
  const flareAlpha = 0.4 * pulse;
  const flareLen   = orbR * 0.22;
  ctx.strokeStyle  = `rgba(255, 248, 200, ${flareAlpha})`;
  ctx.lineWidth    = 0.8;
  ctx.beginPath(); ctx.moveTo(specX - flareLen, specY); ctx.lineTo(specX + flareLen, specY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(specX, specY - flareLen); ctx.lineTo(specX, specY + flareLen); ctx.stroke();

  // ── 8. Outer tick ring (cron statuses) ────────────────
  // CCW decorative arcs
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-t * 0.12);
  for (let i = 0; i < 8; i++) {
    const sa = (i / 8) * Math.PI * 2;
    const ea = ((i + 0.32) / 8) * Math.PI * 2;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.15)';
    ctx.lineWidth   = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, tickR + 18, sa, ea); ctx.stroke();
  }
  ctx.restore();

  // CW tick ring
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.075);

  ctx.strokeStyle = 'rgba(245, 158, 11, 0.07)';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.arc(0, 0, tickR, 0, Math.PI * 2); ctx.stroke();

  const numTicks = Math.max(crons.length, 8);
  for (let i = 0; i < numTicks; i++) {
    const angle = (i / numTicks) * Math.PI * 2 - Math.PI / 2;
    const job   = crons[i];
    const color = job ? (STATUS_COLORS[job.lastStatus || 'unknown'] ?? GRAY) : 'rgba(245,158,11,0.1)';
    const big   = !!job;

    ctx.strokeStyle = color;
    ctx.lineWidth   = big ? 2.2 : 0.5;
    ctx.shadowBlur  = big ? 7 : 0;
    ctx.shadowColor = color;
    const r1 = tickR - (big ? 12 : 4);
    const r2 = tickR + (big ? 8 : 3);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
    ctx.lineTo(Math.cos(angle) * r2, Math.sin(angle) * r2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // CCW inner dashed ring
  ctx.rotate(-t * 0.075);
  ctx.rotate(t * 0.038);
  ctx.setLineDash([5, 14]);
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.18)';
  ctx.lineWidth   = 0.8;
  ctx.beginPath(); ctx.arc(0, 0, tickR - 28, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();

  // ── 9. Labels below orb ───────────────────────────────
  const labelY = cy + orbR * 1.82;
  const fz = Math.max(12, minDim * 0.024);

  // "J.A.R.V.I.S."
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = `700 ${fz}px 'JetBrains Mono', monospace`;
  ctx.fillStyle    = AMBER;
  ctx.shadowBlur   = 18 * pulse;
  ctx.shadowColor  = AMBER;
  ctx.fillText('J.A.R.V.I.S.', cx, labelY);
  ctx.shadowBlur   = 0;

  // Gateway status
  const gwColor = gwHealthy ? GREEN : RED;
  ctx.font       = `500 ${Math.max(8, minDim * 0.015)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle  = gwColor;
  ctx.shadowBlur = 6;
  ctx.shadowColor = gwColor;
  ctx.fillText(`GW: ${gwHealthy ? 'ONLINE' : 'OFFLINE'}`, cx, labelY + fz * 1.4);
  ctx.shadowBlur = 0;

  // Session count
  ctx.font      = `400 ${Math.max(8, minDim * 0.013)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = `rgba(245, 158, 11, 0.65)`;
  ctx.fillText(`${sessions} SESSION${sessions !== 1 ? 'S' : ''}`, cx, labelY + fz * 2.7);
}

/* ─── Sub-components ──────────────────────────────────────────── */

interface LeftPanelProps {
  cronGroups: Record<string, CronJob[]>;
  totalCrons: number;
  errorCount: number;
  topOffset: number;
}

function LeftPanel({ cronGroups, totalCrons, errorCount, topOffset }: LeftPanelProps) {
  const okCount   = Object.values(cronGroups).flat().filter(c => c.lastStatus === 'ok').length;
  const idleCount = Object.values(cronGroups).flat().filter(c => c.lastStatus === 'idle').length;

  return (
    <div
      className="hud-panel panel-left"
      style={{
        left: 14, top: topOffset, width: 295,
        bottom: 58, display: 'flex', flexDirection: 'column',
      }}
    >
      <div className="panel-shimmer" />
      <div className="scan-line" />

      {/* Header */}
      <div style={{
        padding: '8px 14px 7px',
        borderBottom: '1px solid rgba(245,158,11,0.18)',
        display: 'flex', flexDirection: 'column', gap: 3,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            fontFamily: "'Inter', sans-serif",
            color: AMBER, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.2em',
            textShadow: `0 0 8px ${AMBER}`,
          }}>
            ACTIVE PROCESSES
          </span>
          <span style={{
            fontFamily: "'Inter', sans-serif",
            color: 'rgba(245,158,11,0.55)', fontSize: 8.5, letterSpacing: '0.12em',
          }}>
            {totalCrons} AGENTS
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 8.5 }}>
          <span style={{ color: GREEN }}>✓{okCount}</span>
          <span style={{ color: RED }}>✗{errorCount}</span>
          <span style={{ color: GRAY }}>◇{idleCount}</span>
        </div>
      </div>

      {/* Scrollable cron list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '3px 0' }}>
        {CRON_CATEGORIES.map(cat => {
          const jobs = cronGroups[cat] || [];
          if (jobs.length === 0) return null;
          const catColor = CAT_COLORS[cat] ?? AMBER;
          return (
            <div key={cat}>
              <div style={{
                padding: '5px 14px 3px',
                fontSize: 8, letterSpacing: '0.22em',
                color: catColor, opacity: 0.6,
                textTransform: 'uppercase',
                fontFamily: "'Inter', sans-serif",
                fontWeight: 700,
              }}>
                ── {cat} ({jobs.length}) ──
              </div>
              {jobs.map(job => {
                const recent = isRecent(job.lastRun);
                const sc     = STATUS_COLORS[job.lastStatus || 'unknown'] ?? GRAY;
                const displayTime = job.lastRunAgo && job.lastRunAgo !== '-'
                  ? job.lastRunAgo
                  : timeAgo(job.lastRun);
                return (
                  <div
                    key={job.id || job.name}
                    className={recent ? 'row-recent' : ''}
                    style={{
                      padding: '3px 14px 3px 12px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      borderLeft: recent ? `2px solid ${AMBER}` : '2px solid transparent',
                    }}
                  >
                    <div className={`dot dot-${job.lastStatus || 'unknown'}`} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 10, color: 'rgba(245,158,11,0.9)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        textShadow: recent ? `0 0 5px ${AMBER}` : 'none',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        {job.name}
                      </div>
                      <div style={{
                        fontSize: 8, color: 'rgba(245,158,11,0.35)',
                        marginTop: 1, fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        {displayTime || '—'}
                        {job.model && <span style={{ opacity: 0.6, marginLeft: 6 }}>
                          {job.model}
                        </span>}
                      </div>
                    </div>
                    <div style={{
                      fontSize: 8, color: sc, flexShrink: 0, fontWeight: 700,
                      textShadow: `0 0 4px ${sc}`,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}>
                      {(job.lastStatus || 'UNK').toUpperCase()}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {totalCrons === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'rgba(245,158,11,0.22)', fontSize: 10 }}>
            LOADING PROCESS DATA…
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Right Panel: Comms (LIVE SLACK) ───────────────────────── */
interface CommsPanelProps {
  messages: SlackMessage[];
  live: boolean;
}

function slackMsgColor(msg: SlackMessage): string {
  if (msg.isGabe)  return '#FCD34D';   // warm gold
  if (msg.isBot)   return '#F59E0B';   // amber (Jarvis / other bots)
  return '#2DD4BF';                    // teal (team members)
}

function channelBadgeColor(channel: string): string {
  if (channel === 'DM')        return '#FCD34D';
  if (channel === '#activity') return '#F59E0B';
  if (channel === '#feedback') return '#A78BFA';
  return '#6EE7B7'; // #internal
}

function CommsSection({ messages, live }: CommsPanelProps) {
  return (
    <div style={{ flex: '3 1 0', overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Section header with LIVE dot */}
      <div style={{
        padding: '7px 14px 5px', flexShrink: 0,
        borderBottom: '1px solid rgba(245,158,11,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span className="section-header">COMMUNICATIONS</span>
        {live && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              className="live-dot"
              style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: '#22C55E', boxShadow: '0 0 6px #22C55E',
                animation: 'livePulse 1.4s ease-in-out infinite',
              }}
            />
            <span style={{
              fontSize: 7.5, color: '#22C55E', letterSpacing: '0.15em',
              fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
            }}>LIVE</span>
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {messages.map((msg, i) => {
          const color  = slackMsgColor(msg);
          const badge  = channelBadgeColor(msg.channel);
          const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + '…' : msg.text;
          return (
            <div
              key={`${msg.timestamp}-${i}`}
              className="activity-row slack-slide-in"
              style={{
                padding: '5px 14px',
                borderLeft: `2px solid ${color}40`,
                marginBottom: 1,
                animationDelay: `${i * 0.04}s`,
              }}
            >
              {/* Top row: time · person → channel badge */}
              <div style={{
                fontSize: 8, color: 'rgba(245,158,11,0.38)', marginBottom: 2,
                fontFamily: "'JetBrains Mono', monospace",
                display: 'flex', gap: 5, alignItems: 'center',
              }}>
                <span>[{msg.time}]</span>
                <span style={{ color, fontWeight: 700 }}>{msg.person}</span>
                <span style={{ color: 'rgba(245,158,11,0.3)' }}>→</span>
                <span style={{
                  color: badge, fontWeight: 700,
                  background: `${badge}18`,
                  padding: '0 4px', borderRadius: 3,
                  fontSize: 7.5,
                }}
                >
                  {msg.channel}
                </span>
              </div>
              {/* Message preview */}
              <div style={{
                fontSize: 9.5, color: 'rgba(245,158,11,0.82)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {preview}
              </div>
            </div>
          );
        })}
        {messages.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: 'rgba(245,158,11,0.22)', fontSize: 9,
            fontFamily: "'JetBrains Mono', monospace" }}>
            {live ? 'NO RECENT MESSAGES…' : 'CONNECTING TO SLACK…'}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Right Panel: Security ──────────────────────────────────── */
interface SecuritySectionProps {
  security: SecurityData;
}

function SecuritySection({ security }: SecuritySectionProps) {
  const { gapStatuses, activeThreats, lastAudit, highItems } = security;

  const auditTime = (() => {
    try {
      const d = new Date(lastAudit);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    } catch { return '—'; }
  })();

  return (
    <div style={{ flex: '2 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="right-panel-divider" />

      {/* Section header */}
      <div style={{
        padding: '7px 14px 5px', flexShrink: 0,
        borderBottom: '1px solid rgba(245,158,11,0.1)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="section-header">SECURITY STATUS</span>
          <span style={{
            fontSize: 8, color: 'rgba(245,158,11,0.45)',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {auditTime}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 3, fontSize: 8,
          fontFamily: "'JetBrains Mono', monospace" }}>
          <span style={{
            color: activeThreats > 0 ? RED : GREEN,
            textShadow: `0 0 5px ${activeThreats > 0 ? RED : GREEN}`,
          }}>
            {activeThreats > 0 ? `⚠ ${activeThreats} CRITICAL` : '✓ NO CRITICAL'}
          </span>
          <span style={{ color: 'rgba(245,158,11,0.4)' }}>
            {gapStatuses.filter(g => g.status !== 'clean').length} FLAGS
          </span>
        </div>
      </div>

      {/* GAP badge grid */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '6px 12px',
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4,
        alignContent: 'start',
      }}>
        {gapStatuses.map(gap => (
          <div
            key={gap.gap}
            className={`gap-badge gap-badge-${gap.status}`}
            title={gap.note || ''}
          >
            <span>{gap.status === 'clean' ? '✓' : gap.status === 'critical' ? '✗' : '!'}</span>
            <span>G{gap.num}</span>
          </div>
        ))}
      </div>

      {/* HIGH severity items */}
      {highItems.length > 0 && (
        <div style={{
          padding: '4px 12px 8px', flexShrink: 0,
          borderTop: '1px solid rgba(245,158,11,0.1)',
        }}>
          {highItems.slice(0, 3).map((item, i) => (
            <div key={i} style={{
              fontSize: 8, color: 'rgba(245,158,11,0.65)', padding: '2px 0',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              ⚠ {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Right Panel (wrapper) ──────────────────────────────────── */
interface RightPanelProps {
  comms: CommEntry[];
  slackMessages: SlackMessage[];
  slackLive: boolean;
  security: SecurityData;
  topOffset: number;
}

function RightPanel({ slackMessages, slackLive, security, topOffset }: RightPanelProps) {
  return (
    <div
      className="hud-panel panel-right"
      style={{
        right: 14, top: topOffset, width: 295,
        bottom: 58, display: 'flex', flexDirection: 'column',
      }}
    >
      <div className="panel-shimmer" />
      <div className="scan-line" style={{ animationDelay: '-2.1s' }} />
      <CommsSection messages={slackMessages} live={slackLive} />
      <SecuritySection security={security} />
    </div>
  );
}

/* ─── Bottom HUD ──────────────────────────────────────────────── */
interface BottomStripProps {
  status: StatusResponse | null;
  now: Date;
}

function BottomStrip({ status, now }: BottomStripProps) {
  const total    = status?.crons.length ?? 0;
  const active   = status?.sessions.active ?? 0;
  const errors   = status?.errors ?? 0;
  const okCount  = status?.crons.filter(c => c.lastStatus === 'ok').length ?? 0;
  const gwOk     = status?.gateway.healthy ?? false;
  const freshness = status?.dataFreshness ?? [];

  const tickerText = `  ◆ J.A.R.V.I.S. OPS CENTER  ●  CRONS: ${total}  ●  OK: ${okCount}  ●  ERRORS: ${errors}  ●  SESSIONS: ${active}  ●  GATEWAY: ${gwOk ? 'ONLINE' : 'OFFLINE'}  ●  EB INTELLIGENCE INFRASTRUCTURE  ●  `.repeat(5);

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, height: 52, zIndex: 15,
      background: 'rgba(14, 6, 0, 0.88)',
      borderTop: '1px solid rgba(245,158,11,0.22)',
      display: 'flex', alignItems: 'stretch',
      backdropFilter: 'blur(10px)',
    }}>
      {/* Left: metrics ticker */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <div className="ticker-track" style={{
          fontSize: 9,
          color: errors > 0 ? AMBER : 'rgba(245,158,11,0.55)',
          letterSpacing: '0.12em',
          textShadow: errors > 0 ? `0 0 8px ${AMBER}` : `0 0 5px rgba(245,158,11,0.4)`,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          <span>{tickerText}</span>
          <span aria-hidden>{tickerText}</span>
        </div>
      </div>

      {/* Center: military clock */}
      <div style={{
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 22px',
        borderLeft:  '1px solid rgba(245,158,11,0.15)',
        borderRight: '1px solid rgba(245,158,11,0.15)',
      }}>
        <span style={{
          fontSize: 13, fontWeight: 700, letterSpacing: '0.1em', color: AMBER,
          textShadow: `0 0 10px ${AMBER}, 0 0 22px ${AMBER2}`,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {militaryTime(now)}
        </span>
      </div>

      {/* Right: BI freshness cards */}
      <div style={{
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        padding: '0 14px', gap: 3,
      }}>
        <div style={{
          fontSize: 7, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.2em',
          textAlign: 'right', marginBottom: 2,
          fontFamily: "'Inter', sans-serif", fontWeight: 700,
        }}>
          DATA FRESHNESS
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {freshness.map(({ abbrev, daysStale }) => {
            const color = freshnessColor(daysStale);
            const label = daysStale < 1
              ? `${Math.round(daysStale * 24)}h`
              : `${Math.round(daysStale)}d`;
            return (
              <div key={abbrev} className="freshness-card" style={{ borderColor: `${color}30` }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: color, boxShadow: `0 0 5px ${color}`,
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 6.5, color: 'rgba(245,158,11,0.7)', letterSpacing: '0.05em',
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {abbrev}
                </span>
                <span style={{
                  fontSize: 7, color, fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Alert Bar ───────────────────────────────────────────────── */
interface AlertBarProps {
  errorCount: number;
  errorJobs: CronJob[];
  security: SecurityData | null;
}

function AlertBar({ errorCount, errorJobs, security }: AlertBarProps) {
  const secFlags = security ? security.gapStatuses.filter(g => g.status !== 'clean').length : 0;
  const hasCronErrors  = errorCount > 0;
  const hasSecFlags    = secFlags > 0;

  if (!hasCronErrors && !hasSecFlags) return null;

  const cronNames = errorJobs.map(j => j.name).join('  ●  ');
  const cronTicker = `  ⚠ ${errorCount} CRON ERROR${errorCount > 1 ? 'S' : ''}:  ${cronNames}  `.repeat(4);

  return (
    <div
      className="alert-bar-pulse"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 44, zIndex: 20,
        background: 'rgba(245,158,11,0.1)',
        borderBottom: '1px solid rgba(245,158,11,0.4)',
        display: 'flex', alignItems: 'center',
      }}
    >
      {/* Left: cron errors scrolling */}
      {hasCronErrors && (
        <div style={{
          flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center',
          padding: '0 16px', gap: 10, minWidth: 0,
        }}>
          <span style={{ fontSize: 14, color: AMBER, flexShrink: 0 }}>⚠</span>
          <div style={{ overflow: 'hidden', flex: 1, minWidth: 0 }}>
            <div className="alert-ticker" style={{
              fontSize: 9.5, color: AMBER, letterSpacing: '0.12em',
              textShadow: `0 0 8px ${AMBER}`,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              <span>{cronTicker}</span>
              <span aria-hidden>{cronTicker}</span>
            </div>
          </div>
        </div>
      )}

      {/* Right: security flags */}
      {hasSecFlags && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 20px',
          borderLeft: hasCronErrors ? '1px solid rgba(245,158,11,0.2)' : 'none',
        }}>
          <span style={{ fontSize: 13 }}>🔒</span>
          <span style={{
            fontSize: 9.5, color: RED, letterSpacing: '0.12em',
            textShadow: `0 0 8px ${RED}`,
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
          }}>
            {secFlags} SECURITY FLAG{secFlags > 1 ? 'S' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────────────── */
export default function OpsVisualizer({ transparent }: { transparent: boolean }) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const statusRef    = useRef<StatusResponse | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animRef      = useRef<number>(0);
  const tRef         = useRef(0);

  const [status, setStatus]           = useState<StatusResponse | null>(null);
  const [now, setNow]                  = useState<Date>(new Date());
  const [slackMessages, setSlackMsgs] = useState<SlackMessage[]>([]);
  const [slackLive, setSlackLive]     = useState(false);

  /* Clock */
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  /* Data fetch */
  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/status', { cache: 'no-store' });
      const data = await res.json() as StatusResponse;
      statusRef.current = data;
      setStatus(data);
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 10_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  /* Slack live feed — 15s poll */
  const fetchSlack = useCallback(async () => {
    try {
      const res  = await fetch('/api/slack', { cache: 'no-store' });
      const data = await res.json() as { messages: SlackMessage[] };
      if (Array.isArray(data.messages)) {
        setSlackMsgs(data.messages);
        setSlackLive(true);
      }
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    fetchSlack();
    const id = setInterval(fetchSlack, 15_000);
    return () => clearInterval(id);
  }, [fetchSlack]);

  /* Render loop */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    function loop() {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;

      if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
        c.width  = window.innerWidth;
        c.height = window.innerHeight;
      }

      tRef.current += 0.016;
      const t      = tRef.current;
      const w      = c.width;
      const h      = c.height;
      const cx     = w / 2;
      const cy     = h / 2;
      const minDim = Math.min(w, h);
      const s      = statusRef.current;
      const hasErrors = (s?.errors ?? 0) > 0;

      if (!transparent) drawBg(ctx, w, h);
      else ctx.clearRect(0, 0, w, h);

      drawGrid(ctx, w, h);
      drawOrb(ctx, cx, cy, minDim, t,
        s?.crons ?? [], s?.gateway.healthy ?? false, s?.sessions.active ?? 0);

      // Particles
      if (s && Math.random() < 0.06 && particlesRef.current.length < 80) {
        particlesRef.current.push(spawnParticle(cx, cy, hasErrors));
      }
      particlesRef.current = tickParticles(ctx, particlesRef.current);

      animRef.current = requestAnimationFrame(loop);
    }

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [transparent]);

  /* Tooltip */
  const [tooltip, setTooltip] = useState<{ x: number; y: number; job: CronJob } | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !statusRef.current) { setTooltip(null); return; }
    const rect   = canvas.getBoundingClientRect();
    const mx     = e.clientX - rect.left;
    const my     = e.clientY - rect.top;
    const cx     = canvas.width / 2;
    const cy     = canvas.height / 2;
    const minDim = Math.min(canvas.width, canvas.height);
    const tickR  = minDim * 0.32;
    const crons  = statusRef.current.crons;
    const numT   = Math.max(crons.length, 8);
    const rot    = tRef.current * 0.075 - Math.PI / 2;

    let hit: CronJob | null = null;
    for (let i = 0; i < crons.length; i++) {
      const angle = rot + (i / numT) * Math.PI * 2;
      const tx    = cx + Math.cos(angle) * tickR;
      const ty    = cy + Math.sin(angle) * tickR;
      const dx    = mx - tx;
      const dy    = my - ty;
      if (Math.sqrt(dx * dx + dy * dy) < 14) { hit = crons[i]; break; }
    }
    if (hit) setTooltip({ x: e.clientX, y: e.clientY, job: hit });
    else     setTooltip(null);
  }, []);

  /* Derived state */
  const cronGroups  = status ? groupCrons(status.crons) : {};
  const totalCrons  = status?.crons.length ?? 0;
  const errorCount  = status?.errors ?? 0;
  const errorJobs   = status?.crons.filter(c => c.lastStatus === 'error') ?? [];
  const comms       = status?.recentComms ?? [];
  void comms; // kept for type compatibility; live feed is preferred
  const security    = status?.security ?? null;
  const hasAlert    = errorCount > 0 || (security?.gapStatuses.some(g => g.status !== 'clean') ?? false);
  const topOffset   = hasAlert ? 50 : 8;

  return (
    <div
      className="scanlines"
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        fontFamily: "'JetBrains Mono', monospace",
        background: transparent ? 'transparent' : BG,
      }}
    >
      {/* Canvas — full screen, center orb + particles */}
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'block' }}
      />

      {/* Alert bar */}
      <AlertBar
        errorCount={errorCount}
        errorJobs={errorJobs}
        security={security}
      />

      {/* Left panel — all crons */}
      <LeftPanel
        cronGroups={cronGroups}
        totalCrons={totalCrons}
        errorCount={errorCount}
        topOffset={topOffset}
      />

      {/* Right panel — comms + security */}
      <RightPanel
        comms={comms}
        slackMessages={slackMessages}
        slackLive={slackLive}
        security={security ?? {
          gapStatuses: [],
          activeThreats: 0,
          lastAudit: '',
          highItems: [],
        }}
        topOffset={topOffset}
      />

      {/* Bottom HUD */}
      <BottomStrip status={status} now={now} />

      {/* Hover tooltip */}
      {tooltip && (() => {
        const sc = STATUS_COLORS[tooltip.job.lastStatus || 'unknown'] ?? GRAY;
        const displayTime = tooltip.job.lastRunAgo && tooltip.job.lastRunAgo !== '-'
          ? tooltip.job.lastRunAgo
          : timeAgo(tooltip.job.lastRun);
        return (
          <div style={{
            position: 'fixed',
            left: tooltip.x + 14,
            top:  tooltip.y - 10,
            background: 'rgba(14, 6, 0, 0.97)',
            border: `1px solid ${sc}`,
            borderRadius: 4,
            padding: '8px 12px',
            pointerEvents: 'none',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10.5,
            color: AMBER,
            zIndex: 100,
            minWidth: 200,
            boxShadow: `0 0 20px rgba(245,158,11,0.18)`,
          }}>
            <div style={{
              fontWeight: 700, marginBottom: 5, color: sc,
              textShadow: `0 0 8px ${sc}`,
            }}>
              {tooltip.job.name}
            </div>
            <div style={{ color: 'rgba(245,158,11,0.5)', fontSize: 9.5, lineHeight: 1.7 }}>
              <div>Category: {tooltip.job.category || 'Unknown'}</div>
              <div>Status: <span style={{ color: sc, fontWeight: 700 }}>
                {(tooltip.job.lastStatus || 'unknown').toUpperCase()}
              </span></div>
              {tooltip.job.schedule && <div>Schedule: {tooltip.job.schedule.slice(0, 30)}</div>}
              {tooltip.job.model    && <div>Model: {tooltip.job.model}</div>}
              <div>Last run: {displayTime}</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
