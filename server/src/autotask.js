/*
 * Autotask PSA connector for ticket widgets.
 *
 * The server polls the Autotask REST API every few minutes with an API user that a super admin
 * enters in Settings, keeps the last good copy of the ticket data in SQLite, and works out the
 * numbers each widget needs. Screens only ever get those numbers from Sinewave: they never talk
 * to Autotask and never see the credentials. Company names and ticket titles are removed on the
 * server for widgets set to hide private information, so they never reach those screens at all.
 *
 * With no credentials (or with "Use demo data" on), realistic made-up tickets are used instead,
 * so widgets can be tried out and laid out before Autotask is connected.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError } from './util.js';

// Layouts, tiles, settings and the renderer live in the player's autotask.js, shared with the dashboard.
export const Tickets = createRequire(import.meta.url)(path.join(config.playerDir, 'autotask.js'));

export const DEFAULT_WIDGET_SECONDS = 30;
const ZONE_LOOKUP_URL = process.env.AUTOTASK_ZONE_LOOKUP_URL || 'https://webservices.autotask.net/ATServicesRest/V1.0/zoneInformation';
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500; // the most Autotask returns per page
const MAX_TICKETS = 5000; // per query, so a huge backlog can't stall the server
const LOOKUP_MAX_AGE_MS = 60 * 60_000; // queues, statuses, resources and company names: hourly
const USER_AGENT = 'Sinewave/0.1 (digital signage; +https://github.com/elliottmarter/Sinewave)';

const TICKET_FIELDS = [
  'id', 'ticketNumber', 'title', 'status', 'priority', 'queueID', 'companyID', 'assignedResourceID',
  'createDate', 'completedDate', 'serviceLevelAgreementID', 'serviceLevelAgreementHasBeenMet',
  'firstResponseDueDateTime', 'firstResponseDateTime', 'resolutionPlanDueDateTime', 'resolutionPlanDateTime',
  'resolvedDueDateTime', 'resolvedDateTime',
];

// ---------- settings ----------

const serverTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const DEFAULT_SETTINGS = {
  demo: true, // made-up tickets until a super admin connects Autotask
  username: '',
  integrationCode: '',
  zoneUrl: '', // found from the username when the connection is tested
  zoneName: '',
  refreshMinutes: 2,
  closedStatuses: [5], // 5 is Autotask's built-in "Complete"
  timeZone: '', // for "today"; blank means the server's time zone
};

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function row() {
  return query(`SELECT * FROM integrations WHERE name = 'autotask'`).rows[0] || null;
}

export function getSettings() {
  const r = row();
  let saved = {};
  try {
    saved = r?.settings ? JSON.parse(r.settings) : {};
  } catch {}
  return { ...DEFAULT_SETTINGS, ...saved, hasSecret: Boolean(r?.secret) };
}

const getSecret = () => row()?.secret || null;

/** Clean up settings from the dashboard. Blank secret or integration code means "keep the saved one". */
export function normalizeSettings(input = {}, base = getSettings()) {
  const s = { ...base };
  delete s.hasSecret;
  if (input.demo !== undefined) s.demo = input.demo === true || input.demo === 'true' || input.demo === 'on';
  if (input.username !== undefined) {
    const u = String(input.username || '').trim().slice(0, 200);
    if (u !== s.username) {
      s.zoneUrl = '';
      s.zoneName = '';
    }
    s.username = u;
  }
  if (typeof input.integrationCode === 'string' && input.integrationCode.trim()) s.integrationCode = input.integrationCode.trim().slice(0, 200);
  if (input.refreshMinutes !== undefined) {
    const n = Math.round(Number(input.refreshMinutes));
    s.refreshMinutes = Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : s.refreshMinutes;
  }
  if (Array.isArray(input.closedStatuses)) {
    const ids = [...new Set(input.closedStatuses.map(Number).filter((n) => Number.isInteger(n) && n >= 0))];
    if (ids.length) s.closedStatuses = ids.slice(0, 50);
  }
  if (input.timeZone !== undefined) {
    const tz = String(input.timeZone || '').trim();
    if (tz && !isValidTimeZone(tz)) throw new HttpError(400, `Unknown time zone "${tz}". Use a name like Europe/London.`);
    s.timeZone = tz;
  }
  return s;
}

