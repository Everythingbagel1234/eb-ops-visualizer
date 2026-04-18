'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

interface CronJob {
  name: string;
  schedule?: string;
  lastRun?: string;
  lastStatus?: 'ok' | 'error' | 'running' | 'unknown';
  nextRun?: string;
  category?: string;
}

interface StatusData {
  gateway: { healthy: boolean; status: string };
  crons: CronJob[];
  sessions: { active: number; list: string[] };
  errors: number;
  timestamp: string;
}

interface Particle {
  id: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  progress: number;
  speed: number;
  color: string;
  size: number;
  opacity: number;
}

interface CronDot {
  x: number;
  y: number;
  job: CronJob;
  pulsePhase: number;
  angle: number;
}

const CATEGORY_POSITIONS: Record<string, { start: number; end: number }> = {
  'Data Connectors': { start: -Math.PI * 0.75, end: -Math.PI * 0.25 }, // top
  'Core Agents':     { start: -Math.PI * 0.25, end: Math.PI * 0.25 },  // right
  'Ops & Intel':     { start: Math.PI * 0.25,  end: Math.PI * 0.75 },  // bottom
  'Monitoring':      { start: Math.PI * 0.75,  end: Math.PI * 1.25 },  // left
};

const STATUS_COLORS: Record<string, string> = {
  ok:      '#22c55e',
  error:   '#ef4444',
  running: '#F59E0B',
  unknown: '#6b7280',
};

let particleIdCounter = 0;

