import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { burnTime, hashPassword, verifyPassword } from './passwords.js';
import { HttpError, randomToken, sha256, timingSafeEqualStr, uuid } from './util.js';

const COOKIE = 'sinewave_session';
const SESSION_DAYS = 14;
let sessionSecret;

export const ROLES = ['super_admin', 'standard'];

/** Load (or create and persist) the secret used to sign session cookies, and make sure a super admin exists. */
export async function initAuth() {
  if (process.env.SESSION_SECRET) {
    sessionSecret = process.env.SESSION_SECRET;
  } else {
    const { rows } = await query("SELECT value FROM settings WHERE key = 'session_secret'");
    if (rows.length) {
      sessionSecret = rows[0].value;
    } else {
      sessionSecret = randomToken(48);
      await query("INSERT INTO settings (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING", [
        sessionSecret,
      ]);
    }
  }
  await bootstrapAdmin();
}

/**
 * First boot (no accounts yet): create a super admin from ADMIN_USERNAME / ADMIN_PASSWORD, so existing
 * installs keep signing in with the password they already use. After that ADMIN_PASSWORD is ignored.
 * RESET_ADMIN_PASSWORD is the way back in if every super admin password is lost.
 */
async function bootstrapAdmin() {
  const username = config.adminUsername;
  const reset = process.env.RESET_ADMIN_PASSWORD;
  if (reset) {
    const hash = await hashPassword(reset);
    const { rowCount } = await query(
      "UPDATE users SET password_hash = $2, role = 'super_admin' WHERE username = $1",
      [username, hash],
    );
    if (!rowCount) {
      await query("INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, 'super_admin')", [
        uuid(),
        username,
        hash,
      ]);
    }
    console.warn(`RESET_ADMIN_PASSWORD is set: reset the password for "${username}". Remove it and restart.`);
    return;
  }
  const { rows } = await query('SELECT count(*) AS n FROM users');
  if (Number(rows[0].n) > 0) return;
  await query("INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, 'super_admin')", [
    uuid(),
    username,
    await hashPassword(config.adminPassword),
  ]);
  console.log(`Created super admin "${username}" from ADMIN_PASSWORD. Add more people under Users in the dashboard.`);
  if (config.adminPassword === 'admin') {
    console.warn('WARNING: ADMIN_PASSWORD is not set, so the first account uses the password "admin". Change it in the dashboard.');
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

// Changes whenever the password does, so changing a password signs that account out everywhere.
const passwordVersion = (user) => sha256(user.password_hash).slice(0, 16);

export const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  lastLoginAt: u.last_login_at ?? null,
  createdAt: u.created_at,
});

/** The signed-in account for this request, read fresh from the database (so role changes apply at once). */
async function userFromRequest(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !timingSafeEqualStr(sign(payload), sig)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (!data.uid || data.exp < Date.now()) return null;
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [data.uid]);
  const user = rows[0];
  if (!user || data.pv !== passwordVersion(user)) return null;
  return user;
}

export function setSessionCookie(res, user) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp, pv: passwordVersion(user) })).toString('base64url');
  const attrs = [
    `${COOKIE}=${payload}.${sign(payload)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (config.secureCookies) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Slow down password guessing: at most 10 failed sign-ins per IP address in 15 minutes.
const failures = new Map();
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILS;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > FAIL_WINDOW_MS) failures.set(ip, { since: Date.now(), count: 1 });
  else f.count++;
}

export async function login(req, res) {
  const ip = req.ip || 'unknown';
  if (tooManyFailures(ip)) throw new HttpError(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) throw new HttpError(400, 'Enter your username and password');
  const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  const ok = user ? await verifyPassword(password, user.password_hash) : (await burnTime(password), false);
  if (!ok) {
    recordFailure(ip);
    throw new HttpError(401, 'Wrong username or password');
  }
  failures.delete(ip);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  setSessionCookie(res, user);
  res.json({ ok: true, user: publicUser(user) });
}

export function logout(_req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

/** Any signed-in account. */
export async function requireUser(req, _res, next) {
  const user = await userFromRequest(req);
  if (!user) return next(new HttpError(401, 'Not signed in'));
  req.user = user;
  next();
}

/** Only super admins. Use after requireUser. */
export function requireSuperAdmin(req, _res, next) {
  if (req.user?.role !== 'super_admin') return next(new HttpError(403, 'Only a super admin can do that'));
  next();
}

export async function sessionStatus(req, res) {
  const user = await userFromRequest(req);
  res.json({ signedIn: Boolean(user), user: user ? publicUser(user) : null });
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