/** Settings for the dashboard. The secret is never sent back; the integration code only partly. */
export function publicSettings() {
  const s = getSettings();
  const r = row();
  const snap = loadSnapshot();
  const code = s.integrationCode || '';
  return {
    demo: s.demo,
    username: s.username,
    integrationCode: code ? `${'•'.repeat(Math.max(0, Math.min(code.length - 4, 12)))}${code.slice(-4)}` : '',
    hasIntegrationCode: Boolean(code),
    hasSecret: s.hasSecret,
    zoneUrl: s.zoneUrl,
    zoneName: s.zoneName,
    refreshMinutes: s.refreshMinutes,
    closedStatuses: s.closedStatuses,
    timeZone: s.timeZone,
    serverTimeZone: serverTimeZone(),
    configured: isConfigured(s),
    mode: mode(s),
    status: {
      fetchedAt: r?.fetched_at || null,
      checkedAt: r?.checked_at || null,
      error: r?.error || null,
      demoData: Boolean(snap?.demo),
      openTickets: snap ? snap.open.length : null,
      truncated: Boolean(snap?.truncated),
    },
    picklists: picklists(),
  };
}

const isConfigured = (s) => Boolean(s.username && s.integrationCode && s.hasSecret);
export const mode = (s = getSettings()) => (s.demo || !isConfigured(s) ? 'demo' : 'live');

export function saveSettings(settings, secret) {
  const json = JSON.stringify(settings);
  query(
    `INSERT INTO integrations (name, settings, secret, updated_at) VALUES ('autotask', $1, $2, now())
     ON CONFLICT (name) DO UPDATE SET settings = excluded.settings, secret = COALESCE($2, integrations.secret), updated_at = now()`,
    [json, secret || null],
  );
}

/** Forget the stored ticket data, e.g. when switching between demo data and a real Autotask. */
export function clearSnapshot() {
  query(`UPDATE integrations SET snapshot = NULL, fetched_at = NULL, checked_at = NULL, error = NULL WHERE name = 'autotask'`);
  snapshotCache = { key: null, value: null };
}

// ---------- talking to Autotask ----------

export class AutotaskError extends Error {}

function friendlyError(err) {
  if (err instanceof AutotaskError) return err.message;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'Autotask took too long to answer';
  const code = err.cause?.code || err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "Couldn't reach Autotask. Check the server's internet connection";
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'Autotask refused the connection';
  return err.message || 'Something went wrong talking to Autotask';
}

