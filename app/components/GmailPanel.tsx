'use client';

const AMBER     = '#F59E0B';
const AMBER_DIM = 'rgba(245,158,11,0.35)';
const BLUE      = '#60A5FA';

export interface GmailThread {
  subject: string;
  from: string;
  date: string;
  snippet?: string;
}

interface GmailPanelProps {
  unreadCount: number;
  threads: GmailThread[];
}

function relativeTime(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch { return dateStr; }
}

export default function GmailPanel({ unreadCount, threads }: GmailPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{
        padding: '5px 14px 4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid rgba(245,158,11,0.12)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 8.5, fontWeight: 700, color: AMBER,
          letterSpacing: '0.2em',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          GMAIL
        </span>
        {unreadCount > 0 && (
          <span style={{
            background: BLUE,
            color: '#fff',
            fontSize: 8,
            fontWeight: 700,
            borderRadius: 8,
            padding: '1px 6px',
            fontFamily: "'JetBrains Mono', monospace",
            boxShadow: `0 0 6px ${BLUE}66`,
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </div>

      {/* Thread list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {threads.slice(0, 5).map((thread, i) => (
          <div
            key={i}
            style={{
              padding: '5px 14px',
              borderLeft: '2px solid rgba(96,165,250,0.25)',
              marginBottom: 1,
              cursor: 'default',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.05)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 2,
            }}>
              <span style={{
                fontSize: 9, fontWeight: 600, color: BLUE,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                flex: 1,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {thread.from}
              </span>
              <span style={{
                fontSize: 7.5, color: AMBER_DIM, flexShrink: 0, marginLeft: 6,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {relativeTime(thread.date)}
              </span>
            </div>
            <div style={{
              fontSize: 9, color: 'rgba(245,158,11,0.75)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {thread.subject || '(no subject)'}
            </div>
            {thread.snippet && (
              <div style={{
                fontSize: 8, color: AMBER_DIM, marginTop: 1,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {thread.snippet}
              </div>
            )}
          </div>
        ))}

        {threads.length === 0 && (
          <div style={{
            padding: '12px 14px',
            textAlign: 'center',
            color: AMBER_DIM,
            fontSize: 9,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {unreadCount === 0 ? 'INBOX CLEAR' : 'LOADING…'}
          </div>
        )}
      </div>
    </div>
  );
}
