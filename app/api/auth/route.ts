import { NextResponse } from 'next/server';
import { createToken } from '@/app/lib/auth';

export const dynamic = 'force-dynamic';

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'ebops2026').trim();

export async function POST(request: Request) {
  try {
    const body = await request.json() as { password?: string };
    const { password } = body;

    if (!password || password.trim() !== ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    // 30 days
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const token = createToken(expiresAt);

    return NextResponse.json({ token, expiresAt });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
