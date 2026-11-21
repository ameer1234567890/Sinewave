// Tests for the Autotask ticket widgets, against a pretend Autotask API. Run with: npm test (from server/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// ---------- a pretend Autotask REST API ----------

const H = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, ''); // Autotask style: UTC, sometimes without the Z
const seen = { headers: [], bodies: [], zoneLookups: 0 };

const QUEUES = [
  { value: '100', label: 'Service Desk', isActive: true, sortOrder: 1 },
  { value: '200', label: 'Projects', isActive: true, sortOrder: 2 },
];
const STATUSES = [
  { value: '1', label: 'New', isActive: true },
  { value: '5', label: 'Complete', isActive: true },
  { value: '8', label: 'In Progress', isActive: true },
];
const PRIORITIES = [
  { value: '1', label: 'High', isActive: true },
  { value: '2', label: 'Medium', isActive: true },
  { value: '4', label: 'Critical', isActive: true },
];

const ticket = (id, extra) => ({
  id,
  ticketNumber: `T20261121.${String(id).padStart(4, '0')}`,
  title: `Secret title ${id}`,
  status: 1,
  priority: 2,
  queueID: 100,
  companyID: 9001,
  assignedResourceID: 7,
  createDate: iso(NOW - 5 * 60_000),
  completedDate: null,
  serviceLevelAgreementID: 3,
  serviceLevelAgreementHasBeenMet: null,
  firstResponseDueDateTime: iso(NOW - 1 * H),
  firstResponseDateTime: iso(NOW - 1.5 * H),
  resolvedDueDateTime: iso(NOW + 10 * H),
  resolvedDateTime: null,
  ...extra,
});

// Open tickets, spread over two pages to check paging.
const OPEN = [
  ticket(1, {}), // fine
  ticket(2, { firstResponseDateTime: null }), // first response overdue: breached
  ticket(3, { resolvedDueDateTime: iso(NOW + 20 * 60_000), priority: 4 }), // due in 20 min: at risk
  ticket(4, { queueID: 200, assignedResourceID: null, companyID: 9002 }), // unassigned, other queue
  ticket(5, { serviceLevelAgreementID: null, firstResponseDateTime: null, priority: 1 }), // no SLA
];
const CLOSED = [
  ticket(10, { status: 5, completedDate: iso(NOW - 2 * 60_000), serviceLevelAgreementHasBeenMet: true }),
  ticket(11, { status: 5, completedDate: iso(NOW - 3 * 60_000), serviceLevelAgreementHasBeenMet: false }),
];
const CREATED = [...OPEN, ...CLOSED].map((t) => ({ id: t.id, createDate: t.createDate, queueID: t.queueID, priority: t.priority, status: t.status }));

let server;
let base;
let failWith = null;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, base);
      if (url.pathname === '/zoneInformation') {
        seen.zoneLookups++;
        if (url.searchParams.get('user') !== 'api@example.com') return reply(res, 404, {});
        return reply(res, 200, { zoneName: 'Pretend Zone', url: `${base}/ATServicesRest/`, webUrl: base, ci: 1 });
      }
      seen.headers.push(req.headers);
      if (req.headers.secret !== 'top-secret') return reply(res, 401, { errors: ['Unauthorized'] });
      if (failWith) return reply(res, failWith, { errors: ['Something broke'] });
      const body = raw ? JSON.parse(raw) : null;
      if (body) seen.bodies.push({ path: url.pathname, body });
      const p = url.pathname.replace('/ATServicesRest/V1.0/', '');
      if (p === 'Tickets/entityInformation/fields') {
        return reply(res, 200, {
          fields: [
            { name: 'queueID', isPickList: true, picklistValues: QUEUES },
            { name: 'status', isPickList: true, picklistValues: STATUSES },
            { name: 'priority', isPickList: true, picklistValues: PRIORITIES },
            { name: 'title', isPickList: false },
          ],
        });
      }
      if (p === 'Resources/query') return reply(res, 200, { items: [{ id: 7, firstName: 'Sam', lastName: 'Patel' }], pageDetails: {} });
      if (p === 'Companies/query') {
        return reply(res, 200, { items: [{ id: 9001, companyName: 'Acme Secret Ltd' }, { id: 9002, companyName: 'Hidden Corp' }], pageDetails: {} });
      }
      if (p === 'Tickets/query' && url.searchParams.get('page') === '2') return reply(res, 200, { items: OPEN.slice(3), pageDetails: { nextPageUrl: null } });
      if (p === 'Tickets/query') {
        const f = body.filter[0];
        if (f.field === 'status') {
          return reply(res, 200, { items: OPEN.slice(0, 3), pageDetails: { nextPageUrl: `${base}/ATServicesRest/V1.0/Tickets/query?page=2` } });
        }
        if (f.field === 'completedDate') return reply(res, 200, { items: CLOSED, pageDetails: {} });
        if (f.field === 'createDate') return reply(res, 200, { items: CREATED, pageDetails: {} });
      }
      reply(res, 404, { errors: [`No route ${p}`] });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.AUTOTASK_ZONE_LOOKUP_URL = `${base}/zoneInformation`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sinewave-autotask-'));
  process.env.TZ = 'UTC';
});

