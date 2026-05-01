'use client';

import type { OpsUsageData } from '../api/ops-usage/route';

interface TokenBurnRateProps {
  data: OpsUsageData | null;
}

const AMBER   = '#F59E0B';
const AMBER_DIM = 'rgba(245,158,11,0.35)';
const GOLD    = '#FCD34D';
const CYAN    = '#22D3EE';
const GREEN   = '#22C55E';
const PURPLE  = '#A78BFA';
const GRAY    = '#6B7280';

const MODEL_COLORS: Record<string, string> = {
  Opus:   AMBER,
  Sonnet: CYAN,
  Haiku:  GREEN,
  GPT:    PURPLE,
  Other:  GRAY,
};

function fmt$(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1)    return `$${n.toFixed(2)}`;
  return `$${(n * 100).toFixed(1)}¢`;
}

function fmtDay(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return dateStr.slice(5); }
}

export default function TokenBurnRate({ data }: TokenBurnRateProps) {
  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: AMBER_DIM, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>
        LOADING USAGE DATA…
      </div>
    );
  }

  const { daily, mtdTotal, todayTotal, topModels } = data;
  const last7 = daily.slice(-7);
  const maxDay = Math.max(...last7.map(d => d.total), 0.001);

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", color: AMBER, display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 8, letterSpacing: '0.2em', color: AMBER_DIM, fontWeight: 700 }}>TOKEN BURN RATE</span>
      </div>

      {/* Today + MTD totals */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{
          flex: 1, padding: '10px 12px',
          background: 'rgba(245,158,11,0.06)',
          border: '1px solid rgba(245,158,11,0.2)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 7.5, color: AMBER_DIM, letterSpacing: '0.15em', marginBottom: 4 }}>TODAY</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: GOLD, textShadow: `0 0 12px ${AMBER}` }}>
            {fmt$(todayTotal)}
          </div>
        </div>
        <div style={{
          flex: 1, padding: '10px 12px',
          background: 'rgba(245,158,11,0.04)',
          border: '1px solid rgba(245,158,11,0.15)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 7.5, color: AMBER_DIM, letterSpacing: '0.15em', marginBottom: 4 }}>MTD</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: AMBER }}>
            {fmt$(mtdTotal)}
          </div>
        </div>
      </div>

      {/* 7-day bar chart */}
      {last7.length > 0 && (
        <div>
          <div style={{ fontSize: 7.5, color: AMBER_DIM, letterSpacing: '0.15em', marginBottom: 6 }}>LAST 7 DAYS</div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 48 }}>
            {last7.map((day, i) => {
              const pct = maxDay > 0 ? (day.total / maxDay) * 100 : 0;
              const isToday = i === last7.length - 1;
              return (
                <div key={day.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{
                    width: '100%',
                    height: `${Math.max(pct, 4)}%`,
                    background: isToday
                      ? `linear-gradient(to top, ${AMBER}, ${GOLD})`
                      : 'rgba(245,158,11,0.35)',
                    borderRadius: '2px 2px 0 0',
                    boxShadow: isToday ? `0 0 6px ${AMBER}66` : 'none',
                    transition: 'height 0.4s ease',
                  }} />
                  <span style={{ fontSize: 6, color: AMBER_DIM, whiteSpace: 'nowrap' }}>
                    {fmtDay(day.date)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Model breakdown */}
      {topModels.length > 0 && (
        <div>
          <div style={{ fontSize: 7.5, color: AMBER_DIM, letterSpacing: '0.15em', marginBottom: 6 }}>BY MODEL</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {topModels.map(m => {
              const color  = MODEL_COLORS[m.model] ?? GRAY;
              const pct    = mtdTotal > 0 ? (m.cost / mtdTotal) * 100 : 0;
              return (
                <div key={m.model} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: color, boxShadow: `0 0 4px ${color}`,
                        flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 9, color, fontWeight: 600 }}>{m.model}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {m.tasks !== undefined && (
                        <span style={{ fontSize: 8, color: AMBER_DIM }}>{m.tasks} tasks</span>
                      )}
                      <span style={{ fontSize: 9, color, fontWeight: 700 }}>{fmt$(m.cost)}</span>
                    </div>
                  </div>
                  <div style={{ height: 3, background: 'rgba(245,158,11,0.1)', borderRadius: 2 }}>
                    <div style={{
                      height: '100%',
                      width: `${pct}%`,
                      background: color,
                      borderRadius: 2,
                      opacity: 0.7,
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {topModels.length === 0 && daily.length === 0 && (
        <div style={{ textAlign: 'center', color: AMBER_DIM, fontSize: 9, padding: '8px 0' }}>
          NO USAGE DATA YET
        </div>
      )}
    </div>
  );
}
