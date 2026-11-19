import express from 'express';
import { ROLES, publicUser, requireSuperAdmin, setSessionCookie } from '../auth.js';
import { query, withTransaction } from '../db.js';
import { checkNewPassword, hashPassword, verifyPassword } from '../passwords.js';
import { HttpError, isUuid, uuid } from '../util.js';

export const users = express.Router();

function cleanUsername(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(s)) {
    throw new HttpError(400, 'Usernames can use letters, numbers, dots, dashes, underscores and @ (up to 64 characters)');
  }
  return s;
}

function cleanRole(v) {
  if (!ROLES.includes(v)) throw new HttpError(400, 'Role must be super_admin or standard');
  return v;
}

function validPassword(v) {
  const problem = checkNewPassword(v);
  if (problem) throw new HttpError(400, problem);
  return v;
}

const isUniqueError = (err) => /UNIQUE constraint failed/i.test(err?.message || '');

async function findUser(req) {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'User not found');
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'User not found');
  return rows[0];
}

// ---------- Your own account (any role) ----------

users.get('/account', (req, res) => {
  res.json(publicUser(req.user));
});

users.post('/account/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await verifyPassword(String(currentPassword || ''), req.user.password_hash))) {
    throw new HttpError(400, 'Your current password is wrong');
  }
  const hash = await hashPassword(validPassword(newPassword));
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hash]);
  // Other devices are signed out; keep this one signed in.
  setSessionCookie(res, { ...req.user, password_hash: hash });
  res.json({ ok: true });
});

// ---------- Managing accounts (super admin only) ----------

users.get('/users', requireSuperAdmin, async (_req, res) => {
  const { rows } = await query('SELECT * FROM users ORDER BY username');
  res.json(rows.map(publicUser));
});

users.post('/users', requireSuperAdmin, async (req, res) => {
  const username = cleanUsername(req.body?.username);
  const role = cleanRole(req.body?.role ?? 'standard');
  const hash = await hashPassword(validPassword(req.body?.password));
  const id = uuid();
  try {
    await query('INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)', [id, username, hash, role]);
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, `There is already a user called ${username}`);
    throw err;
  }
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  res.status(201).json(publicUser(rows[0]));
});

users.patch('/users/:id', requireSuperAdmin, async (req, res) => {
  const user = await findUser(req);
  const body = req.body || {};
  const username = body.username !== undefined ? cleanUsername(body.username) : undefined;
  const role = body.role !== undefined ? cleanRole(body.role) : undefined;
  const hash = body.password !== undefined ? await hashPassword(validPassword(body.password)) : undefined;
  if (username === undefined && role === undefined && hash === undefined) throw new HttpError(400, 'Nothing to update');
  try {
    withTransaction((client) => {
      if (role === 'standard' && user.role === 'super_admin') {
        const { rows } = client.query("SELECT count(*) AS n FROM users WHERE role = 'super_admin'");
        if (Number(rows[0].n) <= 1) throw new HttpError(400, 'There must always be at least one super admin');
      }
      if (username !== undefined) client.query('UPDATE users SET username = $2 WHERE id = $1', [user.id, username]);
      if (role !== undefined) client.query('UPDATE users SET role = $2 WHERE id = $1', [user.id, role]);
      if (hash !== undefined) client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hash]);
    });
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, `There is already a user called ${username}`);
    throw err;
  }
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [user.id]);
  // Changing your own password here shouldn't sign you out.
  if (hash !== undefined && user.id === req.user.id) setSessionCookie(res, rows[0]);
  res.json(publicUser(rows[0]));
});

users.delete('/users/:id', requireSuperAdmin, async (req, res) => {
  const user = await findUser(req);
  if (user.id === req.user.id) throw new HttpError(400, "You can't delete your own account");
  withTransaction((client) => {
    if (user.role === 'super_admin') {
      const { rows } = client.query("SELECT count(*) AS n FROM users WHERE role = 'super_admin'");
      if (Number(rows[0].n) <= 1) throw new HttpError(400, 'There must always be at least one super admin');
    }
    client.query('DELETE FROM users WHERE id = $1', [user.id]);
  });
  res.status(204).end();
});
