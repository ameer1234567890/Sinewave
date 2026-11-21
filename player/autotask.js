/*
 * Sinewave ticket widgets: live service desk numbers from Autotask, drawn as big number tiles,
 * a queue board, a hot list of tickets and a seven-day trend.
 *
 * The server talks to Autotask, works out the numbers for each widget's filters and sends only
 * those to screens (never the API credentials). This file turns those numbers into HTML. The
 * same file is used by the player, the dashboard (previews and thumbnails) and the server (to
 * check widget settings), so all three agree on what a widget can be.
 *
 * Sizes use container query units (cqmin), so a widget scales to whatever box it is put in.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SinewaveTickets = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The numbers a widget can show as tiles. `worse` says which way is bad: 'up' means a higher
   * number is worse (amber and red when it reaches the threshold), 'down' means a lower one is.
   */
  const TILES = [
    { id: 'open', label: 'Open tickets', worse: 'up', hint: 'Tickets not yet closed' },
    { id: 'newToday', label: 'New today', worse: 'up', hint: 'Tickets created since midnight' },
    { id: 'closedToday', label: 'Closed today', worse: 'down', hint: 'Tickets completed since midnight' },
    { id: 'unassigned', label: 'Unassigned', worse: 'up', hint: 'Open tickets with no primary resource' },
    { id: 'slaBreached', label: 'SLA breached', worse: 'up', hint: 'Open tickets that have missed an SLA milestone' },
    { id: 'slaAtRisk', label: 'SLA at risk', worse: 'up', hint: 'Open tickets with an SLA milestone due soon' },
    { id: 'slaMet', label: 'SLA met · 7 days', worse: 'down', percent: true, hint: 'Share of tickets closed in the last 7 days that met their SLA' },
    { id: 'openedWeek', label: 'Opened · 7 days', worse: 'up', hint: 'Tickets created in the last 7 days' },
    { id: 'closedWeek', label: 'Closed · 7 days', worse: 'down', hint: 'Tickets completed in the last 7 days' },
  ];
  const TILE_IDS = TILES.map((t) => t.id);

  const LAYOUTS = [
    { id: 'overview', name: 'Overview', hint: 'Tiles across the top, queues and the hot list below' },
    { id: 'tiles', name: 'Big numbers', hint: 'Large number tiles that turn amber or red' },
    { id: 'queues', name: 'Queue board', hint: 'A bar for each queue, with SLA flags' },
    { id: 'hotlist', name: 'Hot list', hint: 'The tickets that need attention first' },
    { id: 'trend', name: 'Trend', hint: 'Opened against closed for the last 7 days' },
  ];
  const LAYOUT_IDS = LAYOUTS.map((l) => l.id);

  const HOT_SORTS = [
    { id: 'sla', name: 'SLA first' },
    { id: 'priority', name: 'Highest priority' },
    { id: 'oldest', name: 'Oldest' },
  ];

  const DEFAULT_THRESHOLDS = {
    open: { amber: null, red: null },
    newToday: { amber: null, red: null },
    closedToday: { amber: null, red: null },
    unassigned: { amber: 5, red: 10 },
    slaBreached: { amber: 1, red: 5 },
    slaAtRisk: { amber: 1, red: 5 },
    slaMet: { amber: 95, red: 90 },
    openedWeek: { amber: null, red: null },
    closedWeek: { amber: null, red: null },
  };

  const DEFAULTS = {
    layout: 'overview',
    theme: 'dark',
    accent: '#3b6cf6',
    label: '', // header text; blank means "Service desk"
    // Filters: lists of Autotask picklist values. Empty means "all".
    queues: [],
    statuses: [],
    priorities: [],
    tiles: ['open', 'newToday', 'closedToday', 'slaBreached', 'slaAtRisk', 'unassigned'],
    thresholds: DEFAULT_THRESHOLDS,
    // Per-queue open ticket counts that turn a queue's bar amber or red.
    queueThresholds: { amber: null, red: null },
    hotCount: 8,
    hotSort: 'sla',
    atRiskMinutes: 60,
    // Hide company names and ticket titles, e.g. for screens visitors or customers can see.
    hidePrivate: true,
    showAssignee: true,
  };

  const int = (v, min, max, fallback) => {
    if (v === '' || v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const optInt = (v, min, max) => (v === '' || v === null || v === undefined ? null : int(v, min, max, null));
  const bool = (v, fallback) => (v === undefined ? fallback : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
  const ids = (v) =>
    [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0))].slice(0, 200);

  /** Keep only known settings, clamped to sensible ranges. `base` supplies anything not given. */
  function normalize(input, base) {
    const i = input && typeof input === 'object' ? input : {};
    const b = base || DEFAULTS;
    const o = JSON.parse(JSON.stringify(b));
    if (LAYOUT_IDS.includes(i.layout)) o.layout = i.layout;
    if (i.theme === 'dark' || i.theme === 'light') o.theme = i.theme;
    if (typeof i.accent === 'string' && /^#[0-9a-f]{6}$/i.test(i.accent)) o.accent = i.accent.toLowerCase();
    if (i.label !== undefined) o.label = String(i.label ?? '').trim().slice(0, 80);
    if (i.queues !== undefined) o.queues = ids(i.queues);
    if (i.statuses !== undefined) o.statuses = ids(i.statuses);
    if (i.priorities !== undefined) o.priorities = ids(i.priorities);
    if (Array.isArray(i.tiles)) o.tiles = [...new Set(i.tiles.filter((t) => TILE_IDS.includes(t)))];
    const thresholds = {};
    for (const id of TILE_IDS) {
      const given = i.thresholds && typeof i.thresholds === 'object' ? i.thresholds[id] : undefined;
      const prev = (o.thresholds && o.thresholds[id]) || DEFAULT_THRESHOLDS[id];
      const max = id === 'slaMet' ? 100 : 100000;
      thresholds[id] =
        given && typeof given === 'object'
          ? { amber: optInt(given.amber, 0, max), red: optInt(given.red, 0, max) }
          : { amber: prev.amber ?? null, red: prev.red ?? null };
    }
    o.thresholds = thresholds;
    if (i.queueThresholds && typeof i.queueThresholds === 'object') {
      o.queueThresholds = { amber: optInt(i.queueThresholds.amber, 0, 100000), red: optInt(i.queueThresholds.red, 0, 100000) };
    }
    o.hotCount = int(i.hotCount, 3, 15, o.hotCount);
    if (HOT_SORTS.some((s) => s.id === i.hotSort)) o.hotSort = i.hotSort;
    o.atRiskMinutes = int(i.atRiskMinutes, 5, 24 * 60, o.atRiskMinutes);
    o.hidePrivate = bool(i.hidePrivate, o.hidePrivate);
    o.showAssignee = bool(i.showAssignee, o.showAssignee);
    return o;
  }

  /** 'ok', 'amber' or 'red' for a value against a tile's thresholds. */
  function level(value, threshold, worse) {
    if (value === null || value === undefined || !threshold) return 'ok';
    const hit = (limit) => limit !== null && limit !== undefined && (worse === 'down' ? value <= limit : value >= limit);
    if (hit(threshold.red)) return 'red';
    if (hit(threshold.amber)) return 'amber';
    return 'ok';
  }

  // ---------- formatting ----------

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function duration(ms) {
    const mins = Math.max(0, Math.round(ms / 60_000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return mins % 60 && hours < 10 ? `${hours}h ${mins % 60}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return hours % 24 && days < 10 ? `${days}d ${hours % 24}h` : `${days}d`;
  }

  const number = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-GB'));
  const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  /** The SLA state of a hot list ticket right now (a ticket can go overdue between updates). */
  function slaNow(sla, now) {
    if (!sla || !sla.state) return null;
    const due = sla.due ? Date.parse(sla.due) : null;
    if (sla.state === 'breached') return { cls: 'red', text: due ? `Overdue ${duration(now - due)}` : 'SLA missed' };
    if (due && due <= now) return { cls: 'red', text: `Overdue ${duration(now - due)}` };
    if (sla.state === 'risk' || (due && sla.riskMs && due - now <= sla.riskMs)) return { cls: 'amber', text: `Due in ${duration(due - now)}` };
    return due ? { cls: 'muted', text: `Due in ${duration(due - now)}` } : null;
  }

  // ---------- pieces ----------

  function tilesHTML(content, ids, big) {
    const o = content.options;
    const values = content.stats?.tiles || {};
    const list = ids.map((id) => TILES.find((t) => t.id === id)).filter(Boolean);
    if (!list.length) return '';
    return `<div class="at-tiles at-n-${list.length}${big ? ' at-tiles-big' : ''}" style="--n:${list.length}">${list
      .map((t) => {
        const v = values[t.id];
        const lvl = level(v, o.thresholds?.[t.id], t.worse);
        const shown = v === null || v === undefined ? '–' : `${number(v)}${t.percent ? '<small>%</small>' : ''}`;
        return `<div class="at-tile at-${lvl}" data-tile="${t.id}"><div class="at-tile-value">${shown}</div><div class="at-tile-label">${esc(t.label)}</div></div>`;
      })
      .join('')}</div>`;
  }

  function queuesHTML(content, maxRows) {
    const o = content.options;
    const queues = content.stats?.queues || [];
    if (!queues.length) return `<div class="at-queues at-none">No open tickets in these queues</div>`;
    const shown = queues.slice(0, maxRows);
    const top = Math.max(1, ...shown.map((q) => q.open));
    const rest = queues.length - shown.length;
    return `<div class="at-queues" style="--rows:${shown.length + (rest > 0 ? 1 : 0)}">${shown
      .map((q) => {
        const lvl = level(q.open, o.queueThresholds, 'up');
        const flags = [
          q.breached ? `<b class="at-flag at-red">${number(q.breached)} breached</b>` : '',
          q.atRisk ? `<b class="at-flag at-amber">${number(q.atRisk)} at risk</b>` : '',
        ].join('');
        return `<div class="at-q at-${lvl}"><span class="at-q-name">${esc(q.name)}</span><span class="at-q-bar"><i style="width:${((q.open / top) * 100).toFixed(1)}%"></i></span><span class="at-q-count">${number(q.open)}</span><span class="at-q-flags">${flags}</span></div>`;
      })
      .join('')}${rest > 0 ? `<div class="at-q at-q-more">+ ${rest} more queue${rest === 1 ? '' : 's'}</div>` : ''}</div>`;
  }

  function hotHTML(content, max, now) {
    const o = content.options;
    const hot = (content.stats?.hot || []).slice(0, max);
    if (!hot.length) return `<div class="at-hot at-none">Nothing needs attention right now</div>`;
    return `<div class="at-hot" style="--rows:${hot.length}">${hot
      .map((t) => {
        const sla = slaNow(t.sla, now);
        const age = t.created ? duration(now - Date.parse(t.created)) : '';
        const title = t.title || `${t.queue || 'Ticket'}${t.status ? ` · ${t.status}` : ''}`;
        const sub = [t.number, t.company, t.title ? t.queue : null].filter(Boolean).join(' · ');
        const who = o.showAssignee ? `<span class="at-h-who${t.assignee ? '' : ' at-unassigned'}">${esc(t.assignee || 'Unassigned')}</span>` : '';
        return `<div class="at-h${sla?.cls === 'red' ? ' at-h-red' : ''}"><span class="at-pri at-pri-${t.priorityLevel || 'normal'}">${esc(t.priority || '')}</span><span class="at-h-main"><span class="at-h-title">${esc(title)}</span><span class="at-h-sub">${esc(sub)}</span></span>${who}<span class="at-h-age">${esc(age)}</span><span class="at-h-sla ${sla ? `at-${sla.cls}` : ''}">${esc(sla?.text || '')}</span></div>`;
      })
      .join('')}</div>`;
  }

  function trendHTML(content) {
    const days = content.stats?.trend || [];
    if (!days.length) return '';
    const top = Math.max(1, ...days.flatMap((d) => [d.opened, d.closed]));
    const opened = days.reduce((a, d) => a + d.opened, 0);
    const closed = days.reduce((a, d) => a + d.closed, 0);
    const diff = closed - opened;
    const summary = diff === 0 ? 'Keeping pace' : diff > 0 ? `${number(diff)} more closed than opened` : `${number(-diff)} more opened than closed`;
    return `<div class="at-trend"><div class="at-trend-key"><span><i class="at-k-open"></i>Opened <b>${number(opened)}</b></span><span><i class="at-k-closed"></i>Closed <b>${number(closed)}</b></span><span class="at-trend-sum ${diff < 0 ? 'at-amber' : 'at-good'}">${esc(summary)}</span></div><div class="at-trend-days">${days
      .map(
        (d) => `<div class="at-day"><div class="at-day-bars"><span class="at-bar-open" style="height:${((d.opened / top) * 100).toFixed(1)}%"><em>${number(d.opened)}</em></span><span class="at-bar-closed" style="height:${((d.closed / top) * 100).toFixed(1)}%"><em>${number(d.closed)}</em></span></div><div class="at-day-label">${esc(d.label)}</div></div>`,
      )
      .join('')}</div></div>`;
  }

  /**
   * Build a widget's HTML from what the server sends: { title, options, demo, fetchedAt,
   * staleAfterMinutes, stats }. `now` (ms) is when the ages and SLA countdowns are measured from.
   */
  function toHTML(content, now) {
    const c = content || {};
    const o = normalize(c.options || {});
    c.options = o;
    now = now || Date.now();
    const fetched = c.fetchedAt ? Date.parse(c.fetchedAt) : null;
    const stale = !fetched || now - fetched > (c.staleAfterMinutes || 10) * 60_000;
    const updated = fetched ? `${stale ? 'Last updated' : 'Updated'} ${time(fetched)}` : 'Waiting for data';
    const head = `<header class="at-head"><span class="at-badge">Tickets</span><span class="at-title">${esc(c.title || 'Service desk')}</span>${
      c.demo ? '<span class="at-demo">Demo data</span>' : ''
    }<span class="at-updated${stale ? ' at-stale' : ''}">${esc(updated)}</span><span class="at-clock">${time(now)}</span></header>`;

    let body;
    if (!c.stats) {
      body = `<div class="at-waiting">Ticket numbers will appear here once Sinewave has heard from Autotask.</div>`;
    } else if (o.layout === 'tiles') {
      body = tilesHTML(c, o.tiles.length ? o.tiles : DEFAULTS.tiles, true);
    } else if (o.layout === 'queues') {
      body = queuesHTML(c, 10);
    } else if (o.layout === 'hotlist') {
      body = hotHTML(c, o.hotCount, now);
    } else if (o.layout === 'trend') {
      body = `${tilesHTML(c, ['openedWeek', 'closedWeek', 'slaMet'], false)}${trendHTML(c)}`;
    } else {
      body = `${tilesHTML(c, o.tiles.slice(0, 6), false)}<div class="at-cols"><section><h3>Queues</h3>${queuesHTML(c, 7)}</section><section><h3>Needs attention</h3>${hotHTML(c, Math.min(o.hotCount, 6), now)}</section></div>`;
    }
    return `<div class="at-widget at-${o.theme} at-layout-${o.layout}" style="--accent:${o.accent}">${head}<div class="at-body">${body}</div></div>`;
  }

  return { TILES, LAYOUTS, HOT_SORTS, DEFAULTS, DEFAULT_THRESHOLDS, normalize, level, toHTML, duration };
});
