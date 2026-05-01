'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import type { CronJob, CommEntry, SecurityData, StatusResponse } from '../api/status/route';
import type { SlackMessage } from '../api/slack/route';
import type { OpsUsageData } from '../api/ops-usage/route';
import type { GmailThread } from './GmailPanel';
import VoiceInterface, { type VoiceState } from './VoiceInterface';
// import ConvAIVoice from './ConvAIVoice'; // fallback: ElevenLabs bridge
import VapiVoice from './VapiVoice';

const UsageChart = dynamic(() => import('./UsageChart'), { ssr: false });
const InteractionGraph = dynamic(() => import('./InteractionGraph'), { ssr: false });
const TokenBurnRate    = dynamic(() => import('./TokenBurnRate'),    { ssr: false });
const GmailPanel       = dynamic(() => import('./GmailPanel'),       { ssr: false });
const ChannelHeatmap   = dynamic(() => import('./ChannelHeatmap'),   { ssr: false });

/* ─── Constants ──────────────────────────────────────────────── */
const AMBER   = '#F59E0B';
const AMBER2  = '#DC6B0A';
const GOLD    = '#FCD34D';
const GREEN   = '#22C55E';
const RED     = '#EF4444';
const GRAY    = '#6B7280';
const BG      = '#050510';
const CYAN    = '#22D3EE';

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

/* ─── Team Members ───────────────────────────────────────────── */
interface TeamMember {
  name: string;
  shortName: string;
  role: string;
  roleAbbrev: string;
  color: string;
  slackNames?: string[]; // partial matches for slack/CC detection
}

const TEAM_MEMBERS: TeamMember[] = [
  { name: 'Gabe Wolff',          shortName: 'Gabe',    role: 'CEO',                roleAbbrev: 'CEO',   color: '#FCD34D', slackNames: ['gabe', 'gabriel'] },
  { name: 'Amanda Berkowitz',    shortName: 'Amanda',  role: 'COO',                roleAbbrev: 'COO',   color: '#A78BFA', slackNames: ['amanda', 'berkowitz'] },
  { name: 'Jylle Ryan',          shortName: 'Jylle',   role: 'VP Lifecycle',       roleAbbrev: 'VP-LC', color: '#2DD4BF', slackNames: ['jylle', 'ryan'] },
  { name: 'John Henry Tardiff',  shortName: 'JH',      role: 'Sr. Perf Strategist',roleAbbrev: 'SPS',   color: '#60A5FA', slackNames: ['john', 'tardiff', 'john henry'] },
  { name: 'Jeff Laine',          shortName: 'Jeff',    role: 'Creative Director',  roleAbbrev: 'CD',    color: '#4ADE80', slackNames: ['jeff', 'laine'] },
  { name: 'Omar Madi',           shortName: 'Omar',    role: 'Developer',          roleAbbrev: 'DEV',   color: CYAN,      slackNames: ['omar', 'madi'] },
  { name: 'Ed Celesios',         shortName: 'Ed',      role: 'TikTok Lead',        roleAbbrev: 'TTK',   color: '#FB923C', slackNames: ['ed', 'celesios', 'edward'] },
  { name: 'Janelle Alfonso',     shortName: 'Janelle', role: 'Design Lead',        roleAbbrev: 'DSN',   color: '#F472B6', slackNames: ['janelle', 'alfonso'] },
  { name: 'Ronny Rincon',        shortName: 'Ronny',   role: 'Strategist',         roleAbbrev: 'STR',   color: '#A3E635', slackNames: ['ronny', 'rincon'] },
  { name: 'Daniel Mahu',         shortName: 'Daniel',  role: 'Email Specialist',   roleAbbrev: 'EML',   color: '#818CF8', slackNames: ['daniel', 'mahu'] },
];

/* ─── Types ──────────────────────────────────────────────────── */
interface CCEntry {
  id: number;
  agent_name?: string;
  action_type?: string;
  client_tag?: string | null;
  input_summary?: string;
  output_summary?: string;
  status?: string;
  created_at: string;
  actor_email?: string | null;
  actor_name?: string | null;
  source: 'slack' | 'cc';
  text: string;
  person: string;
  time: string;
  timestamp: number;
}

interface TeamActivity {
  member: TeamMember;
  lastSeenAt: number | null; // unix ms
  source: 'slack' | 'cc' | 'both' | null;
}

interface DrawerContent {
  type: 'cron' | 'team' | 'feed';
  title: string;
  data: unknown;
}

interface InteractionsData {
  slack?: SlackMessage[];
  gmail?: { unreadCount?: number; threads?: GmailThread[] };
  asana?: unknown[];
  sessions?: unknown[];
}

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

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return '—'; }
}

/* ─── Team activity detection ────────────────────────────────── */
function buildTeamActivity(slackMessages: SlackMessage[], ccEntries: CCEntry[]): TeamActivity[] {
  return TEAM_MEMBERS.map(member => {
    let lastSeenAt: number | null = null;
    let foundSlack = false;
    let foundCC = false;

    const nameLower = member.slackNames || [member.shortName.toLowerCase()];

    // Check Slack messages
    for (const msg of slackMessages) {
      const personLower = msg.person.toLowerCase();
      if (nameLower.some(n => personLower.includes(n))) {
        const ts = msg.timestamp * 1000;
        if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts;
        foundSlack = true;
      }
    }

    // Check CC entries
    for (const entry of ccEntries) {
      const actorName = (entry.actor_name || '').toLowerCase();
      const actorEmail = (entry.actor_email || '').toLowerCase();
      if (nameLower.some(n => actorName.includes(n) || actorEmail.includes(n))) {
        const ts = new Date(entry.created_at).getTime();
        if (!lastSeenAt || ts > lastSeenAt) lastSeenAt = ts;
        foundCC = true;
      }
    }

    const source: TeamActivity['source'] = foundSlack && foundCC ? 'both'
      : foundSlack ? 'slack'
      : foundCC ? 'cc'
      : null;

    return { member, lastSeenAt, source };
  });
}