/** Turn an Autotask error reply into a sentence a person can act on. */
async function replyError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = (Array.isArray(body?.errors) ? body.errors : [body?.message || body?.Message]).filter(Boolean).join(' ');
  } catch {}
  if (res.status === 401) return new AutotaskError('Autotask rejected the API username or secret. Check them, and that the API user is active.');
  if (res.status === 403) return new AutotaskError(`Autotask refused access${detail ? `: ${detail}` : ''}. Check the API user's security level allows reading tickets.`);
  if (res.status === 429) return new AutotaskError('Autotask says too many requests were made. Sinewave will try again later.');
  if (/integration ?code|tracking identifier/i.test(detail)) return new AutotaskError(`Autotask rejected the integration code: ${detail}`);
  return new AutotaskError(`Autotask answered with an error (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
}

/** Find which Autotask data centre (zone) an API user lives in. */
export async function detectZone(username) {
  if (!username) throw new AutotaskError('Enter the API username first');
  let res;
  try {
    const url = `${ZONE_LOOKUP_URL}?user=${encodeURIComponent(username)}`;
    res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new AutotaskError(friendlyError(err));
  }
  if (res.status === 404 || res.status === 500) throw new AutotaskError("Autotask doesn't recognise that API username. It usually looks like name@yourcompany.com or a code ending in @....com");
  if (!res.ok) throw await replyError(res);
  const info = await res.json().catch(() => ({}));
  if (!info?.url) throw new AutotaskError("Autotask doesn't recognise that API username");
  let base;
  try {
    base = new URL(info.url);
  } catch {
    throw new AutotaskError('Autotask sent back a zone address Sinewave could not read');
  }
  if (base.protocol !== 'https:' && !process.env.AUTOTASK_ZONE_LOOKUP_URL) throw new AutotaskError('Autotask sent back a zone address that is not https');
  let href = base.toString();
  if (!href.endsWith('/')) href += '/';
  if (!/v1\.0\/$/i.test(href)) href += 'V1.0/';
  return { zoneUrl: href, zoneName: info.zoneName || base.hostname };
}

/** A small Autotask REST client for one API user. */
export function client({ zoneUrl, username, integrationCode, secret }) {
  const origin = new URL(zoneUrl).origin;
  const headers = {
    ApiIntegrationCode: integrationCode,
    UserName: username,
    Secret: secret,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  let requests = 0;

  async function call(url, { method = 'GET', body } = {}) {
    // Never send the credentials anywhere but the user's own Autotask zone.
    if (new URL(url).origin !== origin) throw new AutotaskError('Autotask pointed Sinewave at an unexpected address, so it stopped');
    requests++;
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new AutotaskError(friendlyError(err));
    }
    if (!res.ok) throw await replyError(res);
    return res.json();
  }

  return {
    get requests() {
      return requests;
    },
    /** Every record matching `filter`, following Autotask's pages, up to `max`. */
    async queryAll(entity, filter, fields, max = MAX_TICKETS) {
      const items = [];
      let page = await call(`${zoneUrl}${entity}/query`, { method: 'POST', body: { MaxRecords: PAGE_SIZE, IncludeFields: fields, filter } });
      for (;;) {
        items.push(...(page.items || []));
        const next = page.pageDetails?.nextPageUrl;
        if (!next || items.length >= max) return { items: items.slice(0, max), truncated: Boolean(next) || items.length > max };
        page = await call(next);
      }
    },
    /** The picklist values (id and label) of some of an entity's fields. */
    async picklists(entity, names) {
      const body = await call(`${zoneUrl}${entity}/entityInformation/fields`);
      const out = {};
      for (const f of body.fields || []) {
        if (!names.includes(f.name)) continue;
        out[f.name] = (f.picklistValues || [])
          .map((v) => ({ id: Number(v.value), name: String(v.label ?? v.value), active: v.isActive !== false, sort: Number(v.sortOrder) || 0 }))
          .filter((v) => Number.isInteger(v.id))
          .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      }
      return out;
    },
  };
}

/** Check a set of credentials works: find the zone, then read the ticket fields. */
export async function testConnection(settings, secret) {
  if (!settings.username || !settings.integrationCode || !secret) {
    throw new AutotaskError('Enter the API username, secret and integration code');
  }
  const zone = await detectZone(settings.username);
  const api = client({ ...settings, ...zone, secret });
  const lists = await api.picklists('Tickets', ['queueID', 'status', 'priority']);
  if (!lists.queueID && !lists.status) throw new AutotaskError("Connected, but Autotask didn't list any ticket queues or statuses");
  return { ...zone, queues: lists.queueID?.length || 0, statuses: lists.status?.length || 0 };
}

// ---------- dates ----------

/** Autotask sends UTC times, sometimes without a "Z". */
export function atDate(v) {
  if (!v) return null;
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Minutes a time zone is ahead of UTC at `ms`. */
function zoneOffset(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, Number(p.value)]),
  );
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000) / 60_000;
}

/** Midnight, `daysBack` days ago, in a time zone, as ms since the epoch. */
export function startOfDay(now, tz, daysBack = 0) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]),
  );
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day - daysBack);
  let ms = guess - zoneOffset(guess, tz) * 60_000;
  ms = guess - zoneOffset(ms, tz) * 60_000; // settle across a daylight saving change
  return ms;
}

// ---------- fetching ----------

/** Shrink an Autotask ticket to what widgets use. */
function compactTicket(t, names) {
  return {
    id: t.id,
    number: t.ticketNumber || String(t.id),
    title: String(t.title || '').slice(0, 200),
    status: t.status ?? null,
    priority: t.priority ?? null,
    queue: t.queueID ?? null,
    company: names.companies[t.companyID] || null,
    assignee: t.assignedResourceID ? names.resources[t.assignedResourceID] || 'Assigned' : null,
    created: atDate(t.createDate),
    completed: atDate(t.completedDate),
    sla: t.serviceLevelAgreementID ? true : false,
    slaMet: t.serviceLevelAgreementHasBeenMet ?? null,
    // [due, done] for first response, resolution plan and resolution.
    milestones: [
      [atDate(t.firstResponseDueDateTime), atDate(t.firstResponseDateTime)],
      [atDate(t.resolutionPlanDueDateTime), atDate(t.resolutionPlanDateTime)],
      [atDate(t.resolvedDueDateTime), atDate(t.resolvedDateTime)],
    ],
  };
}

/** Read everything widgets need from Autotask. `prev` is the last snapshot, for cached lookups. */
export async function fetchLive(settings, secret, prev, now = Date.now()) {
  let zone = settings.zoneUrl ? { zoneUrl: settings.zoneUrl, zoneName: settings.zoneName } : null;
  if (!zone) zone = await detectZone(settings.username);
  const api = client({ ...settings, ...zone, secret });
  const fresh = prev && !prev.demo && prev.lookupsAt && now - Date.parse(prev.lookupsAt) < LOOKUP_MAX_AGE_MS;

  let lists = fresh ? prev.picklists : null;
  let resources = fresh ? prev.resources : null;
  let companies = fresh ? { ...prev.companies } : {};
  if (!lists) {
    const p = await api.picklists('Tickets', ['queueID', 'status', 'priority']);
    lists = { queues: p.queueID || [], statuses: p.status || [], priorities: p.priority || [] };
  }
  if (!resources) {
    const { items } = await api.queryAll('Resources', [{ op: 'gte', field: 'id', value: 0 }], ['id', 'firstName', 'lastName'], 5000);
    resources = Object.fromEntries(items.map((r) => [r.id, `${r.firstName || ''} ${r.lastName || ''}`.trim() || `Resource ${r.id}`]));
  }

  const tz = settings.timeZone || serverTimeZone();
  const since = new Date(startOfDay(now, tz, 6)).toISOString();
  const closed = settings.closedStatuses?.length ? settings.closedStatuses : DEFAULT_SETTINGS.closedStatuses;
  const open = await api.queryAll('Tickets', [{ op: 'notIn', field: 'status', value: closed }], TICKET_FIELDS);
  const done = await api.queryAll('Tickets', [{ op: 'gte', field: 'completedDate', value: since }], TICKET_FIELDS);
  const created = await api.queryAll('Tickets', [{ op: 'gte', field: 'createDate', value: since }], ['id', 'createDate', 'queueID', 'priority', 'status']);

  // Company names for the hot list, looked up in batches and only for companies we don't know yet.
  const wanted = [...new Set([...open.items, ...done.items].map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];
  const missing = wanted.filter((id) => !(id in companies));
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200);
    const { items } = await api.queryAll('Companies', [{ op: 'in', field: 'id', value: batch }], ['id', 'companyName'], batch.length);
    for (const c of items) companies[c.id] = c.companyName || null;
    for (const id of batch) if (!(id in companies)) companies[id] = null;
  }
  const names = { companies, resources };

  return {
    demo: false,
    fetchedAt: new Date(now).toISOString(),
    lookupsAt: fresh ? prev.lookupsAt : new Date(now).toISOString(),
    zone,
    picklists: lists,
    resources,
    companies,
    closedStatuses: closed,
    timeZone: tz,
    truncated: open.truncated || done.truncated || created.truncated,
    open: open.items.filter((t) => !closed.includes(t.status)).map((t) => compactTicket(t, names)),
    closed: done.items.map((t) => compactTicket(t, names)),
    created: created.items.map((t) => ({ id: t.id, created: atDate(t.createDate), queue: t.queueID ?? null, priority: t.priority ?? null })),
    requests: api.requests,
  };
}

// ---------- demo data ----------

function seeded(seed) {
  let s = seed % 2147483647 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const DEMO = {
  queues: ['Service Desk', 'Level 2 Support', 'Projects', 'Monitoring Alerts', 'Escalations', 'Onboarding'],
  queueWeights: [0.38, 0.2, 0.1, 0.16, 0.06, 0.1],
  statuses: [[1, 'New'], [8, 'In Progress'], [7, 'Waiting Customer'], [12, 'Waiting Vendor'], [13, 'Escalated'], [5, 'Complete']],
  priorities: [[4, 'Critical'], [1, 'High'], [2, 'Medium'], [3, 'Low']],
  companies: ['Harbour Dental', 'Brightside Logistics', 'Oakfield Primary School', 'Kestrel Accounting', 'Meridian Estates', 'Lumen Architects', 'Riverside Vets', 'Copperleaf Foods', 'Northgate Legal', 'Bluebell Care Homes', 'Summit Engineering', 'Willow & Finch'],
  people: ['Sam Patel', 'Alex Morgan', 'Jordan Lee', 'Priya Shah', 'Chris Wood', 'Megan Hughes'],
  titles: [
    'Outlook keeps asking for password', 'New starter laptop setup', 'Printer offline on second floor', 'VPN drops every few minutes',
    'Backup job failed on FS01', 'Low disk space on SQL02', 'Teams calls are choppy', 'Reset MFA for a user', 'Firewall firmware update',
    'Shared mailbox permissions', 'Wi-Fi slow in the meeting room', 'Can’t open invoices in the finance app', 'Leaver: disable accounts',
    'Phone system not ringing through', 'Antivirus alert on reception PC', 'Website contact form not sending', 'Replace failing UPS battery',
    'Set up new Microsoft 365 licences', 'Server patching window', 'Scanner to email not working', 'Domain renewal reminder',
    'Laptop screen flickering', 'OneDrive not syncing', 'Install accounts software update',
  ],
};

/** Made-up but believable tickets. They drift a little on every refresh so screens look alive. */
export function demoSnapshot(now = Date.now(), tz = serverTimeZone()) {
  const bucket = Math.floor(now / 120_000);
  const rand = seeded(bucket * 7919 + 17);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const weighted = (weights) => {
    let r = rand();
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) return i;
    return weights.length - 1;
  };
  const queues = DEMO.queues.map((name, i) => ({ id: 29682800 + i, name, active: true }));
  const statuses = DEMO.statuses.map(([id, name]) => ({ id, name, active: true }));
  const priorities = DEMO.priorities.map(([id, name]) => ({ id, name, active: true }));
  const openStatuses = [1, 1, 8, 8, 8, 7, 7, 12, 13];
  const H = 3_600_000;
  let seq = 400;
  const ticket = (createdMs, openNow) => {
    const id = 81000 + seq++;
    const q = queues[weighted(DEMO.queueWeights)];
    const pr = priorities[weighted([0.06, 0.2, 0.5, 0.24])];
    const resolveHours = { 4: 4, 1: 8, 2: 24, 3: 48 }[pr.id];
    const ageMs = now - createdMs;
    // Most tickets stay within SLA (waiting on the customer pauses the clock); a few slip.
    const slips = rand() < (openNow ? 0.12 : 0.07);
    const firstDue = createdMs + (pr.id === 4 ? 0.25 : 1) * H;
    let resolveDue = createdMs + resolveHours * H;
    if (openNow && !slips && resolveDue < now + 20 * 60_000) resolveDue = now + (0.2 + rand() * 1.6) * Math.max(H, ageMs * 0.4);
    if (openNow && !slips && rand() < 0.07) resolveDue = now + (5 + rand() * 50) * 60_000; // due soon
    const d = new Date(createdMs);
    const number = `T${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}.${String(id % 10000).padStart(4, '0')}`;
    const responded = Math.min(createdMs + rand() * (slips ? 1.6 : 0.9) * (firstDue - createdMs), now);
    const assigned = rand() < (openNow ? 0.86 : 1);
    const t = {
      id,
      number,
      title: pick(DEMO.titles),
      status: openNow ? pick(openStatuses) : 5,
      priority: pr.id,
      queue: q.id,
      company: pick(DEMO.companies),
      assignee: assigned ? pick(DEMO.people) : null,
      created: new Date(createdMs).toISOString(),
      completed: null,
      sla: rand() < 0.9,
      slaMet: null,
      milestones: [
        [new Date(firstDue).toISOString(), responded && responded <= now ? new Date(responded).toISOString() : null],
        [null, null],
        [new Date(resolveDue).toISOString(), null],
      ],
    };
    if (!openNow) {
      const doneMs = Math.min(now - rand() * H, createdMs + (0.15 + rand() * (slips ? 1.6 : 0.8)) * resolveHours * H);
      t.completed = new Date(Math.max(doneMs, createdMs + 600_000)).toISOString();
      t.milestones[2][1] = t.completed;
      t.slaMet = t.sla ? Date.parse(t.completed) <= resolveDue && (!responded || responded <= firstDue) : null;
    }
    return t;
  };

  const weekStart = startOfDay(now, tz, 6);
  const open = [];
  const closed = [];
  const created = [];
  // About 55-65 open tickets of mixed ages, and a week of history with a busy Monday.
  const openCount = 55 + Math.floor(rand() * 10);
  for (let i = 0; i < openCount; i++) {
    const age = rand() < 0.55 ? rand() * 30 * H : rand() < 0.8 ? rand() * 5 * 24 * H : rand() * 20 * 24 * H;
    open.push(ticket(now - age, true));
  }
  for (let day = 6; day >= 0; day--) {
    const start = startOfDay(now, tz, day);
    const end = day === 0 ? now : startOfDay(now, tz, day - 1);
    const weekday = new Date(start + 12 * H).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const scale = (end - start) / (24 * H);
    const n = Math.round((weekend ? 4 + rand() * 4 : (weekday === 1 ? 30 : 20) + rand() * 9) * Math.min(1, scale * 1.4));
    for (let i = 0; i < n; i++) {
      const t = ticket(start - rand() * 30 * H, false);
      t.completed = t.milestones[2][1] = new Date(start + rand() * (end - start)).toISOString();
      closed.push(t);
    }
    for (let i = 0; i < n + Math.round((rand() - 0.35) * 6); i++) created.push({ created: new Date(start + rand() * (end - start)).toISOString() });
  }
  for (const c of created) {
    const like = open[Math.floor(rand() * open.length)];
    Object.assign(c, { id: like.id, queue: like.queue, priority: like.priority });
  }
  return {
    demo: true,
    fetchedAt: new Date(now).toISOString(),
    picklists: { queues, statuses, priorities },
    closedStatuses: [5],
    timeZone: tz,
    truncated: false,
    open,
    closed,
    created,
  };
}

// ---------- stored copy ----------

let snapshotCache = { key: null, value: null };

export function loadSnapshot() {
  const r = row();
  if (!r?.snapshot) return null;
  const key = `${r.fetched_at}|${r.snapshot.length}`;
  if (snapshotCache.key !== key) {
    try {
      snapshotCache = { key, value: JSON.parse(r.snapshot) };
    } catch {
      snapshotCache = { key, value: null };
    }
  }
  return snapshotCache.value;
}

/** Queues, statuses and priorities, for the widget filters in the dashboard. */
export function picklists() {
  const snap = loadSnapshot();
  return {
    queues: snap?.picklists?.queues || [],
    statuses: snap?.picklists?.statuses || [],
    priorities: snap?.picklists?.priorities || [],
    closedStatuses: snap?.closedStatuses || getSettings().closedStatuses,
  };
}

let inFlight = null;

/** Fetch fresh data (real or demo) and store it. Keeps the last good copy if Autotask fails. */
export function refreshAutotask() {
  inFlight ??= doRefresh().finally(() => (inFlight = null));
  return inFlight;
}

async function doRefresh() {
  const settings = getSettings();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const tz = settings.timeZone || serverTimeZone();
  try {
    const prev = loadSnapshot();
    const snap = mode(settings) === 'demo' ? demoSnapshot(now, tz) : await fetchLive(settings, getSecret(), prev, now);
    if (snap.zone && snap.zone.zoneUrl !== settings.zoneUrl) saveSettings({ ...normalizeSettings({}, settings), ...snap.zone });
    delete snap.requests;
    query(
      `INSERT INTO integrations (name, snapshot, fetched_at, checked_at, error) VALUES ('autotask', $1, $2, $2, NULL)
       ON CONFLICT (name) DO UPDATE SET snapshot = excluded.snapshot, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, error = NULL`,
      [JSON.stringify(snap), nowIso],
    );
    return snap;
  } catch (err) {
    const message = friendlyError(err);
    query(
      `INSERT INTO integrations (name, checked_at, error) VALUES ('autotask', $1, $2)
       ON CONFLICT (name) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      [nowIso, message],
    );
    throw new AutotaskError(message);
  }
}

