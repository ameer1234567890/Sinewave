import express from 'express';
import { requireSuperAdmin } from '../auth.js';
import { query } from '../db.js';
import { hub } from '../hub.js';
import {
  AutotaskError,
  clearSnapshot,
  getSettings,
  loadSnapshot,
  mode,
  normalizeSettings,
  picklists,
  publicSettings,
  refreshAutotask,
  saveSettings,
  testConnection,
  ticketContent,
} from '../autotask.js';
import { HttpError } from '../util.js';

export const integrations = express.Router();

/** Tell every screen that shows a ticket widget to fetch its content again. */
export async function notifyTicketScreens() {
  const { rows } = await query(
    `SELECT DISTINCT s.id FROM screens s JOIN playlist_items pi ON pi.playlist_id = s.playlist_id
       JOIN media m ON m.id = pi.media_id WHERE m.kind = 'autotask'`,
  );
  await hub.notifyScreens(rows.map((r) => r.id));
}

/** Make sure there is some data to show, e.g. right after the first widget is made. */
export async function ensureTicketData() {
  if (loadSnapshot()) return;
  try {
    await refreshAutotask();
  } catch {
    // The error is stored and shown in Settings; the widget waits for data meanwhile.
  }
}

// ---------- settings (super admins only) ----------

integrations.get('/integrations/autotask', requireSuperAdmin, (_req, res) => {
  res.json(publicSettings());
});

const secretFrom = (body) => (typeof body?.secret === 'string' && body.secret.trim() ? body.secret.trim().slice(0, 500) : null);

/** Try credentials from the form (anything left blank falls back to what is saved) without saving them. */
integrations.post('/integrations/autotask/test', requireSuperAdmin, async (req, res) => {
  const settings = normalizeSettings(req.body || {});
  const secret = secretFrom(req.body) || (await savedSecret());
  try {
    res.json(await testConnection(settings, secret));
  } catch (err) {
    if (err instanceof AutotaskError) throw new HttpError(400, err.message);
    throw err;
  }
});

async function savedSecret() {
  return query(`SELECT secret FROM integrations WHERE name = 'autotask'`).rows[0]?.secret || null;
}

integrations.put('/integrations/autotask', requireSuperAdmin, async (req, res) => {
  const before = getSettings();
  const settings = normalizeSettings(req.body || {}, before);
  const secret = secretFrom(req.body);
  const credentialsChanged =
    Boolean(secret) || settings.username !== before.username || settings.integrationCode !== before.integrationCode;

  // Check real credentials before saving them, so a typo can't silently break every widget.
  if (!settings.demo) {
    const useSecret = secret || (await savedSecret());
    if (!settings.username || !settings.integrationCode || !useSecret) {
      throw new HttpError(400, 'To use live Autotask data, enter the API username, secret and integration code');
    }
    if (credentialsChanged || !settings.zoneUrl) {
      try {
        Object.assign(settings, await testConnection(settings, useSecret));
      } catch (err) {
        if (err instanceof AutotaskError) throw new HttpError(400, err.message);
        throw err;
      }
      delete settings.queues;
      delete settings.statuses;
    }
  }
  saveSettings(settings, secret);

  const after = getSettings();
  const dataChanged =
    mode(before) !== mode(after) ||
    credentialsChanged ||
    JSON.stringify(before.closedStatuses) !== JSON.stringify(after.closedStatuses) ||
    before.timeZone !== after.timeZone;
  if (dataChanged) {
    // Don't leave demo numbers (or another account's) on screens after switching.
    clearSnapshot();
    await refreshAutotask().catch(() => {});
    await notifyTicketScreens();
  }
  res.json(publicSettings());
});

integrations.post('/integrations/autotask/refresh', requireSuperAdmin, async (_req, res) => {
  try {
    await refreshAutotask();
  } catch (err) {
    throw new HttpError(502, `Couldn't refresh: ${err.message}`);
  }
  await notifyTicketScreens();
  res.json(publicSettings());
});

// ---------- for the widget editor (any signed-in account) ----------

integrations.get('/autotask/picklists', async (_req, res) => {
  await ensureTicketData();
  res.json({ mode: mode(), ...picklists() });
});

/** The numbers a widget with these settings would show right now, for the editor's live preview. */
integrations.post('/autotask/preview', async (req, res) => {
  await ensureTicketData();
  res.json(ticketContent(req.body?.options || {}));
});