after(() => server.close());

const load = async () => {
  const db = await import('../src/db.js');
  db.migrate();
  return import('../src/autotask.js');
};

// ---------- tests ----------

test('widget settings are cleaned up', async () => {
  const { Tickets } = await load();
  const o = Tickets.normalize({
    layout: 'nope',
    queues: ['100', 'x', -1, 200, 200],
    tiles: ['open', 'bogus', 'slaMet'],
    thresholds: { slaMet: { amber: '150', red: '' } },
    hotCount: 99,
    hidePrivate: 'false',
  });
  assert.equal(o.layout, 'overview');
  assert.deepEqual(o.queues, [100, 200]);
  assert.deepEqual(o.tiles, ['open', 'slaMet']);
  assert.deepEqual(o.thresholds.slaMet, { amber: 100, red: null });
  assert.deepEqual(o.thresholds.slaBreached, { amber: 1, red: 5 }); // default kept
  assert.equal(o.hotCount, 15);
  assert.equal(o.hidePrivate, false);
  assert.equal(Tickets.normalize({}).hidePrivate, true, 'private details are hidden unless turned on');
});

test('tile colours follow thresholds in the right direction', async () => {
  const { Tickets } = await load();
  assert.equal(Tickets.level(0, { amber: 1, red: 5 }, 'up'), 'ok');
  assert.equal(Tickets.level(3, { amber: 1, red: 5 }, 'up'), 'amber');
  assert.equal(Tickets.level(5, { amber: 1, red: 5 }, 'up'), 'red');
  assert.equal(Tickets.level(97, { amber: 95, red: 90 }, 'down'), 'ok');
  assert.equal(Tickets.level(93, { amber: 95, red: 90 }, 'down'), 'amber');
  assert.equal(Tickets.level(80, { amber: 95, red: 90 }, 'down'), 'red');
  assert.equal(Tickets.level(80, { amber: null, red: null }, 'up'), 'ok');
});

test('start of day respects the time zone', async () => {
  const { startOfDay } = await load();
  const t = Date.parse('2026-07-15T23:30:00Z'); // 00:30 on the 16th in London (BST)
  assert.equal(new Date(startOfDay(t, 'Europe/London')).toISOString(), '2026-07-15T23:00:00.000Z');
  assert.equal(new Date(startOfDay(t, 'UTC')).toISOString(), '2026-07-15T00:00:00.000Z');
  assert.equal(new Date(startOfDay(t, 'Europe/London', 1)).toISOString(), '2026-07-14T23:00:00.000Z');
});

test('demo data works with no Autotask account', async () => {
  const { refreshAutotask, ticketContent, mode } = await load();
  assert.equal(mode(), 'demo');
  await refreshAutotask();
  const c = ticketContent({});
  assert.equal(c.demo, true);
  assert.ok(c.stats.tiles.open > 20);
  assert.ok(c.stats.queues.length > 2);
  assert.equal(c.stats.trend.length, 7);
  assert.equal(c.stats.hot.length, 8);
  assert.ok(c.stats.hot.every((t) => t.title === null && t.company === null));
});