// ---------- numbers for a widget ----------

const PRIORITY_WORDS = [
  [/critical|urgent|p1\b|emergency/i, 'critical', 0],
  [/high|p2\b/i, 'high', 1],
  [/medium|normal|p3\b/i, 'medium', 2],
  [/low|p4\b|p5\b/i, 'low', 3],
];
function priorityLevel(name) {
  for (const [re, level, rank] of PRIORITY_WORDS) if (re.test(name || '')) return { level, rank };
  return { level: 'normal', rank: 2 };
}

/**
 * Where an open ticket stands against its SLA: 'breached' (a milestone was missed), 'risk' (the
 * next one is due within `riskMs`), 'ok', or null for tickets without an SLA.
 */
export function slaState(t, now, riskMs) {
  if (!t.sla) return null;
  let missed = null;
  let next = null;
  for (const [due, done] of t.milestones || []) {
    if (!due) continue;
    const dueMs = Date.parse(due);
    if (done ? Date.parse(done) > dueMs : dueMs < now) missed = missed === null ? dueMs : Math.min(missed, dueMs);
    else if (!done) next = next === null ? dueMs : Math.min(next, dueMs);
  }
  if (missed !== null || t.slaMet === false) return { state: 'breached', due: missed !== null ? new Date(missed).toISOString() : null };
  if (next === null) return { state: null, due: null };
  return { state: next - now <= riskMs ? 'risk' : 'ok', due: new Date(next).toISOString() };
}

