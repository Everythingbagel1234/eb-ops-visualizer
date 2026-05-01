import { NextResponse } from 'next/server';

const CC_URL = process.env.CC_API_URL || process.env.NEXT_PUBLIC_CC_API_URL || 'https://eb-command-center.vercel.app';

/* ─── Types ─────────────────────────────────────────────────── */
export interface CronJob {
  id?: string;
  name: string;
  schedule?: string;
  lastRun?: string;       // ISO timestamp
  lastRunAgo?: string;    // raw "33m ago"
  lastStatus?: 'ok' | 'error' | 'idle' | 'unknown';
  nextRun?: string;
  category?: string;
  model?: string;
}

export interface CommEntry {
  time: string;
  person: string;
  action: string;
  channel?: string;
  type: 'gabe' | 'team' | 'system';
}

export interface GapStatus {
  gap: string;
  num: number;
  status: 'clean' | 'warning' | 'critical';
  note?: string;
}

export interface SecurityData {
  gapStatuses: GapStatus[];
  activeThreats: number;
  lastAudit: string;
  highItems: string[];
}

export interface FreshnessEntry {
  platform: string;
  abbrev: string;
  lastSync?: string;
  daysStale: number;
}

export interface StatusResponse {
  gateway: { healthy: boolean; status: string; version?: string };
  crons: CronJob[];
  sessions: { active: number; list: string[] };
  errors: number;
  timestamp: string;
  recentComms: CommEntry[];
  security: SecurityData;
  dataFreshness: FreshnessEntry[];
}

/* ─── Helper ─────────────────────────────────────────────────── */
function categorize(name: string): string {
  const n = name.toLowerCase();
  if (/meta|google ads|tiktok|klaviyo|amazon|shopify|creative thumb/.test(n)) return 'Data Connectors';
  if (/mid-month|weekly team|portfolio health/.test(n)) return 'Scheduled Reports';
  if (/bi agent|security agent|kpi agent|email super|ad super|growth intelligence/.test(n)) return 'Core Agents';
  if (/asana|slack|email inbox|dashboard|roundup|cro agent|bd lead|meeting intel|operator intel|push status/.test(n)) return 'Operations';
  return 'Monitoring';
}

function defaultSecurity(): SecurityData {
  return {
    gapStatuses: [],
    activeThreats: 0,
    lastAudit: new Date().toISOString(),
    highItems: [],
  };
}

function defaultResponse(): StatusResponse {
  return {
    gateway: { healthy: false, status: 'offline' },
    crons: [],
    sessions: { active: 0, list: [] },
    errors: 0,
    timestamp: new Date().toISOString(),
    recentComms: [],
    security: defaultSecurity(),
    dataFreshness: [],
  };
}

/* ─── Route ─────────────────────────────────────────────────── */
export async function GET() {
  try {
    const res = await fetch(`${CC_URL}/api/ops-status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) throw new Error(`CC returned ${res.status}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cc = await res.json() as any;

    const crons: CronJob[] = (Array.isArray(cc.crons) ? cc.crons : []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (job: any): CronJob => ({
        id:         String(job.id         ?? ''),
        name:       String(job.name       ?? 'unknown'),
        schedule:   String(job.schedule   ?? ''),
        lastRun:    String(job.lastRun    ?? ''),
        lastRunAgo: String(job.lastRunAgo ?? '-'),
        lastStatus: (['ok','error','idle','unknown'].includes(String(job.lastStatus).toLowerCase())
          ? String(job.lastStatus).toLowerCase()
          : 'unknown') as CronJob['lastStatus'],
        nextRun:    String(job.nextRun    ?? ''),
        model:      String(job.model      ?? ''),
        category:   String(job.category   ?? categorize(String(job.name ?? ''))),
      })
    );

    const response: StatusResponse = {
      gateway: {
        healthy: cc.gateway?.healthy ?? false,
        status:  cc.gateway?.status  ?? 'offline',
        version: cc.gateway?.version,
      },
      crons,
      sessions: {
        active: cc.sessions?.active ?? 0,
        list:   Array.isArray(cc.sessions?.list) ? cc.sessions.list : [],
      },
      errors:       cc.errors       ?? crons.filter(c => c.lastStatus === 'error').length,
      timestamp:    cc.timestamp    ?? new Date().toISOString(),
      recentComms:  Array.isArray(cc.recentComms) ? cc.recentComms : [],
      security:     cc.security     ?? defaultSecurity(),
      dataFreshness: Array.isArray(cc.dataFreshness) ? cc.dataFreshness : [],
    };

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return NextResponse.json(defaultResponse(), {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