test('wrong credentials are explained, and the secret is never sent back', async () => {
  const { testConnection, normalizeSettings, saveSettings, publicSettings } = await load();
  const settings = normalizeSettings({ demo: false, username: 'api@example.com', integrationCode: 'CODE1234' });
  await assert.rejects(testConnection(settings, 'wrong'), /rejected the API username or secret/);
  await assert.rejects(testConnection({ ...settings, username: 'nobody@example.com' }, 'top-secret'), /doesn't recognise that API username/);

  const ok = await testConnection(settings, 'top-secret');
  assert.equal(ok.zoneName, 'Pretend Zone');
  assert.equal(ok.zoneUrl, `${base}/ATServicesRest/V1.0/`);
  assert.equal(ok.queues, 2);

  saveSettings({ ...settings, ...{ zoneUrl: ok.zoneUrl, zoneName: ok.zoneName } }, 'top-secret');
  const pub = publicSettings();
  assert.equal(pub.mode, 'live');
  assert.equal(pub.hasSecret, true);
  assert.ok(!JSON.stringify(pub).includes('top-secret'));
  assert.ok(!JSON.stringify(pub).includes('CODE1234'), 'integration code is masked');
  assert.match(pub.integrationCode, /1234$/);
});

test('live data: paging, headers, numbers, SLAs and filters', async () => {
  const { refreshAutotask, ticketContent, clearSnapshot } = await load();
  clearSnapshot();
  seen.headers.length = 0;
  const snap = await refreshAutotask();
  assert.equal(snap.demo, false);
  assert.equal(snap.open.length, 5, 'followed nextPageUrl to the second page');
  for (const h of seen.headers) {
    assert.equal(h.apiintegrationcode, 'CODE1234');
    assert.equal(h.username, 'api@example.com');
    assert.equal(h.secret, 'top-secret');
  }
  const openQuery = seen.bodies.find((b) => b.path.endsWith('Tickets/query') && b.body.filter[0].field === 'status');
  assert.deepEqual(openQuery.body.filter[0], { op: 'notIn', field: 'status', value: [5] });
  assert.equal(openQuery.body.MaxRecords, 500);

  const c = ticketContent({ hidePrivate: false });
  assert.equal(c.demo, false);
  assert.deepEqual(
    { ...c.stats.tiles },
    { open: 5, newToday: 7, closedToday: 2, unassigned: 1, slaBreached: 1, slaAtRisk: 1, slaMet: 50, openedWeek: 7, closedWeek: 2 },
  );
  assert.deepEqual(
    c.stats.queues.map((q) => [q.name, q.open, q.breached, q.atRisk]),
    [['Service Desk', 4, 1, 1], ['Projects', 1, 0, 0]],
  );
  // Hot list: breached first, then at risk, with names filled in.
  assert.deepEqual(c.stats.hot.slice(0, 2).map((t) => [t.id, t.sla.state]), [[2, 'breached'], [3, 'risk']]);
  assert.equal(c.stats.hot[1].priority, 'Critical');
  assert.equal(c.stats.hot[1].priorityLevel, 'critical');
  assert.equal(c.stats.hot[0].company, 'Acme Secret Ltd');
  assert.equal(c.stats.hot[0].assignee, 'Sam Patel');
  assert.equal(c.stats.hot.find((t) => t.id === 4).assignee, null);

  // Filters.
  const projects = ticketContent({ queues: [200] });
  assert.equal(projects.stats.tiles.open, 1);
  assert.deepEqual(projects.stats.queues.map((q) => q.name), ['Projects']);
  const critical = ticketContent({ priorities: [4] });
  assert.equal(critical.stats.tiles.open, 1);
  assert.equal(critical.stats.tiles.slaAtRisk, 1);
  const wider = ticketContent({ atRiskMinutes: 24 * 60 });
  assert.equal(wider.stats.tiles.slaAtRisk, 3, 'a longer at-risk window catches more tickets');
});

test('hiding private information keeps names off the screen entirely', async () => {
  const { ticketContent, Tickets } = await load();
  const c = ticketContent({ hidePrivate: true, layout: 'hotlist' });
  const json = JSON.stringify(c);
  for (const secret of ['Secret title', 'Acme Secret', 'Hidden Corp']) assert.ok(!json.includes(secret), `${secret} leaked`);
  const html = Tickets.toHTML(c);
  assert.ok(!html.includes('Secret title'));
  assert.ok(html.includes('T20261121.0002'), 'ticket numbers still show');
  const shown = Tickets.toHTML(ticketContent({ hidePrivate: false, layout: 'hotlist' }));
  assert.ok(shown.includes('Secret title 2') && shown.includes('Acme Secret Ltd'));
});

test('the renderer escapes text and draws every layout', async () => {
  const { ticketContent, Tickets } = await load();
  for (const l of Tickets.LAYOUTS) {
    const html = Tickets.toHTML({ ...ticketContent({ layout: l.id, label: '<b>Desk</b>' }) });
    assert.ok(html.includes(`at-layout-${l.id}`));
    assert.ok(html.includes('&lt;b&gt;Desk&lt;/b&gt;') && !html.includes('<b>Desk'));
  }
  assert.match(Tickets.toHTML({ options: {} }), /will appear here/);
});

test('a failed refresh keeps the last good numbers and records why', async () => {
  const { refreshAutotask, ticketContent, publicSettings } = await load();
  failWith = 500;
  try {
    await assert.rejects(refreshAutotask(), /Something broke/);
  } finally {
    failWith = null;
  }
  assert.match(publicSettings().status.error, /Something broke/);
  assert.equal(ticketContent({}).stats.tiles.open, 5);
  await refreshAutotask();
  assert.equal(publicSettings().status.error, null);
});

test('screens get the numbers in their manifest but never the credentials', async () => {
  const { query } = await import('../src/db.js');
  const { buildManifest } = await import('../src/manifest.js');
  query(`INSERT INTO media (id, name, kind, options) VALUES ('m1', 'Desk', 'autotask', '{"hidePrivate":true}')`);
  query(`INSERT INTO playlists (id, name) VALUES ('p1', 'Wall')`);
  query(`INSERT INTO playlist_items (id, playlist_id, media_id, position) VALUES ('i1', 'p1', 'm1', 0)`);
  const m = await buildManifest({ id: 's1', name: 'NOC', playlist_id: 'p1' });
  const item = m.playlist.items[0];
  assert.equal(item.kind, 'autotask');
  assert.equal(item.durationSeconds, 30);
  assert.equal(item.autotask.stats.tiles.open, 5);
  const json = JSON.stringify(m);
  for (const secret of ['top-secret', 'CODE1234', 'api@example.com', 'Secret title', 'Acme Secret']) assert.ok(!json.includes(secret), `${secret} leaked`);
});