/** Did a closed ticket meet its SLA? null when it had none. */
function slaMet(t) {
  if (!t.sla) return null;
  if (t.slaMet === true || t.slaMet === false) return t.slaMet;
  return (t.milestones || []).every(([due, done]) => !due || !done || Date.parse(done) <= Date.parse(due));
}

/** Work out a widget's numbers from the stored tickets, for its filters. */
export function computeStats(snap, options, now = Date.now()) {
  const o = Tickets.normalize(options);
  const inQueue = (t) => !o.queues.length || o.queues.includes(t.queue);
  const inPriority = (t) => !o.priorities.length || o.priorities.includes(t.priority);
  const inStatus = (t) => !o.statuses.length || o.statuses.includes(t.status);
  const tz = snap.timeZone || serverTimeZone();
  const today = startOfDay(now, tz);
  const riskMs = o.atRiskMinutes * 60_000;
  const lists = snap.picklists || {};
  const nameOf = (list, id) => (lists[list] || []).find((v) => v.id === id)?.name ?? null;

  const open = snap.open.filter((t) => inQueue(t) && inPriority(t) && inStatus(t)).map((t) => ({ t, sla: slaState(t, now, riskMs) }));
  const closed = snap.closed.filter((t) => inQueue(t) && inPriority(t) && t.completed);
  const created = snap.created.filter((t) => inQueue(t) && inPriority(t) && t.created);

  const withSla = closed.map(slaMet).filter((v) => v !== null);
  const tiles = {
    open: open.length,
    newToday: created.filter((t) => Date.parse(t.created) >= today).length,
    closedToday: closed.filter((t) => Date.parse(t.completed) >= today).length,
    unassigned: open.filter(({ t }) => !t.assignee).length,
    slaBreached: open.filter(({ sla }) => sla?.state === 'breached').length,
    slaAtRisk: open.filter(({ sla }) => sla?.state === 'risk').length,
    slaMet: withSla.length ? Math.round((withSla.filter(Boolean).length / withSla.length) * 100) : null,
    openedWeek: created.length,
    closedWeek: closed.length,
  };

  // Queue board: every queue with open tickets, or every chosen queue even when empty.
  const byQueue = new Map();
  for (const id of o.queues) byQueue.set(id, { id, open: 0, breached: 0, atRisk: 0 });
  for (const { t, sla } of open) {
    const q = byQueue.get(t.queue) || byQueue.set(t.queue, { id: t.queue, open: 0, breached: 0, atRisk: 0 }).get(t.queue);
    q.open++;
    if (sla?.state === 'breached') q.breached++;
    if (sla?.state === 'risk') q.atRisk++;
  }
  const queues = [...byQueue.values()]
    .map((q) => ({ ...q, name: q.id === null ? 'No queue' : nameOf('queues', q.id) || `Queue ${q.id}` }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));

  // Hot list: the tickets that need someone first.
  const ORDER = { breached: 0, risk: 1, ok: 2 };
  const ranked = open.map(({ t, sla }) => ({ t, sla, pr: priorityLevel(nameOf('priorities', t.priority)) }));
  const byAge = (a, b) => Date.parse(a.t.created || 0) - Date.parse(b.t.created || 0);
  const bySla = (a, b) =>
    (ORDER[a.sla?.state] ?? 3) - (ORDER[b.sla?.state] ?? 3) || Date.parse(a.sla?.due || 8.64e15) - Date.parse(b.sla?.due || 8.64e15) || a.pr.rank - b.pr.rank;
  ranked.sort(o.hotSort === 'oldest' ? byAge : o.hotSort === 'priority' ? (a, b) => a.pr.rank - b.pr.rank || bySla(a, b) || byAge(a, b) : (a, b) => bySla(a, b) || byAge(a, b));
  const hot = ranked.slice(0, o.hotCount).map(({ t, sla, pr }) => ({
    id: t.id,
    number: t.number,
    // Private details stay on the server when the widget hides them.
    title: o.hidePrivate ? null : t.title,
    company: o.hidePrivate ? null : t.company,
    queue: nameOf('queues', t.queue),
    status: nameOf('statuses', t.status),
    priority: nameOf('priorities', t.priority),
    priorityLevel: pr.level,
    assignee: o.showAssignee ? t.assignee : null,
    created: t.created,
    sla: sla?.state ? { state: sla.state, due: sla.due, riskMs } : null,
  }));

  // Seven days of opened against closed, oldest first.
  const trend = [];
  for (let back = 6; back >= 0; back--) {
    const start = startOfDay(now, tz, back);
    const end = back ? startOfDay(now, tz, back - 1) : Infinity;
    const inDay = (iso) => {
      const ms = Date.parse(iso);
      return ms >= start && ms < end;
    };
    trend.push({
      label: back === 0 ? 'Today' : new Date(start + 12 * 3_600_000).toLocaleDateString('en-GB', { weekday: 'short', timeZone: tz }),
      opened: created.filter((t) => inDay(t.created)).length,
      closed: closed.filter((t) => inDay(t.completed)).length,
    });
  }

  return { tiles, queues, hot, trend };
}