function teamActivityStatus(activity: TeamActivity): 'active' | 'recent' | 'inactive' {
  if (!activity.lastSeenAt) return 'inactive';
  const minsAgo = (Date.now() - activity.lastSeenAt) / 60_000;
  if (minsAgo < 30) return 'active';
  if (minsAgo < 240) return 'recent';
  return 'inactive';
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
  voiceState: VoiceState, version?: string,
) {
  const orbR = minDim * 0.14;
  const tickR = minDim * 0.32;

  // Voice state modifiers
  const voiceSpeedMult = voiceState === 'listening' ? 3 : voiceState === 'processing' ? 2 : 1;
  const voiceGlowMult = voiceState !== 'idle' ? 2 : 1;

  // Ambient glow
  const ambientGlow = ctx.createRadialGradient(cx, cy, orbR * 0.2, cx, cy, orbR * 4.5);
  const glowAlpha = voiceState !== 'idle' ? 0.35 : 0.22;
  ambientGlow.addColorStop(0,   `rgba(245, 158, 11, ${glowAlpha})`);
  ambientGlow.addColorStop(0.3, 'rgba(180, 80, 0, 0.08)');
  ambientGlow.addColorStop(0.7, 'rgba(100, 40, 0, 0.03)');
  ambientGlow.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = ambientGlow;
  ctx.beginPath(); ctx.arc(cx, cy, orbR * 4.5, 0, Math.PI * 2); ctx.fill();

  const pulse = 0.85 + Math.sin(t * 1.2 * voiceSpeedMult) * 0.15;

  const rings = [
    { rx: orbR * 1.28, ry: orbR * 0.26, angle: t * 0.5 * voiceSpeedMult,   color: `rgba(245,158,11,${0.55 * pulse * voiceGlowMult})`,  lw: 1.5, nodes: 3 },
    { rx: orbR * 1.42, ry: orbR * 0.44, angle: -t * 0.32 * voiceSpeedMult + 1.0, color: `rgba(220,107,10,${0.42 * pulse * voiceGlowMult})`, lw: 1.2, nodes: 4 },
    { rx: orbR * 1.55, ry: orbR * 0.60, angle:  t * 0.22 * voiceSpeedMult + 2.1, color: `rgba(252,211,77,${0.28 * pulse * voiceGlowMult})`, lw: 0.8, nodes: 2 },
    { rx: orbR * 1.70, ry: orbR * 0.30, angle: -t * 0.16 * voiceSpeedMult + 0.5, color: `rgba(245,158,11,${0.16 * pulse * voiceGlowMult})`, lw: 0.6, nodes: 2 },
  ];

  for (const ring of rings) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ring.angle);

    ctx.strokeStyle = ring.color;
    ctx.lineWidth   = ring.lw;
    ctx.shadowBlur  = 10;
    ctx.shadowColor = AMBER;
    ctx.beginPath();
    ctx.ellipse(0, 0, ring.rx, ring.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = `rgba(252, 211, 77, ${0.7 * pulse})`;
    ctx.lineWidth   = ring.lw * 1.8;
    ctx.shadowBlur  = 14;
    ctx.shadowColor = GOLD;
    ctx.beginPath();
    ctx.ellipse(0, 0, ring.rx, ring.ry, 0, -0.25, 0.25);
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (let n = 0; n < ring.nodes; n++) {
      const theta = (n / ring.nodes) * Math.PI * 2 + t * 0.6 * voiceSpeedMult;
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

  // Sphere halo
  const halo = ctx.createRadialGradient(cx, cy, orbR * 0.75, cx, cy, orbR * 1.55);
  halo.addColorStop(0, `rgba(245, 158, 11, ${0.4 * pulse * voiceGlowMult})`);
  halo.addColorStop(0.6, `rgba(180, 80, 0, ${0.12 * pulse})`);
  halo.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, orbR * 1.55, 0, Math.PI * 2); ctx.fill();

  // Sphere 3D fill
  const hlX = cx - orbR * 0.28;
  const hlY = cy - orbR * 0.28;
  const sphereFill = ctx.createRadialGradient(hlX, hlY, orbR * 0.04, cx, cy, orbR);
  sphereFill.addColorStop(0,    `rgba(255, 240, 170, ${0.98 * pulse})`);
  sphereFill.addColorStop(0.18, `rgba(252, 211, 77, ${0.92 * pulse})`);
  sphereFill.addColorStop(0.38, `rgba(245, 158, 11, ${0.85 * pulse})`);
  sphereFill.addColorStop(0.62, `rgba(190, 85, 5,   ${0.75})`);
  sphereFill.addColorStop(0.82, `rgba(60, 18, 0,    0.85)`);
  sphereFill.addColorStop(1,    'rgba(5, 5, 16,     0.95)');
  ctx.fillStyle = sphereFill;
  ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.fill();

  // Wireframe
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = `rgba(245, 158, 11, 0.12)`;
  ctx.lineWidth   = 0.5;
  for (let i = 1; i <= 3; i++) {
    const lat = (i / 4) * Math.PI / 2;
    const r   = orbR * Math.cos(lat);
    const oy  = orbR * Math.sin(lat);
    ctx.beginPath(); ctx.ellipse(cx, cy + oy, r, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy - oy, r, r * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
  }
  for (let i = 0; i < 5; i++) {
    const rot = (i / 5) * Math.PI + t * 0.04;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, orbR * 0.12, orbR, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // Edge ring
  const edgeAlpha = voiceState !== 'idle' ? 0.9 + Math.sin(t * 3) * 0.1 : 0.6 + Math.sin(t * 1.4) * 0.25;
  ctx.strokeStyle = `rgba(245, 158, 11, ${edgeAlpha})`;
  ctx.lineWidth   = voiceState !== 'idle' ? 3 : 2;
  ctx.shadowBlur  = voiceState !== 'idle' ? 35 : 22;
  ctx.shadowColor = AMBER;
  ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur  = 0;

  // Specular highlight
  const specX = cx - orbR * 0.28;
  const specY = cy - orbR * 0.28;
  const spec = ctx.createRadialGradient(specX, specY, 0, specX, specY, orbR * 0.35);
  spec.addColorStop(0,   `rgba(255, 248, 210, ${0.75 * pulse})`);
  spec.addColorStop(0.4, `rgba(255, 220, 130, ${0.35 * pulse})`);
  spec.addColorStop(1,   'rgba(0, 0, 0, 0)');
  ctx.fillStyle = spec;
  ctx.beginPath(); ctx.arc(specX, specY, orbR * 0.35, 0, Math.PI * 2); ctx.fill();

  const flareAlpha = 0.4 * pulse;
  const flareLen   = orbR * 0.22;
  ctx.strokeStyle  = `rgba(255, 248, 200, ${flareAlpha})`;
  ctx.lineWidth    = 0.8;
  ctx.beginPath(); ctx.moveTo(specX - flareLen, specY); ctx.lineTo(specX + flareLen, specY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(specX, specY - flareLen); ctx.lineTo(specX, specY + flareLen); ctx.stroke();

  // Outer tick ring
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

  ctx.rotate(-t * 0.075);
  ctx.rotate(t * 0.038);
  ctx.setLineDash([5, 14]);
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.18)';
  ctx.lineWidth   = 0.8;
  ctx.beginPath(); ctx.arc(0, 0, tickR - 28, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();

  // Labels below orb
  const labelY = cy + orbR * 1.82;
  const fz = Math.max(12, minDim * 0.024);

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = `700 ${fz}px 'JetBrains Mono', monospace`;
  ctx.fillStyle    = AMBER;
  ctx.shadowBlur   = 18 * pulse * voiceGlowMult;
  ctx.shadowColor  = AMBER;
  ctx.fillText('J.A.R.V.I.S.', cx, labelY);
  ctx.shadowBlur   = 0;

  const gwColor = gwHealthy ? GREEN : RED;
  ctx.font       = `500 ${Math.max(8, minDim * 0.015)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle  = gwColor;
  ctx.shadowBlur = 6;
  ctx.shadowColor = gwColor;
  ctx.fillText(`GW: ${gwHealthy ? 'ONLINE' : 'OFFLINE'}${version ? ` ${version}` : ''}`, cx, labelY + fz * 1.4);
  ctx.shadowBlur = 0;

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
  slack: SlackMessage[];
  gmailData: { unreadCount?: number; threads?: GmailThread[] } | null;
  asana: unknown[] | null;
  sessions: unknown[];
  recentComms: CommEntry[];
  onCronClick: (job: CronJob) => void;
}

function LeftPanel({ cronGroups, totalCrons, errorCount, topOffset, slack, gmailData, asana, sessions, recentComms, onCronClick }: LeftPanelProps) {
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

      {/* Cron list - takes about 60% of space */}
      <div style={{ flex: '6 1 0', overflowY: 'auto', padding: '3px 0' }}>
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
                    onClick={() => onCronClick(job)}
                    style={{
                      padding: '3px 14px 3px 12px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      borderLeft: recent ? `2px solid ${AMBER}` : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(245,158,11,0.06)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
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
                        {job.model && <span style={{ opacity: 0.6, marginLeft: 6 }}>{job.model}</span>}
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

      {/* Interaction Graph divider */}
      <div style={{
        borderTop: '1px solid rgba(245,158,11,0.15)',
        padding: '5px 14px 4px',
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 8.5, color: AMBER, letterSpacing: '0.2em', fontWeight: 700, fontFamily: "'Inter', sans-serif" }}>
          INTERACTIONS
        </span>
        <span style={{ fontSize: 7.5, color: 'rgba(245,158,11,0.4)', fontFamily: "'JetBrains Mono', monospace" }}>
          {slack.length} MSG
        </span>
      </div>

      {/* Interaction Graph */}
      <div style={{ flexShrink: 0, padding: '4px 0', display: 'flex', justifyContent: 'center' }}>
        <InteractionGraph
          slack={slack}
          gmail={gmailData}
          asana={asana}
          sessions={sessions}
        />
      </div>

      {/* Recent activity list */}
      <div style={{ flex: '2 1 0', overflowY: 'auto', padding: '2px 0' }}>
        {recentComms.slice(0, 6).map((entry, i) => (
          <div
            key={`rc-${i}`}
            className="slack-slide-in"
            style={{
              padding: '3px 12px',
              borderLeft: '2px solid rgba(245,158,11,0.18)',
              marginBottom: 1,
              animationDelay: `${i * 0.03}s`,
            }}
          >
            <div style={{
              fontSize: 7.5, color: 'rgba(245,158,11,0.35)',
              fontFamily: "'JetBrains Mono', monospace",
              display: 'flex', gap: 4, alignItems: 'center', marginBottom: 1,
            }}>
              <span>[{entry.time}]</span>
              <span style={{ color: AMBER, fontWeight: 700 }}>{entry.person}</span>
            </div>
            <div style={{
              fontSize: 9, color: 'rgba(245,158,11,0.75)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {entry.action}
            </div>
          </div>
        ))}
        {recentComms.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: 'rgba(245,158,11,0.2)', fontSize: 9 }}>
            NO RECENT ACTIVITY
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Team Heatmap ───────────────────────────────────────────── */
interface TeamHeatmapProps {
  teamActivity: TeamActivity[];
  onMemberClick: (member: TeamMember, activity: TeamActivity) => void;
}

function TeamHeatmap({ teamActivity, onMemberClick }: TeamHeatmapProps) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 5,
      }}>
        {teamActivity.map(activity => {
          const { member } = activity;
          const status = teamActivityStatus(activity);
          const dotColor = status === 'active' ? GREEN : status === 'recent' ? AMBER : GRAY;
          const isActive = status === 'active';
          const isRecent2 = status === 'recent';

          return (
            <div
              key={member.name}
              onClick={() => onMemberClick(member, activity)}
              style={{
                padding: '6px 8px',
                background: isActive ? `rgba(${hexToRgb(member.color)},0.08)` : 'rgba(20,12,0,0.4)',
                border: `1px solid ${isActive ? member.color + '50' : isRecent2 ? member.color + '25' : 'rgba(245,158,11,0.1)'}`,
                borderRadius: 4,
                cursor: 'pointer',
                transition: 'all 0.2s',
                boxShadow: isActive ? `0 0 8px ${member.color}20` : 'none',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = `rgba(${hexToRgb(member.color)},0.12)`)}
              onMouseLeave={e => (e.currentTarget.style.background = isActive ? `rgba(${hexToRgb(member.color)},0.08)` : 'rgba(20,12,0,0.4)')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: dotColor,
                  boxShadow: isActive ? `0 0 6px ${dotColor}` : 'none',
                  flexShrink: 0,
                  animation: isActive ? 'pulse-amber 1.4s ease-in-out infinite' : 'none',
                }} />
                <span style={{
                  fontSize: 9, fontWeight: 700, color: member.color,
                  fontFamily: "'JetBrains Mono', monospace",
                  textShadow: isActive ? `0 0 6px ${member.color}` : 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: 1,
                }}>
                  {member.shortName}
                </span>
              </div>
              <div style={{
                fontSize: 7.5, color: 'rgba(245,158,11,0.4)',
                fontFamily: "'JetBrains Mono', monospace",
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{member.roleAbbrev}</span>
                {activity.source && (
                  <span style={{
                    color: activity.source === 'both' ? GREEN : activity.source === 'slack' ? AMBER : CYAN,
                    fontSize: 7,
                  }}>
                    {activity.source.toUpperCase()}
                  </span>
                )}
              </div>
              {activity.lastSeenAt && (
                <div style={{
                  fontSize: 7, color: 'rgba(245,158,11,0.3)',
                  fontFamily: "'JetBrains Mono', monospace",
                  marginTop: 1,
                }}>
                  {timeAgo(new Date(activity.lastSeenAt).toISOString())}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '245,158,11';
  return `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`;
}

/* ─── Right Panel (Heatmap + Comms) ─────────────────────────── */
interface RightPanelProps {
  slackMessages: SlackMessage[];
  slackLive: boolean;
  security: SecurityData;
  topOffset: number;
  teamActivity: TeamActivity[];
  gmailData: { unreadCount?: number; threads?: GmailThread[] } | null;
  onMemberClick: (member: TeamMember, activity: TeamActivity) => void;
  onFeedClick: (entry: CCEntry) => void;
}

function slackMsgColor(msg: SlackMessage): string {
  if (msg.isGabe)  return '#FCD34D';
  if (msg.isBot)   return '#F59E0B';
  return '#2DD4BF';
}



function RightPanel({ slackMessages, slackLive, security, topOffset, teamActivity, gmailData, onMemberClick, onFeedClick }: RightPanelProps) {
  const { gapStatuses, activeThreats, lastAudit } = security;

  const auditTime = (() => {
    try {
      const d = new Date(lastAudit);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    } catch { return '—'; }
  })();

  const slackFeed: CCEntry[] = slackMessages.map((msg): CCEntry => ({
    id: msg.timestamp,
    source: 'slack',
    text: msg.text,
    person: msg.person,
    time: msg.time,
    timestamp: msg.timestamp * 1000,
    created_at: new Date(msg.timestamp * 1000).toISOString(),
  }));

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

      {/* ── Team Status (top ~33%) ──── */}
      <div style={{ flex: '3 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{
          padding: '7px 14px 5px', flexShrink: 0,
          borderBottom: '1px solid rgba(245,158,11,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span className="section-header">TEAM STATUS</span>
          <span style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', fontFamily: "'JetBrains Mono', monospace" }}>
            {teamActivity.filter(a => teamActivityStatus(a) === 'active').length} ACTIVE
          </span>
        </div>
        <TeamHeatmap teamActivity={teamActivity} onMemberClick={onMemberClick} />
      </div>

      {/* ── Gmail (middle ~33%) ──── */}
      <div style={{ flex: '3 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="right-panel-divider" />
        <GmailPanel
          unreadCount={gmailData?.unreadCount ?? 0}
          threads={gmailData?.threads ?? []}
        />
      </div>

      {/* ── Slack Feed (bottom ~33%) ──── */}
      <div style={{ flex: '4 1 0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="right-panel-divider" />
        <div style={{
          padding: '7px 14px 5px', flexShrink: 0,
          borderBottom: '1px solid rgba(245,158,11,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span className="section-header">SLACK FEED</span>
          {slackLive && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="live-dot" style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: '#22C55E', boxShadow: '0 0 6px #22C55E',
                animation: 'livePulse 1.4s ease-in-out infinite',
              }} />
              <span style={{
                fontSize: 7.5, color: '#22C55E', letterSpacing: '0.15em',
                fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
              }}>LIVE</span>
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {slackFeed.map((entry, i) => {
            const color = slackMsgColor({ isGabe: entry.person === 'Gabe', isBot: false, text: '', channel: '', time: '', timestamp: 0, person: entry.person });
            const preview = entry.text.length > 55 ? entry.text.slice(0, 55) + '…' : entry.text;
            return (
              <div
                key={`rf-${i}`}
                className="activity-row slack-slide-in"
                onClick={() => onFeedClick(entry)}
                style={{
                  padding: '5px 14px',
                  borderLeft: `2px solid ${color}40`,
                  marginBottom: 1,
                  cursor: 'pointer',
                  animationDelay: `${i * 0.04}s`,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(245,158,11,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  fontSize: 8, color: 'rgba(245,158,11,0.38)', marginBottom: 2,
                  fontFamily: "'JetBrains Mono', monospace",
                  display: 'flex', gap: 5, alignItems: 'center',
                }}>
                  <span>[{entry.time}]</span>
                  <span style={{ color, fontWeight: 700 }}>{entry.person}</span>
                  <span style={{
                    color: AMBER, fontWeight: 700,
                    background: `${AMBER}18`, padding: '0 4px', borderRadius: 3, fontSize: 7.5,
                  }}>SLK</span>
                </div>
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
          {slackFeed.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: 'rgba(245,158,11,0.22)', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}>
              {slackLive ? 'NO RECENT MESSAGES…' : 'CONNECTING…'}
            </div>
          )}
        </div>
      </div>

      {/* ── Security strip at bottom ──── */}
      {(activeThreats > 0 || gapStatuses.some(g => g.status !== 'clean')) && (
        <div style={{ flexShrink: 0 }}>
          <div className="right-panel-divider" />
          <div style={{ padding: '4px 12px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13 }}>🔒</span>
            <div>
              <div style={{
                fontSize: 8.5, color: activeThreats > 0 ? RED : AMBER,
                fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
                textShadow: `0 0 5px ${activeThreats > 0 ? RED : AMBER}`,
              }}>
                {activeThreats > 0 ? `⚠ ${activeThreats} CRITICAL` : '! WARNINGS'}
              </div>
              <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', fontFamily: "'JetBrains Mono', monospace" }}>
                {gapStatuses.filter(g => g.status !== 'clean').length} FLAGS · {auditTime}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── 12h Timeline ───────────────────────────────────────────── */
interface TimelineProps {
  feedEntries: CCEntry[];
  bottomOffset: number;
}

function Timeline({ feedEntries, bottomOffset }: TimelineProps) {
  const [hoveredDot, setHoveredDot] = useState<{ entry: CCEntry; x: number; y: number } | null>(null);

  const now = Date.now();
  const twelveHoursAgo = now - 12 * 60 * 60 * 1000;

  // Filter entries in the 12h window
  const timelineEntries = feedEntries.filter(e => e.timestamp >= twelveHoursAgo);

  // Find team member color for a person name
  function getPersonColor(personName: string): string {
    const nameLower = personName.toLowerCase();
    const member = TEAM_MEMBERS.find(m =>
      m.slackNames?.some(n => nameLower.includes(n)) || nameLower.includes(m.shortName.toLowerCase())
    );
    return member?.color || AMBER;
  }

  // Group entries by time proximity to determine size
  function getDotSize(entry: CCEntry): 'sm' | 'md' | 'lg' {
    const nearCount = timelineEntries.filter(e =>
      Math.abs(e.timestamp - entry.timestamp) < 10 * 60 * 1000 // within 10 min
    ).length;
    if (nearCount >= 5) return 'lg';
    if (nearCount >= 2) return 'md';
    return 'sm';
  }

  // Generate 2h labels
  const labels: Array<{ label: string; pct: number }> = [];
  for (let h = 12; h >= 0; h -= 2) {
    const ts = now - h * 60 * 60 * 1000;
    const pct = ((ts - twelveHoursAgo) / (12 * 60 * 60 * 1000)) * 100;
    const d = new Date(ts);
    const label = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    labels.push({ label, pct });
  }

  return (
    <div style={{
      position: 'absolute',
      left: 0, right: 0,
      bottom: bottomOffset + 52,
      height: 44,
      zIndex: 12,
      background: 'rgba(14,6,0,0.75)',
      borderTop: '1px solid rgba(245,158,11,0.15)',
      borderBottom: '1px solid rgba(245,158,11,0.1)',
      backdropFilter: 'blur(8px)',
      overflow: 'visible',
    }}>
      {/* Time axis labels */}
      <div style={{ position: 'relative', height: '100%', padding: '0 14px' }}>
        {labels.map(({ label, pct }) => (
          <div key={label} style={{
            position: 'absolute',
            bottom: 3,
            left: `calc(${pct}% + 14px)`,
            transform: 'translateX(-50%)',
            fontSize: 7,
            color: 'rgba(245,158,11,0.3)',
            fontFamily: "'JetBrains Mono', monospace",
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>
            {label}
          </div>
        ))}

        {/* Vertical grid lines */}
        {labels.map(({ label, pct }) => (
          <div key={`line-${label}`} style={{
            position: 'absolute',
            top: 0,
            bottom: 14,
            left: `calc(${pct}% + 14px)`,
            width: 1,
            background: 'rgba(245,158,11,0.08)',
            pointerEvents: 'none',
          }} />
        ))}

        {/* Interaction dots */}
        {timelineEntries.map((entry, i) => {
          const pct = ((entry.timestamp - twelveHoursAgo) / (12 * 60 * 60 * 1000)) * 100;
          if (pct < 0 || pct > 100) return null;
          const color = getPersonColor(entry.person);
          const size = getDotSize(entry);
          const dotSize = size === 'lg' ? 9 : size === 'md' ? 7 : 5;
          return (
            <div
              key={`dot-${i}`}
              onMouseEnter={e => setHoveredDot({ entry, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredDot(null)}
              style={{
                position: 'absolute',
                top: '50%',
                left: `calc(${pct}% + 14px)`,
                transform: `translate(-50%, -${55 + (i % 3) * 5}%)`,
                width: dotSize,
                height: dotSize,
                borderRadius: '50%',
                background: color,
                boxShadow: `0 0 ${dotSize}px ${color}`,
                cursor: 'pointer',
                zIndex: 2,
                transition: 'transform 0.15s',
              }}
              onMouseOver={e => { e.currentTarget.style.transform = `translate(-50%, -60%) scale(1.5)`; }}
              onMouseOut={e => { e.currentTarget.style.transform = `translate(-50%, -${55 + (i % 3) * 5}%)`; }}
            />
          );
        })}

        {/* NOW indicator */}
        <div style={{
          position: 'absolute',
          top: 0, bottom: 14,
          right: 14,
          width: 1,
          background: AMBER,
          boxShadow: `0 0 4px ${AMBER}`,
        }} />
        <div style={{
          position: 'absolute',
          bottom: 3,
          right: 14,
          transform: 'translateX(50%)',
          fontSize: 7,
          color: AMBER,
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
        }}>
          NOW
        </div>
      </div>

      {/* Hover tooltip */}
      {hoveredDot && (
        <div style={{
          position: 'fixed',
          left: hoveredDot.x + 10,
          top: hoveredDot.y - 60,
          background: 'rgba(14,6,0,0.97)',
          border: `1px solid ${AMBER}`,
          borderRadius: 4,
          padding: '6px 10px',
          zIndex: 1000,
          pointerEvents: 'none',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          <div style={{ fontSize: 8, color: AMBER, fontWeight: 700 }}>{hoveredDot.entry.person}</div>
          <div style={{ fontSize: 7.5, color: 'rgba(245,158,11,0.6)', marginTop: 2 }}>{hoveredDot.entry.time}</div>
          <div style={{
            fontSize: 8, color: 'rgba(245,158,11,0.8)', marginTop: 3,
            maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {hoveredDot.entry.text.slice(0, 60)}
          </div>
        </div>
      )}
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
            fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
          }}>
            {secFlags} SECURITY FLAG{secFlags > 1 ? 'S' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/* ─── Detail Drawer ───────────────────────────────────────────── */
interface DrawerProps {
  content: DrawerContent | null;
  onClose: () => void;
}

function DetailDrawer({ content, onClose }: DrawerProps) {
  if (!content) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,0.4)',
          backdropFilter: 'blur(2px)',
        }}
      />
      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 380, zIndex: 41,
        background: 'rgba(10,5,0,0.97)',
        borderLeft: '1px solid rgba(245,158,11,0.3)',
        boxShadow: '-20px 0 60px rgba(245,158,11,0.08)',
        display: 'flex', flexDirection: 'column',
        animation: 'drawer-slide-in 0.25s ease-out',
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {/* Shimmer */}
        <div style={{
          height: 1, background: 'linear-gradient(90deg, transparent, rgba(245,158,11,0.6), transparent)',
        }} />

        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(245,158,11,0.15)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.2em', marginBottom: 4 }}>
              {content.type.toUpperCase()} DETAIL
            </div>
            <div style={{ fontSize: 12, color: AMBER, fontWeight: 700 }}>
              {content.title}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid rgba(245,158,11,0.3)',
              color: AMBER, cursor: 'pointer', padding: '4px 10px',
              borderRadius: 3, fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {content.type === 'cron' && <CronDetail data={content.data as CronJob} />}
          {content.type === 'team' && <TeamDetail data={content.data as { member: TeamMember; activity: TeamActivity }} />}
          {content.type === 'feed' && <FeedDetail data={content.data as CCEntry} />}
        </div>
      </div>

      <style>{`
        @keyframes drawer-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}

function CronDetail({ data }: { data: CronJob }) {
  const sc = STATUS_COLORS[data.lastStatus || 'unknown'] ?? GRAY;
  const displayTime = data.lastRunAgo && data.lastRunAgo !== '-' ? data.lastRunAgo : timeAgo(data.lastRun);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Status badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        background: `rgba(${sc === GREEN ? '34,197,94' : sc === RED ? '239,68,68' : '107,114,128'},0.1)`,
        border: `1px solid ${sc}30`,
        borderRadius: 6,
      }}>
        <div className={`dot dot-${data.lastStatus || 'unknown'}`} />
        <span style={{ color: sc, fontSize: 13, fontWeight: 700 }}>
          {(data.lastStatus || 'unknown').toUpperCase()}
        </span>
      </div>

      {/* Details grid */}
      {[
        ['Category', data.category || '—'],
        ['Schedule', data.schedule || '—'],
        ['Last Run', displayTime],
        ['Next Run', data.nextRun || '—'],
        ['Model', data.model || '—'],
        ['ID', (data.id || '—').slice(0, 20)],
      ].map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.15em', marginBottom: 4 }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(245,158,11,0.85)', lineHeight: 1.5 }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function TeamDetail({ data }: { data: { member: TeamMember; activity: TeamActivity } }) {
  const { member, activity } = data;
  const status = teamActivityStatus(activity);
  const dotColor = status === 'active' ? GREEN : status === 'recent' ? AMBER : GRAY;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Avatar / name */}
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: `rgba(${hexToRgb(member.color)},0.15)`,
          border: `2px solid ${member.color}60`,
          margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24, color: member.color,
          boxShadow: status === 'active' ? `0 0 20px ${member.color}40` : 'none',
        }}>
          {member.shortName[0]}
        </div>
        <div style={{ fontSize: 14, color: member.color, fontWeight: 700 }}>{member.name}</div>
        <div style={{ fontSize: 10, color: 'rgba(245,158,11,0.5)', marginTop: 4 }}>{member.role}</div>
      </div>

      {/* Status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        background: `rgba(${dotColor === GREEN ? '34,197,94' : dotColor === AMBER ? '245,158,11' : '107,114,128'},0.08)`,
        border: `1px solid ${dotColor}30`,
        borderRadius: 6,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: dotColor, boxShadow: `0 0 6px ${dotColor}`,
        }} />
        <span style={{ color: dotColor, fontSize: 11, fontWeight: 700 }}>
          {status.toUpperCase()}
        </span>
        {activity.lastSeenAt && (
          <span style={{ color: 'rgba(245,158,11,0.4)', fontSize: 10 }}>
            · {timeAgo(new Date(activity.lastSeenAt).toISOString())}
          </span>
        )}
      </div>

      {/* Activity source */}
      {[
        ['Activity Source', activity.source ? activity.source.toUpperCase() : 'NO RECENT ACTIVITY'],
        ['Last Seen', activity.lastSeenAt ? formatTime(new Date(activity.lastSeenAt).toISOString()) : '—'],
      ].map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.15em', marginBottom: 4 }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(245,158,11,0.85)' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function FeedDetail({ data }: { data: CCEntry }) {
  const isSlack = data.source === 'slack';
  const color = isSlack ? AMBER : CYAN;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Source badge */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px',
        background: `${color}15`,
        border: `1px solid ${color}40`,
        borderRadius: 4,
        alignSelf: 'flex-start',
      }}>
        <span style={{ color, fontSize: 9, fontWeight: 700, letterSpacing: '0.15em' }}>
          {isSlack ? '◈ SLACK' : '◈ COMMAND CENTER'}
        </span>
      </div>

      {[
        ['From', data.person],
        ['Time', data.time],
        ...(data.agent_name ? [['Agent', data.agent_name]] : []),
        ...(data.action_type ? [['Action', data.action_type]] : []),
        ...(data.client_tag ? [['Client', data.client_tag]] : []),
        ...(data.status ? [['Status', data.status.toUpperCase()]] : []),
      ].map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.15em', marginBottom: 4 }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(245,158,11,0.85)' }}>{value}</div>
        </div>
      ))}

      {/* Full message */}
      <div>
        <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.15em', marginBottom: 8 }}>
          FULL MESSAGE
        </div>
        <div style={{
          padding: '12px 14px',
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid rgba(245,158,11,0.1)',
          borderRadius: 4,
          fontSize: 11, color: 'rgba(245,158,11,0.85)',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {data.text}
        </div>
      </div>
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
  const voiceStateRef = useRef<VoiceState>('idle');

  const [status, setStatus]           = useState<StatusResponse | null>(null);
  const [now, setNow]                  = useState<Date>(new Date());
  const [slackMessages, setSlackMsgs] = useState<SlackMessage[]>([]);
  const [slackLive, setSlackLive]     = useState(false);
  const [ccEntries, setCcEntries]     = useState<CCEntry[]>([]);
  const [voiceState, setVoiceState]   = useState<VoiceState>('idle');
  const [drawer, setDrawer]           = useState<DrawerContent | null>(null);
  const [isMobile, setIsMobile]       = useState(false);
  const [mobileSheet, setMobileSheet] = useState<'crons' | 'activity' | 'security' | 'usage' | 'gmail' | null>(null);
  const [showUsage, setShowUsage]         = useState(false);
  const [interactionsData, setInteractionsData] = useState<InteractionsData | null>(null);
  const [usageData, setUsageData]         = useState<OpsUsageData | null>(null);

  // Mobile detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  const [tooltip, setTooltip]         = useState<{ x: number; y: number; job: CronJob } | null>(null);

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

  /* Slack live feed */
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

  /* CC activity feed */
  const fetchCC = useCallback(async () => {
    const CC_URL = process.env.NEXT_PUBLIC_CC_API_URL || 'https://eb-command-center.vercel.app';
    try {
      const res = await fetch(`${CC_URL}/api/admin/activity-feed?hours=4&limit=15`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json() as {
        entries?: Array<{
          id: number;
          agent_name: string;
          action_type: string;
          client_tag: string | null;
          input_summary: string;
          output_summary: string;
          status: string;
          created_at: string;
        }>;
      };
      if (Array.isArray(data.entries)) {
        const entries: CCEntry[] = data.entries.map(e => ({
          ...e,
          source: 'cc' as const,
          text: e.output_summary || e.input_summary || e.action_type,
          person: e.agent_name,
          time: formatTime(e.created_at),
          timestamp: new Date(e.created_at).getTime(),
        }));
        setCcEntries(entries);
      }
    } catch { /* CC may be unavailable */ }
  }, []);

  useEffect(() => {
    fetchCC();
    const id = setInterval(fetchCC, 30_000);
    return () => clearInterval(id);
  }, [fetchCC]);

  /* Interactions (gmail, asana, sessions) */
  const fetchInteractions = useCallback(async () => {
    const CC = process.env.NEXT_PUBLIC_CC_API_URL || 'https://eb-command-center.vercel.app';
    try {
      const res  = await fetch(`${CC}/api/ops-interactions`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const data = await res.json() as InteractionsData;
      setInteractionsData(data);
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    fetchInteractions();
    const id = setInterval(fetchInteractions, 30_000);
    return () => clearInterval(id);
  }, [fetchInteractions]);

  /* Usage data */
  const fetchUsage = useCallback(async () => {
    try {
      const res  = await fetch('/api/ops-usage', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await res.json() as OpsUsageData;
      setUsageData(data);
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    fetchUsage();
    const id = setInterval(fetchUsage, 60_000);
    return () => clearInterval(id);
  }, [fetchUsage]);

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
        s?.crons ?? [], s?.gateway.healthy ?? false, s?.sessions.active ?? 0,
        voiceStateRef.current, s?.gateway.version);

      if (s && Math.random() < 0.06 && particlesRef.current.length < 80) {
        particlesRef.current.push(spawnParticle(cx, cy, hasErrors));
      }
      particlesRef.current = tickParticles(ctx, particlesRef.current);

      animRef.current = requestAnimationFrame(loop);
    }

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [transparent]);

  /* Tooltip on canvas */
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
  const security    = status?.security ?? null;
  const hasAlert    = errorCount > 0 || (security?.gapStatuses.some(g => g.status !== 'clean') ?? false);
  const topOffset   = hasAlert ? 50 : 8;

  // Combined feed for left panel (interleaved Slack + CC)
  const combinedFeed: CCEntry[] = [
    ...slackMessages.map((msg): CCEntry => ({
      id: msg.timestamp,
      source: 'slack',
      text: msg.text,
      person: msg.person,
      time: msg.time,
      timestamp: msg.timestamp * 1000,
      created_at: new Date(msg.timestamp * 1000).toISOString(),
    })),
    ...ccEntries,
  ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);

  // Team activity
  const teamActivity = buildTeamActivity(slackMessages, combinedFeed);

  // Drawer handlers
  const openCronDrawer = useCallback((job: CronJob) => {
    setDrawer({ type: 'cron', title: job.name, data: job });
  }, []);

  const openTeamDrawer = useCallback((member: TeamMember, activity: TeamActivity) => {
    setDrawer({ type: 'team', title: member.name, data: { member, activity } });
  }, []);

  const openFeedDrawer = useCallback((entry: CCEntry) => {
    setDrawer({ type: 'feed', title: `${entry.person} · ${entry.time}`, data: entry });
  }, []);

  const handleVoiceStateChange = useCallback((s: VoiceState) => {
    voiceStateRef.current = s;
    setVoiceState(s);
  }, []);

  return (
    <div
      className="scanlines"
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        fontFamily: "'JetBrains Mono', monospace",
        background: transparent ? 'transparent' : BG,
      }}
    >
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'block' }}
      />

      {/* Voice Interface (orb click handler + overlay) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none' }}>
        <div style={{ pointerEvents: 'auto' }}>
          <VoiceInterface
            onStateChange={handleVoiceStateChange}
            cronContext={{
              ok: status?.crons.filter(c => c.lastStatus === 'ok').length ?? 0,
              error: errorCount,
              total: totalCrons,
            }}
            errorContext={errorJobs.map(j => j.name)}
          />
        </div>
      </div>

      {/* Alert bar */}
      <AlertBar errorCount={errorCount} errorJobs={errorJobs} security={security} />

      {/* Left panel — desktop only */}
      {!isMobile && <LeftPanel
        cronGroups={cronGroups}
        totalCrons={totalCrons}
        errorCount={errorCount}
        topOffset={topOffset}
        slack={slackMessages}
        gmailData={interactionsData?.gmail ?? null}
        asana={interactionsData?.asana ?? null}
        sessions={interactionsData?.sessions ?? status?.sessions.list ?? []}
        recentComms={status?.recentComms ?? []}
        onCronClick={openCronDrawer}
      />}

      {/* Right panel — desktop only */}
      {!isMobile && <RightPanel
        slackMessages={slackMessages}
        slackLive={slackLive}
        security={security ?? { gapStatuses: [], activeThreats: 0, lastAudit: '', highItems: [] }}
        topOffset={topOffset}
        teamActivity={teamActivity}
        gmailData={interactionsData?.gmail ?? null}
        onMemberClick={openTeamDrawer}
        onFeedClick={openFeedDrawer}
      />}

      {/* 12h Timeline — desktop only */}
      {!isMobile && <Timeline
        feedEntries={combinedFeed}
        bottomOffset={0}
      />}

      {/* Usage drawer toggle — desktop only */}
      {!isMobile && (
        <button
          onClick={() => setShowUsage(v => !v)}
          style={{
            position: 'absolute', bottom: 64, right: 14, zIndex: 16,
            background: showUsage ? 'rgba(245,158,11,0.15)' : 'rgba(14,6,0,0.85)',
            border: `1px solid ${showUsage ? 'rgba(245,158,11,0.5)' : 'rgba(245,158,11,0.2)'}`,
            borderRadius: 8, cursor: 'pointer',
            padding: '5px 14px', display: 'flex', alignItems: 'center', gap: 7,
            fontFamily: "'JetBrains Mono', monospace",
            backdropFilter: 'blur(8px)',
          }}
        >
          <span style={{ fontSize: 13 }}>💰</span>
          <span style={{ fontSize: 8, color: showUsage ? AMBER : 'rgba(245,158,11,0.5)', letterSpacing: '0.15em', fontWeight: 700 }}>
            {showUsage ? 'HIDE USAGE' : 'LLM USAGE'}
          </span>
        </button>
      )}

      {/* Usage panel — desktop drawer */}
      {!isMobile && showUsage && (
        <div style={{
          position: 'absolute', bottom: 100, right: 14, zIndex: 20,
          width: 480, maxHeight: 'calc(100vh - 160px)', overflowY: 'auto',
          background: 'rgba(14,6,0,0.92)', border: '1px solid rgba(245,158,11,0.2)',
          borderRadius: 8, padding: '16px 18px',
          fontFamily: "'JetBrains Mono', monospace",
          backdropFilter: 'blur(12px)',
          boxShadow: '0 0 40px rgba(245,158,11,0.08)',
        }}>
          <div className="panel-shimmer" />
          <TokenBurnRate data={usageData} />
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(245,158,11,0.15)' }}>
            <ChannelHeatmap interactions={combinedFeed.map(e => ({ timestamp: e.timestamp, source: e.source }))} />
          </div>
        </div>
      )}

      {/* Bottom HUD — desktop: full strip, mobile: simplified */}
      {!isMobile ? <BottomStrip status={status} now={now} /> : (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 15,
          background: 'rgba(14,6,0,0.95)', borderTop: `1px solid rgba(245,158,11,0.2)`,
          display: 'flex', justifyContent: 'space-around', alignItems: 'center',
          padding: '10px 0 env(safe-area-inset-bottom, 10px)',
          backdropFilter: 'blur(12px)',
        }}>
          {[
            { id: 'crons' as const, icon: '⚡', label: 'Crons', badge: errorCount > 0 ? errorCount : undefined },
            { id: 'activity' as const, icon: '📡', label: 'Activity' },
            { id: 'security' as const, icon: '🔒', label: 'Security' },
            { id: 'usage' as const, icon: '💰', label: 'Usage' },
            { id: 'gmail' as const, icon: '📧', label: 'Gmail', badge: (interactionsData?.gmail?.unreadCount ?? 0) > 0 ? interactionsData?.gmail?.unreadCount : undefined },
          ].map(tab => (
            <button key={tab.id} onClick={() => setMobileSheet(mobileSheet === tab.id ? null : tab.id)} style={{
              background: mobileSheet === tab.id ? 'rgba(245,158,11,0.15)' : 'transparent',
              border: mobileSheet === tab.id ? `1px solid rgba(245,158,11,0.4)` : '1px solid transparent',
              borderRadius: 12, padding: '8px 18px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              position: 'relative',
            }}>
              <span style={{ fontSize: 18 }}>{tab.icon}</span>
              <span style={{ fontSize: 8, color: mobileSheet === tab.id ? AMBER : 'rgba(245,158,11,0.5)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em', textTransform: 'uppercase' }}>{tab.label}</span>
              {tab.badge && <span style={{ position: 'absolute', top: 2, right: 8, background: RED, color: '#fff', fontSize: 8, fontWeight: 700, borderRadius: 8, padding: '1px 5px', minWidth: 14, textAlign: 'center' }}>{tab.badge}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Mobile bottom sheet */}
      {isMobile && mobileSheet && (
        <>
          <div onClick={() => setMobileSheet(null)} style={{ position: 'fixed', inset: 0, zIndex: 25, background: 'rgba(0,0,0,0.5)' }} />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 30,
            maxHeight: '60vh', overflowY: 'auto',
            background: 'rgba(14,6,0,0.97)', borderTop: `2px solid ${AMBER}`,
            borderRadius: '16px 16px 0 0', padding: '12px 16px 80px',
            fontFamily: "'JetBrains Mono', monospace",
            backdropFilter: 'blur(16px)',
          }}>
            <div style={{ width: 40, height: 4, background: 'rgba(245,158,11,0.3)', borderRadius: 2, margin: '0 auto 12px' }} />
            <div style={{ fontSize: 10, color: AMBER, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 10, fontWeight: 700 }}>
              {mobileSheet === 'crons' && `\u26A1 Cron Jobs (${totalCrons})`}
              {mobileSheet === 'activity' && '\uD83D\uDCE1 Activity Feed'}
              {mobileSheet === 'security' && '\uD83D\uDD12 Security'}
              {mobileSheet === 'usage' && '💰 LLM Usage'}
              {mobileSheet === 'gmail' && '📧 Gmail'}
            </div>
            {mobileSheet === 'crons' && Object.entries(cronGroups).map(([cat, jobs]) => (
              <div key={cat} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.5)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{cat}</div>
                {jobs.map(job => {
                  const sc = STATUS_COLORS[job.lastStatus || 'unknown'] ?? GRAY;
                  return (
                    <div key={job.id} onClick={() => { setMobileSheet(null); openCronDrawer(job); }} style={{
                      padding: '8px 10px', borderLeft: `2px solid ${sc}`, marginBottom: 4,
                      background: 'rgba(245,158,11,0.03)', borderRadius: '0 6px 6px 0', cursor: 'pointer',
                    }}>
                      <div style={{ fontSize: 10, color: AMBER, fontWeight: 600 }}>{job.name}</div>
                      <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', marginTop: 2 }}>
                        {job.lastStatus?.toUpperCase()} · {job.lastRunAgo || 'never'}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            {mobileSheet === 'activity' && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <ChannelHeatmap interactions={combinedFeed.map(e => ({ timestamp: e.timestamp, source: e.source }))} />
                </div>
                {combinedFeed.slice(0, 20).map((entry, i) => (
                  <div key={i} style={{
                    padding: '8px 10px', borderLeft: `2px solid rgba(245,158,11,0.3)`, marginBottom: 4,
                    background: 'rgba(245,158,11,0.03)', borderRadius: '0 6px 6px 0',
                  }}>
                    <div style={{ fontSize: 9, color: 'rgba(245,158,11,0.5)' }}>{entry.time} · {entry.person}</div>
                    <div style={{ fontSize: 10, color: AMBER, marginTop: 2 }}>{entry.text}</div>
                  </div>
                ))}
              </>
            )}
            {mobileSheet === 'gmail' && (
              <div style={{ paddingBottom: 8 }}>
                <GmailPanel
                  unreadCount={interactionsData?.gmail?.unreadCount ?? 0}
                  threads={interactionsData?.gmail?.threads ?? []}
                />
              </div>
            )}
            {mobileSheet === 'security' && (
              <div style={{ fontSize: 10, color: AMBER }}>
                <div style={{ marginBottom: 8 }}>Active Threats: <span style={{ color: (security?.activeThreats ?? 0) > 0 ? RED : GREEN, fontWeight: 700 }}>{security?.activeThreats ?? 0}</span></div>
                <div style={{ marginBottom: 8 }}>Last Audit: {security?.lastAudit || 'N/A'}</div>
                {security?.gapStatuses?.filter(g => g.status !== 'clean').map((gap, i) => (
                  <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid rgba(245,158,11,0.1)', fontSize: 9 }}>
                    GAP {gap.num} — {gap.gap}: <span style={{ color: gap.status === 'critical' ? RED : AMBER, fontWeight: 600 }}>{gap.status?.toUpperCase()}</span>
                    {gap.note && <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.4)', marginTop: 2 }}>{gap.note}</div>}
                  </div>
                ))}
                {security?.highItems?.map((item, i) => (
                  <div key={i} style={{ padding: '6px 0', borderLeft: `2px solid ${RED}`, paddingLeft: 8, marginTop: 4, fontSize: 9, color: 'rgba(245,158,11,0.7)' }}>
                    {item}
                  </div>
                ))}
              </div>
            )}
            {mobileSheet === 'usage' && (
              <div style={{ paddingBottom: 8 }}>
                <TokenBurnRate data={usageData} />
              </div>
            )}
          </div>
        </>
      )}

      {/* Detail Drawer */}
      <DetailDrawer content={drawer} onClose={() => setDrawer(null)} />

      {/* Canvas hover tooltip */}
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
            <div style={{ fontWeight: 700, marginBottom: 5, color: sc, textShadow: `0 0 8px ${sc}` }}>
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

      {/* Mobile: tap hint below orb */}
      {isMobile && voiceState === 'idle' && (
        <div style={{
          position: 'absolute', top: '62%', left: '50%', transform: 'translateX(-50%)',
          zIndex: 10, pointerEvents: 'none',
          fontSize: 9, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.2em', textTransform: 'uppercase',
          fontFamily: "'JetBrains Mono', monospace",
          textAlign: 'center',
          animation: 'pulse-hint 2s ease-in-out infinite',
        }}>
          TAP ORB TO SPEAK
        </div>
      )}
      <style>{`@keyframes pulse-hint { 0%,100% { opacity: 0.3; } 50% { opacity: 0.7; } }`}</style>

      {/* Voice state HUD indicator */}
      {voiceState !== 'idle' && (
        <div style={{
          position: 'absolute',
          ...(isMobile ? { top: '60%' } : { top: topOffset + 8 }),
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          background: 'rgba(14,6,0,0.9)',
          border: `1px solid ${AMBER}`,
          borderRadius: 20,
          padding: '4px 16px',
          fontSize: 9,
          color: AMBER,
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.2em',
          textShadow: `0 0 8px ${AMBER}`,
          pointerEvents: 'none',
        }}>
          {voiceState === 'listening' && '◉ LISTENING'}
          {voiceState === 'processing' && '◈ PROCESSING'}
          {voiceState === 'speaking' && '◆ SPEAKING'}
        </div>
      )}

      {/* Primary voice: Vapi (working April 25, 2026) */}
      <VapiVoice />
      {/* ConvAIVoice kept as fallback (ElevenLabs bridge) */}
      {/* <ConvAIVoice /> */}
    </div>
  );
}
