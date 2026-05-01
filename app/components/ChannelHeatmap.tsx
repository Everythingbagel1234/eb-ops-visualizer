'use client';

const AMBER     = '#F59E0B';
const AMBER_DIM = 'rgba(245,158,11,0.35)';

interface HeatInteraction {
  timestamp: number;   // unix ms
  source: string;      // 'slack' | 'cc' | 'gmail' | 'webchat' | 'cron'
  channel?: string;
}

interface ChannelHeatmapProps {
  interactions: HeatInteraction[];
}

const ROWS = [
  { key: 'slack',   label: 'SLACK',   color: AMBER },
  { key: 'cc',      label: 'CC',      color: '#22D3EE' },
  { key: 'gmail',   label: 'GMAIL',   color: '#60A5FA' },
  { key: 'webchat', label: 'WCHAT',   color: '#22C55E' },
  { key: 'cron',    label: 'CRON',    color: '#A78BFA' },
];

// 6am to 10pm = hours 6..21 → 16 columns
const START_HOUR = 6;
const END_HOUR   = 22;
const NUM_HOURS  = END_HOUR - START_HOUR;

function buildGrid(interactions: HeatInteraction[]) {
  const grid: Record<string, number[]> = {};
  ROWS.forEach(r => { grid[r.key] = Array(NUM_HOURS).fill(0); });

  for (const item of interactions) {
    const h = new Date(item.timestamp).getHours();
    if (h < START_HOUR || h >= END_HOUR) continue;
    const col = h - START_HOUR;
    const src = item.source;
    if (grid[src]) grid[src][col]++;
  }
  return grid;
}

export default function ChannelHeatmap({ interactions }: ChannelHeatmapProps) {
  const grid = buildGrid(interactions);
  const maxVal = Math.max(
    1,
    ...Object.values(grid).flatMap(row => row)
  );

  const hourLabels: string[] = [];
  for (let h = START_HOUR; h < END_HOUR; h += 4) {
    hourLabels.push(`${h > 12 ? h - 12 : h}${h >= 12 ? 'p' : 'a'}`);
  }

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ fontSize: 8, color: AMBER_DIM, letterSpacing: '0.2em', fontWeight: 700, marginBottom: 6 }}>
        CHANNEL HEATMAP
      </div>

      {/* Hour axis */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `36px repeat(${NUM_HOURS}, 1fr)`,
        gap: 1,
        marginBottom: 4,
      }}>
        <div />
        {Array.from({ length: NUM_HOURS }, (_, i) => {
          const h = i + START_HOUR;
          const show = h % 4 === 0;
          return (
            <div key={i} style={{
              fontSize: 6, color: show ? 'rgba(245,158,11,0.4)' : 'transparent',
              textAlign: 'center', lineHeight: 1,
            }}>
              {show ? `${h > 12 ? h - 12 : h}${h >= 12 ? 'p' : 'a'}` : ''}
            </div>
          );
        })}
      </div>

      {/* Grid rows */}
      {ROWS.map(row => (
        <div
          key={row.key}
          style={{
            display: 'grid',
            gridTemplateColumns: `36px repeat(${NUM_HOURS}, 1fr)`,
            gap: 1,
            marginBottom: 2,
          }}
        >
          <div style={{
            fontSize: 7, color: row.color, fontWeight: 600,
            display: 'flex', alignItems: 'center',
            letterSpacing: '0.04em',
          }}>
            {row.label}
          </div>
          {grid[row.key].map((count, col) => {
            const alpha = count === 0 ? 0.06 : Math.min(0.9, 0.2 + (count / maxVal) * 0.7);
            return (
              <div
                key={col}
                title={`${row.label} ${col + START_HOUR}:00 — ${count} events`}
                style={{
                  height: 10,
                  borderRadius: 1,
                  background: `${row.color}`,
                  opacity: alpha,
                  transition: 'opacity 0.3s',
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
