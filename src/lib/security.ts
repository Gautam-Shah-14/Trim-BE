import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const newNonce = () => randomBytes(12).toString('base64url');
export const newId = () => randomUUID();

export function makePasswordHasher(memoryKib: number) {
  const opts = { type: argon2.argon2id, memoryCost: memoryKib, timeCost: 2, parallelism: 1 } as const;
  return {
    hash: (plain: string) => argon2.hash(plain, opts),
    async verify(hash: string, plain: string): Promise<boolean> {
      try {
        return await argon2.verify(hash, plain);
      } catch {
        return false;
      }
    },
  };
}
export type PasswordHasher = ReturnType<typeof makePasswordHasher>;

export interface AccessClaims {
  sub: string;
  role: string;
  sid: string;
}

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

export function signAccess(secret: string, claims: AccessClaims): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS });
}

export function verifyAccess(secret: string, token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.role !== 'string') return null;
    return { sub: p.sub, role: p.role, sid: p.sid };
  } catch {
    return null;
  }
}

/** ≥8 chars, at least one letter and one digit */
export const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
