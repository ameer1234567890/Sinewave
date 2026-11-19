import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError, randomToken, sha256, timingSafeEqualStr } from './util.js';

const COOKIE = 'sinewave_session';
const SESSION_DAYS = 14;
let sessionSecret;

/** Load (or create and persist) the secret used to sign admin session cookies. */
export async function initAuth() {
  if (process.env.SESSION_SECRET) {
    sessionSecret = process.env.SESSION_SECRET;
    return;
  }
  const { rows } = await query("SELECT value FROM settings WHERE key = 'session_secret'");
  if (rows.length) {
    sessionSecret = rows[0].value;
  } else {
    sessionSecret = randomToken(48);
    await query("INSERT INTO settings (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING", [
      sessionSecret,
    ]);
  }
  if (config.adminPassword === 'admin') {
    console.warn('WARNING: ADMIN_PASSWORD is not set, using the default "admin". Set it before exposing the server.');
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionFromRequest(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !timingSafeEqualStr(sign(payload), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    // Rotating the password invalidates existing sessions.
    if (data.pw !== sha256(config.adminPassword).slice(0, 16)) return null;
    return data;
  } catch {
    return null;
  }
}

export function login(req, res) {
  const { password } = req.body || {};
  if (!password || !timingSafeEqualStr(password, config.adminPassword)) {
    throw new HttpError(401, 'Wrong password');
  }
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = Buffer.from(JSON.stringify({ user: 'admin', exp, pw: sha256(config.adminPassword).slice(0, 16) })).toString(
    'base64url',
  );
  const attrs = [
    `${COOKIE}=${payload}.${sign(payload)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (config.secureCookies) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true });
}

export function logout(_req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

export function requireAdmin(req, _res, next) {
  const session = sessionFromRequest(req);
  if (!session) return next(new HttpError(401, 'Not signed in'));
  req.admin = session;
  next();
}

export function sessionStatus(req, res) {
  res.json({ signedIn: Boolean(sessionFromRequest(req)) });
}

/** Resolve a player device token (Bearer header or ?token=) to its screen row. */
export async function screenFromToken(token) {
  if (!token) return null;
  const { rows } = await query('SELECT * FROM screens WHERE token_hash = $1', [sha256(token)]);
  return rows[0] || null;
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

export async function requireScreen(req, _res, next) {
  const screen = await screenFromToken(bearer(req));
  if (!screen) return next(new HttpError(401, 'Unknown or revoked device token'));
  req.screen = screen;
  next();
}
