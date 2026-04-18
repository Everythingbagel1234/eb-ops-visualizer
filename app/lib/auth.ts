import { createHmac } from 'crypto';

const AUTH_SECRET = process.env.AUTH_SECRET || 'eb-jarvis-ops-2026-secret-key';

export function createToken(expiresAt: number): string {
  const payload = `${expiresAt}`;
  const sig = createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): boolean {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expectedSig = createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    if (sig !== expectedSig) return false;
    const expiresAt = parseInt(payload);
    return Date.now() < expiresAt;
  } catch {
    return false;
  }
}
