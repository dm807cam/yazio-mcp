import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

/**
 * Hash a password as `scrypt$<saltHex>$<keyHex>`.
 * Used by the `hash-password` CLI so the plaintext never reaches disk or config.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time verification. Returns false for malformed hashes rather than throwing. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, saltHex, keyHex] = parts;

  let expected: Buffer;
  try {
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) {
    return false;
  }

  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEYLEN);
  return timingSafeEqual(actual, expected);
}
