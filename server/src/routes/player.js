import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireScreen } from '../auth.js';
import { buildManifest } from '../manifest.js';
import { HttpError, isUuid, pairingCode, randomToken, sha256, timingSafeEqualStr, uuid } from '../util.js';

export const player = express.Router();

/** A new, unpaired player asks for a code to show on screen. */
player.post('/pairing', async (_req, res) => {
  // Drop stale requests so codes can be reused.
  await query('DELETE FROM pairing_requests WHERE expires_at < $1', [new Date(Date.now() - 86400_000)]);
  let code;
  for (let i = 0; i < 10; i++) {
    code = pairingCode();
    const { rowCount } = await query(
      'SELECT 1 FROM pairing_requests WHERE code = $1 AND screen_id IS NULL AND expires_at > now()',
      [code],
    );
    if (!rowCount) break;
  }
  const id = uuid();
  const secret = randomToken(24);
  const expiresAt = new Date(Date.now() + config.pairingTtlMinutes * 60_000);
  await query('INSERT INTO pairing_requests (id, code, secret_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    id,
    code,
    sha256(secret),
    expiresAt,
  ]);
  res.status(201).json({ pairingId: id, code, secret, expiresAt });
});

/** The player polls this until an admin has entered its code. The token is handed over exactly once. */
player.get('/pairing/:id', async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) throw new HttpError(404, 'Unknown pairing request');
  const { rows } = await query('SELECT * FROM pairing_requests WHERE id = $1', [id]);
  const pr = rows[0];
  if (!pr || !timingSafeEqualStr(sha256(req.get('x-pairing-secret') || ''), pr.secret_hash)) {
    throw new HttpError(404, 'Unknown pairing request');
  }
  if (pr.screen_id && pr.device_token) {
    await query('UPDATE pairing_requests SET device_token = NULL WHERE id = $1', [id]);
    return res.json({ status: 'paired', token: pr.device_token, screenId: pr.screen_id });
  }
  if (pr.screen_id) return res.json({ status: 'claimed' });
  if (new Date(pr.expires_at) < new Date()) return res.json({ status: 'expired' });
  res.json({ status: 'pending', expiresAt: pr.expires_at });
});

/** Everything the screen should play. Also serves as the polling heartbeat. */
player.get('/manifest', requireScreen, async (req, res) => {
  await query('UPDATE screens SET last_seen_at = now(), last_ip = $2, user_agent = $3 WHERE id = $1', [
    req.screen.id,
    req.get('x-forwarded-for')?.split(',')[0].trim() || req.socket.remoteAddress,
    req.get('user-agent')?.slice(0, 300) || null,
  ]);
  const manifest = await buildManifest(req.screen);
  res.set('Cache-Control', 'no-store');
  if (req.get('if-none-match') === `"${manifest.version}"`) return res.status(304).end();
  res.set('ETag', `"${manifest.version}"`);
  res.json(manifest);
});
