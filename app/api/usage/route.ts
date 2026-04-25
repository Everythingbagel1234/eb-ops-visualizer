import { readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { NextResponse } from 'next/server';

export interface UsageResponse {
  months: string[];
  byMonth: {
    [month: string]: {
      [model: string]: {
        cost: number;
        tasks: number;
        tokens: number;
      };
    };
  };
  totals: {
    [model: string]: {
      cost: number;
      tasks: number;
    };
  };
  grandTotal: {
    cost: number;
    tasks: number;
  };
  generatedAt: string;
}

function normalizeModel(raw: string): string {
  const l = (raw || '').toLowerCase();
  if (l.includes('opus'))   return 'Opus';
  if (l.includes('sonnet')) return 'Sonnet';
  if (l.includes('haiku'))  return 'Haiku';
  if (l.includes('gpt'))    return 'GPT';
  return 'Other';
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.'))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

async function processFile(
  filePath: string,
  byMonth: UsageResponse['byMonth'],
): Promise<void> {
  try {
    const s = await stat(filePath);
    if (s.size > 50 * 1024 * 1024) return; // skip >50MB

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const msg = obj?.message;
        if (!msg || msg.role !== 'assistant') continue;
        const usage = msg.usage;
        if (!usage) continue;

        const costTotal = usage.cost?.total ?? 0;
        const tokens    = (usage.input ?? 0) + (usage.output ?? 0);
        if (costTotal === 0 && tokens === 0) continue;

        const ts  = obj.timestamp || msg.timestamp;
        if (!ts) continue;
        const month = (ts as string).slice(0, 7); // "YYYY-MM"

        const model = normalizeModel(msg.model || '');

        if (!byMonth[month]) byMonth[month] = {};
        if (!byMonth[month][model]) byMonth[month][model] = { cost: 0, tasks: 0, tokens: 0 };

        byMonth[month][model].cost   += costTotal;
        byMonth[month][model].tasks  += 1;
        byMonth[month][model].tokens += tokens;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip unreadable files
  }
}

const BATCH_SIZE = 50;

export async function GET() {
  const deadline = Date.now() + 25_000; // 25s hard limit
  const home = homedir();

  const dirs = [
    join(home, '.openclaw', 'agents', 'main',  'sessions'),
    join(home, '.openclaw', 'agents', 'claude', 'sessions'),
    join(home, '.openclaw', 'agents', 'team',   'sessions'),
  ];

  const allFiles: string[] = [];
  for (const dir of dirs) {
    const files = await listJsonlFiles(dir);
    allFiles.push(...files);
  }

  const byMonth: UsageResponse['byMonth'] = {};

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    if (Date.now() > deadline) break;
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(f => processFile(f, byMonth)));
  }

  // Build totals
  const totals: UsageResponse['totals'] = {};
  let grandCost  = 0;
  let grandTasks = 0;

  for (const month of Object.keys(byMonth)) {
    for (const [model, data] of Object.entries(byMonth[month])) {
      if (!totals[model]) totals[model] = { cost: 0, tasks: 0 };
      totals[model].cost  += data.cost;
      totals[model].tasks += data.tasks;
      grandCost  += data.cost;
      grandTasks += data.tasks;
    }
  }

  const months = Object.keys(byMonth).sort();

  const response: UsageResponse = {
    months,
    byMonth,
    totals,
    grandTotal: { cost: grandCost, tasks: grandTasks },
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'max-age=300, s-maxage=300' },
  });
}
