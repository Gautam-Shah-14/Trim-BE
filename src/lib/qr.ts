import { createHmac, timingSafeEqual } from 'node:crypto';

export interface QrPayload {
  /** booking id */
  b: string;
  /** salon id */
  s: string;
  /** qr nonce */
  n: string;
  /** expiry, unix seconds */
  e: number;
}

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function mac(secret: string, payloadPart: string): Buffer {
  return createHmac('sha256', secret).update(payloadPart).digest();
}

/** token = base64url(payload).base64url(hmac_sha256(QR_SECRET, base64url(payload))) */
export function signQr(secret: string, p: { bookingId: string; salonId: string; nonce: string; endsAt: Date }): string {
  const payload: QrPayload = {
    b: p.bookingId,
    s: p.salonId,
    n: p.nonce,
    e: Math.floor(p.endsAt.getTime() / 1000) + 60 * 60,
  };
  const part = b64u(JSON.stringify(payload));
  return `${part}.${b64u(mac(secret, part))}`;
}

export type QrVerify = { ok: true; payload: QrPayload } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyQr(secret: string, token: string, now: Date = new Date()): QrVerify {
  if (typeof token !== 'string' || token.length > 1024) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [part, sig] = parts as [string, string];
  const expected = mac(secret, part);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  let payload: QrPayload;
  try {
    payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as QrPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.b !== 'string' || typeof payload.s !== 'string' || typeof payload.n !== 'string' || typeof payload.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.e * 1000 < now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
