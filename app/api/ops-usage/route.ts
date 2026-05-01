import { NextResponse } from 'next/server';

const CC_URL = process.env.CC_API_URL || process.env.NEXT_PUBLIC_CC_API_URL || 'https://eb-command-center.vercel.app';

export interface DailyUsage {
  date: string;
  total: number;
  models?: Record<string, number>;
}

export interface OpsUsageData {
  daily: DailyUsage[];
  mtdTotal: number;
  todayTotal: number;
  topModels: Array<{ model: string; cost: number; tasks?: number }>;
}

export async function GET() {
  try {
    const res = await fetch(`${CC_URL}/api/ops-usage`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) throw new Error(`CC returned ${res.status}`);

    const data = await res.json() as Partial<OpsUsageData>;

    const response: OpsUsageData = {
      daily:      Array.isArray(data.daily)      ? data.daily      : [],
      mtdTotal:   typeof data.mtdTotal   === 'number' ? data.mtdTotal   : 0,
      todayTotal: typeof data.todayTotal === 'number' ? data.todayTotal : 0,
      topModels:  Array.isArray(data.topModels)  ? data.topModels  : [],
    };

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    const empty: OpsUsageData = {
      daily: [],
      mtdTotal: 0,
      todayTotal: 0,
      topModels: [],
    };
    return NextResponse.json(empty, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
