'use client';

import { useEffect, useState } from 'react';
import type { UsageResponse } from '../api/usage/route';

const AMBER  = '#F59E0B';
const BG     = 'rgba(255,255,255,0.03)';
const BORDER = 'rgba(245,158,11,0.2)';
const MONO   = "'JetBrains Mono', monospace";

const MODEL_COLORS: Record<string, string> = {
  Opus:   '#F59E0B',
  Sonnet: '#22D3EE',
  Haiku:  '#22C55E',
  GPT:    '#A78BFA',
  Other:  '#6B7280',
};

function fmt$(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1)    return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface BarChartProps {
  data: { label: string; value: number; color: string }[];
  formatValue: (n: number) => string;
  label: string;
}

function BarChart({ data, formatValue, label }: BarChartProps) {
  const max = Math.max(...data.map(d => d.value), 0.0001);
  if (data.length === 0) return (
    <div style={{ color: 'rgba(245,158,11,0.35)', fontSize: 10, padding: '8px 0', fontFamily: MONO }}>
      NO DATA
    </div>
  );
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 8, color: AMBER, letterSpacing: '0.18em', marginBottom: 8, fontFamily: MONO, fontWeight: 700 }}>
        {label}
      </div>
      {data.map(({ label: lbl, value, color }) => (
        <div key={lbl} style={{ marginBottom: 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 9, color, fontFamily: MONO, fontWeight: 700 }}>{lbl}</span>
            <span style={{ fontSize: 9, color: 'rgba(245,158,11,0.7)', fontFamily: MONO }}>{formatValue(value)}</span>
          </div>
          <div style={{ height: 6, background: 'rgba(245,158,11,0.08)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${(value / max) * 100}%`,
              background: color,
              borderRadius: 3,
              boxShadow: `0 0 8px ${color}80`,
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function UsageChart() {
  const [data, setData]     = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [month, setMonth]   = useState<string>('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/usage', { signal: controller.signal })
      .then(r => r.json() as Promise<UsageResponse>)
      .then(d => {
        setData(d);
        // Default to current month if present, else latest
        const current = new Date().toISOString().slice(0, 7);
        if (d.months.includes(current)) setMonth(current);
        else if (d.months.length > 0) setMonth(d.months[d.months.length - 1]);
        setLoading(false);
      })
      .catch(e => {
        if (e.name !== 'AbortError') {
          setError('Failed to load usage data');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  if (loading) return (
    <div style={{ padding: 24, textAlign: 'center', fontFamily: MONO, color: 'rgba(245,158,11,0.5)', fontSize: 10 }}>
      <div style={{ marginBottom: 8 }}>◈ SCANNING SESSIONS…</div>
      <div style={{ fontSize: 8, color: 'rgba(245,158,11,0.3)' }}>This may take a moment</div>
    </div>
  );

  if (error || !data) return (
    <div style={{ padding: 16, fontFamily: MONO, color: '#EF4444', fontSize: 10 }}>
      {error || 'No data'}
    </div>
  );

  const monthData = data.byMonth[month] ?? {};
  const models    = Object.keys(monthData).sort();

  const costBars  = models.map(m => ({ label: m, value: monthData[m].cost,   color: MODEL_COLORS[m] ?? '#6B7280' }));
  const taskBars  = models.map(m => ({ label: m, value: monthData[m].tasks,  color: MODEL_COLORS[m] ?? '#6B7280' }));
  const tokenBars = models.map(m => ({ label: m, value: monthData[m].tokens, color: MODEL_COLORS[m] ?? '#6B7280' }));

  const monthCost  = models.reduce((s, m) => s + monthData[m].cost,  0);
  const monthTasks = models.reduce((s, m) => s + monthData[m].tasks, 0);
  const costPerTask = monthTasks > 0 ? monthCost / monthTasks : 0;

  // All-time table rows
  const allModels = Object.keys(data.totals).sort();

  return (
    <div style={{ fontFamily: MONO, color: AMBER }}>

      {/* Section header */}
      <div style={{
        fontSize: 8.5, letterSpacing: '0.22em', fontWeight: 700, color: AMBER,
        textShadow: `0 0 8px ${AMBER}`, marginBottom: 14,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        💰 LLM USAGE TRACKER
        <span style={{ fontSize: 7, color: 'rgba(245,158,11,0.4)', letterSpacing: '0.1em', fontWeight: 400 }}>
          · {data.months.length} MONTHS · {data.grandTotal.tasks.toLocaleString()} TOTAL TASKS
        </span>
      </div>

      {/* Month selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {data.months.map(m => (
          <button key={m} onClick={() => setMonth(m)} style={{
            padding: '4px 10px',
            background: m === month ? 'rgba(245,158,11,0.18)' : 'transparent',
            border: `1px solid ${m === month ? 'rgba(245,158,11,0.5)' : 'rgba(245,158,11,0.15)'}`,
            borderRadius: 20, cursor: 'pointer',
            fontSize: 9, color: m === month ? AMBER : 'rgba(245,158,11,0.45)',
            fontFamily: MONO, letterSpacing: '0.1em',
            transition: 'all 0.15s',
          }}>
            {m}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { label: 'MONTH COST',      value: fmt$(monthCost) },
          { label: 'MONTH TASKS',     value: monthTasks.toLocaleString() },
          { label: 'COST / TASK',     value: fmt$(costPerTask) },
        ].map(({ label, value }) => (
          <div key={label} style={{
            background: BG, border: `1px solid ${BORDER}`, borderRadius: 8,
            padding: '10px 12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 7, color: 'rgba(245,158,11,0.45)', letterSpacing: '0.15em', marginBottom: 5 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: AMBER, textShadow: `0 0 10px ${AMBER}50` }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Bar charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px' }}>
          <BarChart data={costBars}  formatValue={fmt$}  label="COST BY MODEL" />
        </div>
        <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px' }}>
          <BarChart data={taskBars}  formatValue={n => n.toLocaleString()} label="TASKS BY MODEL" />
        </div>
      </div>

      {/* Token chart — full width */}
      {tokenBars.length > 0 && (
        <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
          <BarChart data={tokenBars} formatValue={fmtK} label="TOKENS BY MODEL" />
        </div>
      )}

      {/* All-time totals table */}
      <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', borderBottom: `1px solid ${BORDER}` }}>
          <span style={{ fontSize: 7.5, letterSpacing: '0.18em', fontWeight: 700, color: AMBER }}>ALL-TIME TOTALS</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid rgba(245,158,11,0.1)` }}>
                {['MODEL', 'TOTAL COST', 'TOTAL TASKS', 'AVG $/TASK'].map(h => (
                  <th key={h} style={{ padding: '7px 14px', textAlign: 'left', color: 'rgba(245,158,11,0.5)', fontWeight: 700, letterSpacing: '0.1em', fontSize: 7.5, fontFamily: MONO }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allModels.map((m, i) => {
                const { cost, tasks } = data.totals[m];
                const avg = tasks > 0 ? cost / tasks : 0;
                const color = MODEL_COLORS[m] ?? '#6B7280';
                return (
                  <tr key={m} style={{ borderBottom: i < allModels.length - 1 ? `1px solid rgba(245,158,11,0.06)` : 'none', background: i % 2 === 0 ? 'transparent' : 'rgba(245,158,11,0.02)' }}>
                    <td style={{ padding: '7px 14px', color, fontWeight: 700 }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 7, boxShadow: `0 0 5px ${color}` }} />
                      {m}
                    </td>
                    <td style={{ padding: '7px 14px', color: 'rgba(245,158,11,0.8)' }}>{fmt$(cost)}</td>
                    <td style={{ padding: '7px 14px', color: 'rgba(245,158,11,0.8)' }}>{tasks.toLocaleString()}</td>
                    <td style={{ padding: '7px 14px', color: 'rgba(245,158,11,0.6)' }}>{fmt$(avg)}</td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: `1px solid rgba(245,158,11,0.2)`, background: 'rgba(245,158,11,0.05)' }}>
                <td style={{ padding: '8px 14px', color: AMBER, fontWeight: 700 }}>GRAND TOTAL</td>
                <td style={{ padding: '8px 14px', color: AMBER, fontWeight: 700 }}>{fmt$(data.grandTotal.cost)}</td>
                <td style={{ padding: '8px 14px', color: AMBER, fontWeight: 700 }}>{data.grandTotal.tasks.toLocaleString()}</td>
                <td style={{ padding: '8px 14px', color: 'rgba(245,158,11,0.6)' }}>
                  {data.grandTotal.tasks > 0 ? fmt$(data.grandTotal.cost / data.grandTotal.tasks) : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ padding: '6px 14px', borderTop: `1px solid rgba(245,158,11,0.08)`, fontSize: 7, color: 'rgba(245,158,11,0.25)', letterSpacing: '0.1em' }}>
          Generated: {new Date(data.generatedAt).toLocaleString()} · Cached 5 min
        </div>
      </div>
    </div>
  );
}
