import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt with a random salt per password. The cost settings are stored in the hash so they can be raised later.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

// Used when a username doesn't exist, so a wrong username takes as long as a wrong password.
let dummyHash;
export async function burnTime(password) {
  dummyHash ||= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

export const MIN_PASSWORD_LENGTH = 8;

export function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) return 'Passwords can be at most 200 characters';
  return null;
}