/** What a player (or the dashboard) needs to draw a ticket widget. Never includes credentials. */
export function ticketContent(options) {
  const o = Tickets.normalize(options);
  const settings = getSettings();
  const r = row();
  const snap = loadSnapshot();
  return {
    title: o.label || 'Service desk',
    options: o,
    demo: snap ? Boolean(snap.demo) : mode(settings) === 'demo',
    fetchedAt: snap?.fetchedAt || null,
    // Screens flag the numbers as old once a few refreshes have been missed.
    staleAfterMinutes: settings.refreshMinutes * 3 + 2,
    error: r?.error ? true : false,
    stats: snap ? computeStats(snap, o) : null,
  };
}

export function parseWidgetOptions(media) {
  try {
    return Tickets.normalize(media.options ? JSON.parse(media.options) : {});
  } catch {
    return Tickets.normalize({});
  }
}

// ---------- background refresh ----------

const widgetsInUse = () => query(`SELECT count(*) AS n FROM media WHERE kind = 'autotask'`).rows[0].n > 0;

/** Keep ticket numbers fresh while any widget exists. `onChange()` runs after each successful refresh. */
export function startAutotaskRefresher(onChange) {
  let running = false;
  const tick = async () => {
    if (running || !widgetsInUse()) return;
    const r = row();
    const due = !r?.checked_at || Date.now() - Date.parse(r.checked_at) >= getSettings().refreshMinutes * 60_000 - 5_000;
    if (!due) return;
    running = true;
    try {
      await refreshAutotask();
      await onChange();
    } catch (err) {
      console.warn(`Autotask refresh failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 3_000).unref();
  return setInterval(tick, 15_000).unref();
}
