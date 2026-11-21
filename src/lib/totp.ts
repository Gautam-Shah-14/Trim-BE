/**
 * RFC 6238 TOTP implementation using only built-in Node crypto.
 * Compatible with Google Authenticator / Authy (HMAC-SHA1, 6 digits, 30s window).
 */
import { createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const DIGITS = 6;
const PERIOD = 30; // seconds
const ALGO = 'sha1';

/** Generate a random 20-byte TOTP secret, returned as base32. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Build the otpauth:// URI for QR codes. */
export function otpAuthUrl(secret: string, email: string, issuer = 'Trim'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

/** Verify a TOTP code, allowing a 1-step window in each direction for clock skew. */
export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let offset = -1; offset <= 1; offset++) {
    const counter = Math.floor((now + offset * PERIOD) / PERIOD);
    if (generateHotp(secret, counter) === code) return true;
  }
  return false;
}

function generateHotp(base32Secret: string, counter: number): string {
  const key = base32Decode(base32Secret);
  const buf = Buffer.alloc(8);
  // big-endian 64-bit counter
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac(ALGO, key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

// ---- base32 (RFC 4648) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const cleaned = s.toUpperCase().replace(/[=\s]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---- AES-256-GCM encryption for MFA secrets ----
/** Encrypt a plaintext string. Returns `iv:authTag:ciphertext` all hex-encoded. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Decrypt a string produced by encryptSecret. */
export function decryptSecret(encrypted: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  const [ivHex, tagHex, ctHex] = encrypted.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Invalid encrypted secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(ctHex, 'hex', 'utf8') + decipher.final('utf8');
}

/** Generate n random alphanumeric backup codes. */
export function generateBackupCodes(n = 8): string[] {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) code += chars[bytes[j]! % chars.length];
    codes.push(code);
  }
  return codes;
}