export default function OpsVisualizer({ transparent }: { transparent: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<StatusData | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const cronDotsRef = useRef<CronDot[]>([]);
  const animFrameRef = useRef<number>(0);
  const lastFetchRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const tooltipRef = useRef<{ x: number; y: number; job: CronJob } | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; job: CronJob } | null>(null);
  // ticker offset handled via canvas Date.now() — no React state needed

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      const data: StatusData = await res.json();
      statusRef.current = data;
      lastFetchRef.current = Date.now();
    } catch {
      // keep stale data
    }
  }, []);

  const buildCronDots = useCallback((canvas: HTMLCanvasElement, crons: CronJob[]) => {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = Math.min(canvas.width, canvas.height) * 0.42;

    const groups: Record<string, CronJob[]> = {
      'Data Connectors': [],
      'Core Agents': [],
      'Ops & Intel': [],
      'Monitoring': [],
    };

    crons.forEach(job => {
      const cat = job.category || 'Monitoring';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(job);
    });

    const dots: CronDot[] = [];

    Object.entries(groups).forEach(([cat, jobs]) => {
      if (jobs.length === 0) return;
      const range = CATEGORY_POSITIONS[cat];
      if (!range) return;
      const span = range.end - range.start;

      jobs.forEach((job, i) => {
        const t = jobs.length === 1 ? 0.5 : i / (jobs.length - 1);
        const angle = range.start + span * t;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        dots.push({
          x, y, job,
          pulsePhase: Math.random() * Math.PI * 2,
          angle,
        });
      });
    });

    cronDotsRef.current = dots;
  }, []);

  const spawnParticles = useCallback((canvas: HTMLCanvasElement) => {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dots = cronDotsRef.current;
    const status = statusRef.current;

    if (!status) return;

    // Spawn a few particles from active/ok crons
    const active = dots.filter(d => d.job.lastStatus !== 'unknown');
    if (active.length === 0) return;

    // Limit particles
    if (particlesRef.current.length > 80) {
      particlesRef.current = particlesRef.current.slice(-60);
    }

    // Random pick
    const dot = active[Math.floor(Math.random() * active.length)];
    const color = STATUS_COLORS[dot.job.lastStatus || 'unknown'];

    particlesRef.current.push({
      id: particleIdCounter++,
      startX: dot.x,
      startY: dot.y,
      endX: cx + (Math.random() - 0.5) * 40,
      endY: cy + (Math.random() - 0.5) * 40,
      progress: 0,
      speed: 0.004 + Math.random() * 0.006,
      color,
      size: 2 + Math.random() * 2,
      opacity: 0.8 + Math.random() * 0.2,
    });
  }, []);

  const drawGrid = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const step = 40;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
  }, []);

  const drawHub = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number) => {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const status = statusRef.current;

    const hubRadius = Math.min(canvas.width, canvas.height) * 0.12;
    const pulse = 1 + Math.sin(t * 1.5) * 0.02;

    // Outer glow rings
    for (let i = 3; i >= 1; i--) {
      const gr = ctx.createRadialGradient(cx, cy, hubRadius * pulse * 0.5, cx, cy, hubRadius * pulse * (1 + i * 0.3));
      gr.addColorStop(0, `rgba(245, 158, 11, ${0.06 / i})`);
      gr.addColorStop(1, 'rgba(245,158,11,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(cx, cy, hubRadius * pulse * (1 + i * 0.3), 0, Math.PI * 2);
      ctx.fill();
    }

    // Hub circle
    const gradient = ctx.createRadialGradient(cx - hubRadius * 0.2, cy - hubRadius * 0.2, hubRadius * 0.1, cx, cy, hubRadius * pulse);
    gradient.addColorStop(0, '#2a1f00');
    gradient.addColorStop(0.6, '#131313');
    gradient.addColorStop(1, '#0a0a0a');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, hubRadius * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Hub border
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, hubRadius * pulse, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating dashes ring
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.3);
    ctx.strokeStyle = 'rgba(245,158,11,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 12]);
    ctx.beginPath();
    ctx.arc(0, 0, hubRadius * pulse + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // JARVIS text
    const fontSize = Math.max(14, hubRadius * 0.28);
    ctx.fillStyle = '#F8F8F8';
    ctx.font = `700 ${fontSize}px 'Space Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('JARVIS', cx, cy - hubRadius * 0.22);

    // Active sessions
    const sessions = status?.sessions.active ?? 0;
    ctx.fillStyle = sessions > 0 ? '#F59E0B' : '#6b7280';
    ctx.font = `${Math.max(10, hubRadius * 0.18)}px 'Space Mono', monospace`;
    ctx.fillText(`${sessions} SESSION${sessions !== 1 ? 'S' : ''}`, cx, cy + hubRadius * 0.08);

    // Time
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    ctx.fillStyle = 'rgba(248,248,248,0.5)';
    ctx.font = `${Math.max(9, hubRadius * 0.15)}px 'Space Mono', monospace`;
    ctx.fillText(timeStr, cx, cy + hubRadius * 0.28);

    // Gateway status dot
    const dotX = cx + hubRadius * 0.55;
    const dotY = cy - hubRadius * 0.55;
    const healthy = status?.gateway.healthy ?? false;
    ctx.fillStyle = healthy ? '#22c55e' : '#ef4444';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
    ctx.fill();
    // Glow
    const dotGlow = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, 12);
    dotGlow.addColorStop(0, healthy ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)');
    dotGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = dotGlow;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 12, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const drawCronRing = useCallback((ctx: CanvasRenderingContext2D, t: number) => {
    const dots = cronDotsRef.current;
    if (dots.length === 0) return;

    dots.forEach(dot => {
      const status = dot.job.lastStatus || 'unknown';
      const color = STATUS_COLORS[status];

      const isRecent = dot.job.lastRun
        ? (Date.now() - new Date(dot.job.lastRun).getTime()) < 15 * 60 * 1000
        : false;

      const pulseMag = isRecent ? 1 + Math.sin(t * 3 + dot.pulsePhase) * 0.4 : 1;
      const r = 7 * pulseMag;

      // Glow
      const glowRadius = r * (isRecent ? 3 : 2);
      const glow = ctx.createRadialGradient(dot.x, dot.y, r * 0.3, dot.x, dot.y, glowRadius);
      glow.addColorStop(0, color + 'aa');
      glow.addColorStop(1, color + '00');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      // Core dot
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = '#F8F8F8';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Label
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const dx = dot.x - cx;
      const dy = dot.y - cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      const labelPad = r + 12;
      const lx = dot.x + (dx / len) * labelPad;
      const ly = dot.y + (dy / len) * labelPad;

      ctx.save();
      ctx.translate(lx, ly);
      const angle = Math.atan2(dy, dx);
      // Flip text on left half
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
        ctx.rotate(angle + Math.PI);
        ctx.textAlign = 'right';
      } else {
        ctx.rotate(angle);
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = 'rgba(248,248,248,0.7)';
      ctx.font = '10px monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(dot.job.name, 0, 0);
      ctx.restore();
    });
  }, []);

  const drawCategoryLabels = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const labelRadius = Math.min(canvas.width, canvas.height) * 0.48;

    const categories = [
      { name: 'DATA CONNECTORS', angle: -Math.PI / 2 },
      { name: 'CORE AGENTS', angle: 0 },
      { name: 'OPS & INTEL', angle: Math.PI / 2 },
      { name: 'MONITORING', angle: Math.PI },
    ];

    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    categories.forEach(({ name, angle }) => {
      const x = cx + Math.cos(angle) * labelRadius;
      const y = cy + Math.sin(angle) * labelRadius;
      ctx.fillStyle = 'rgba(245,158,11,0.6)';
      ctx.fillText(name, x, y);
    });
  }, []);

  const drawParticles = useCallback((ctx: CanvasRenderingContext2D) => {
    const particles = particlesRef.current;
    const living: Particle[] = [];

    particles.forEach(p => {
      if (p.progress >= 1) return;

      p.progress = Math.min(1, p.progress + p.speed);
      const eased = 1 - Math.pow(1 - p.progress, 3);

      const x = p.startX + (p.endX - p.startX) * eased;
      const y = p.startY + (p.endY - p.startY) * eased;
      const fade = p.progress > 0.7 ? 1 - (p.progress - 0.7) / 0.3 : 1;

      ctx.globalAlpha = p.opacity * fade;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, p.size * (1 - p.progress * 0.5), 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = p.opacity * fade * 0.3;
      const trailGlow = ctx.createRadialGradient(x, y, 0, x, y, p.size * 3);
      trailGlow.addColorStop(0, p.color);
      trailGlow.addColorStop(1, p.color + '00');
      ctx.fillStyle = trailGlow;
      ctx.beginPath();
      ctx.arc(x, y, p.size * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      living.push(p);
    });

    particlesRef.current = living;
  }, []);

  const drawMetricsTicker = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const status = statusRef.current;
    if (!status) return;

    const h = 32;
    const y = canvas.height - h;

    ctx.fillStyle = 'rgba(10,10,10,0.85)';
    ctx.fillRect(0, y, canvas.width, h);
    ctx.strokeStyle = 'rgba(245,158,11,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();

    const total = status.crons.length;
    const active = status.sessions.active;
    const errors = status.errors;
    const lastRefresh = new Date(status.timestamp).toLocaleTimeString('en-US', { hour12: false });

    const text = `  ● JARVIS OPS CENTER  |  CRONS: ${total}  |  ACTIVE: ${active}  |  ERRORS: ${errors}  |  GATEWAY: ${status.gateway.status.toUpperCase()}  |  LAST SYNC: ${lastRefresh}  `.repeat(3);

    ctx.font = '11px monospace';
    ctx.fillStyle = errors > 0 ? '#F59E0B' : 'rgba(248,248,248,0.6)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const offset = (Date.now() / 50) % (canvas.width * 1.5);
    ctx.fillText(text, -offset, y + h / 2);
  }, []);

  const drawAlertBanner = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const status = statusRef.current;
    if (!status || status.errors === 0) return;

    const errorJobs = status.crons.filter(c => c.lastStatus === 'error');
    const names = errorJobs.map(j => j.name).join(' • ');

    ctx.fillStyle = 'rgba(239,68,68,0.15)';
    ctx.fillRect(0, 0, canvas.width, 36);
    ctx.strokeStyle = 'rgba(239,68,68,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 36);
    ctx.lineTo(canvas.width, 36);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`⚠ ERRORS: ${names}`, 16, 18);
  }, []);

  const drawConnectionLines = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number) => {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dots = cronDotsRef.current;

    dots.forEach(dot => {
      const status = dot.job.lastStatus || 'unknown';
      if (status === 'unknown') return;

      const color = STATUS_COLORS[status];
      const alpha = 0.08 + Math.sin(t * 0.5 + dot.pulsePhase) * 0.04;

      ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0');
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      ctx.moveTo(dot.x, dot.y);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }, []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    timeRef.current += 0.016;
    const t = timeRef.current;

    // Resize check
    if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      if (statusRef.current) {
        buildCronDots(canvas, statusRef.current.crons);
      }
    }

    // Background
    if (transparent) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Grid
    drawGrid(ctx, canvas);

    // Connection lines
    drawConnectionLines(ctx, canvas, t);

    // Particles
    drawParticles(ctx);

    // Cron ring dots
    drawCronRing(ctx, t);

    // Category labels
    drawCategoryLabels(ctx, canvas);

    // Center hub
    drawHub(ctx, canvas, t);

    // Bottom metrics
    drawMetricsTicker(ctx, canvas);

    // Alert banner
    drawAlertBanner(ctx, canvas);

    // Spawn particles occasionally
    if (Math.random() < 0.08 && statusRef.current) {
      spawnParticles(canvas);
    }

    animFrameRef.current = requestAnimationFrame(render);
  }, [transparent, buildCronDots, drawGrid, drawConnectionLines, drawParticles, drawCronRing, drawCategoryLabels, drawHub, drawMetricsTicker, drawAlertBanner, spawnParticles]);

  // Mouse hover for tooltips
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hit = cronDotsRef.current.find(dot => {
      const dx = mx - dot.x;
      const dy = my - dot.y;
      return Math.sqrt(dx * dx + dy * dy) < 14;
    });

    if (hit) {
      tooltipRef.current = { x: e.clientX, y: e.clientY, job: hit.job };
      setTooltip({ x: e.clientX, y: e.clientY, job: hit.job });
    } else {
      tooltipRef.current = null;
      setTooltip(null);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Initial fetch
    fetchStatus().then(() => {
      if (statusRef.current && canvas) {
        buildCronDots(canvas, statusRef.current.crons);
      }
    });

    // Poll every 10s
    const pollInterval = setInterval(() => {
      fetchStatus().then(() => {
        if (statusRef.current && canvas) {
          buildCronDots(canvas, statusRef.current.crons);
        }
      });
    }, 10000);

    // Start render loop
    animFrameRef.current = requestAnimationFrame(render);

    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      clearInterval(pollInterval);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [fetchStatus, buildCronDots, render, handleMouseMove]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: transparent ? 'transparent' : '#0a0a0a', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 12,
            top: tooltip.y - 8,
            background: 'rgba(19,19,19,0.95)',
            border: `1px solid ${STATUS_COLORS[tooltip.job.lastStatus || 'unknown']}`,
            borderRadius: 6,
            padding: '8px 12px',
            pointerEvents: 'none',
            fontFamily: 'monospace',
            fontSize: 12,
            color: '#F8F8F8',
            zIndex: 100,
            minWidth: 180,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4, color: STATUS_COLORS[tooltip.job.lastStatus || 'unknown'] }}>
            {tooltip.job.name}
          </div>
          <div style={{ color: 'rgba(248,248,248,0.6)', fontSize: 11 }}>
            Category: {tooltip.job.category || 'Unknown'}
          </div>
          <div style={{ color: 'rgba(248,248,248,0.6)', fontSize: 11 }}>
            Status: <span style={{ color: STATUS_COLORS[tooltip.job.lastStatus || 'unknown'] }}>
              {(tooltip.job.lastStatus || 'unknown').toUpperCase()}
            </span>
          </div>
          {tooltip.job.schedule && (
            <div style={{ color: 'rgba(248,248,248,0.6)', fontSize: 11 }}>
              Schedule: {tooltip.job.schedule}
            </div>
          )}
          {tooltip.job.lastRun && (
            <div style={{ color: 'rgba(248,248,248,0.6)', fontSize: 11 }}>
              Last run: {new Date(tooltip.job.lastRun).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Font preload */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { overflow: hidden; background: #0a0a0a; }
      `}</style>
    </div>
  );
}
