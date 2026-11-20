/*
 * Sinewave slides: simple, good-looking slides made from a template, a background and a few
 * lines of text. The same file is used by the player (to show slides on screen), the
 * dashboard (for the editor's live preview and thumbnails) and the server (to check input).
 *
 * Everything is drawn with HTML and CSS (see slides.css), so a slide is sharp at any
 * resolution and needs no image files. The backgrounds are generated here from gradients
 * and simple patterns, so they carry no licence restrictions.
 *
 * Sizes use container query units (cqmin), so a slide scales to whatever box it is put in:
 * a full screen, a dashboard thumbnail or the editor preview.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SinewaveSlides = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- backgrounds ----------

  const svg = (body, w = 1920, h = 1080) =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' preserveAspectRatio='xMidYMid slice'>${body}</svg>`,
    ).replace(/'/g, '%27')}")`;

  function wavePath(amp, period, phase, y, width = 1920) {
    const pts = [];
    for (let x = 0; x <= width; x += 16) pts.push(`${x} ${(y + amp * Math.sin(((x + phase) / period) * Math.PI * 2)).toFixed(1)}`);
    return `M${pts.join(' L')}`;
  }

  // A fixed pseudo-random sequence, so the confetti looks the same everywhere.
  function seeded(seed) {
    let s = seed;
    return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  }

  function confetti() {
    const rand = seeded(7);
    const colours = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c'];
    let out = '';
    for (let i = 0, placed = 0; placed < 60 && i < 1000; i++) {
      const x = (rand() * 1920).toFixed(0);
      const y = (rand() * 1080).toFixed(0);
      // Keep the middle clear so the confetti frames the text instead of sitting on it.
      if (x > 60 && x < 1860 && y > 170 && y < 910 && !(x > 1700 || y < 230 || y > 860)) continue;
      placed++;
      const c = colours[i % colours.length];
      const o = (0.35 + rand() * 0.5).toFixed(2);
      if (i % 3 === 0) out += `<circle cx='${x}' cy='${y}' r='${(6 + rand() * 10).toFixed(0)}' fill='${c}' opacity='${o}'/>`;
      else {
        const r = (rand() * 180).toFixed(0);
        out += `<rect x='${x}' y='${y}' width='${(14 + rand() * 18).toFixed(0)}' height='7' rx='3' fill='${c}' opacity='${o}' transform='rotate(${r} ${x} ${y})'/>`;
      }
    }
    return out;
  }

  const waves = (colour, base = 820) =>
    `<path d='${wavePath(60, 960, 0, base)}' stroke='${colour}' stroke-width='6' fill='none' opacity='.55'/>` +
    `<path d='${wavePath(44, 720, 180, base + 40)}' stroke='${colour}' stroke-width='4' fill='none' opacity='.35'/>` +
    `<path d='${wavePath(30, 1280, 420, base + 80)}' stroke='${colour}' stroke-width='3' fill='none' opacity='.22'/>`;

  /**
   * Stock backgrounds. `dark` picks light or dark text; `accent` colours labels and highlights
   * unless the slide sets its own accent.
   */
  const BACKGROUNDS = [
    {
      id: 'sinewave',
      name: 'Sinewave',
      dark: true,
      accent: '#8fa8ff',
      css: `${svg(waves('#6b8fff'))} center / cover no-repeat, radial-gradient(1200px 700px at 15% 10%, #1d2b5c 0%, transparent 70%), linear-gradient(160deg, #0f1730 0%, #0a0f1f 100%)`,
    },
    {
      id: 'aurora',
      name: 'Aurora',
      dark: true,
      accent: '#7ee7c1',
      css: 'radial-gradient(60% 80% at 10% 0%, rgba(56, 189, 148, 0.55), transparent 70%), radial-gradient(50% 70% at 90% 20%, rgba(124, 58, 237, 0.55), transparent 70%), radial-gradient(60% 60% at 60% 110%, rgba(14, 116, 144, 0.6), transparent 70%), #0b1020',
    },
    {
      id: 'ocean',
      name: 'Ocean',
      dark: true,
      accent: '#7dd3fc',
      css: `${svg(waves('#bae6fd', 880))} center / cover no-repeat, linear-gradient(135deg, #0c4a6e 0%, #0e7490 55%, #0f766e 100%)`,
    },
    {
      id: 'sunset',
      name: 'Sunset',
      dark: true,
      accent: '#fde68a',
      css: 'radial-gradient(70% 90% at 85% 15%, rgba(253, 186, 116, 0.65), transparent 65%), linear-gradient(135deg, #7c2d92 0%, #db2777 50%, #f97316 100%)',
    },
    {
      id: 'forest',
      name: 'Forest',
      dark: true,
      accent: '#bef264',
      css: 'repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.035) 0 2px, transparent 2px 28px), linear-gradient(160deg, #14532d 0%, #064e3b 60%, #022c22 100%)',
    },
    {
      id: 'berry',
      name: 'Berry',
      dark: true,
      accent: '#f9a8d4',
      css: 'radial-gradient(55% 75% at 0% 100%, rgba(236, 72, 153, 0.5), transparent 70%), linear-gradient(150deg, #3b0764 0%, #581c87 50%, #831843 100%)',
    },
    {
      id: 'charcoal',
      name: 'Charcoal',
      dark: true,
      accent: '#fbbf24',
      css: 'radial-gradient(rgba(255, 255, 255, 0.09) 1.5px, transparent 1.6px) 0 0 / 28px 28px, linear-gradient(180deg, #23262e 0%, #15171c 100%)',
    },
    {
      id: 'confetti',
      name: 'Confetti',
      dark: true,
      accent: '#ffd166',
      css: `${svg(confetti())} center / cover no-repeat, radial-gradient(80% 80% at 50% 40%, #1e2a4a 0%, #0d1326 100%)`,
    },
    {
      id: 'paper',
      name: 'Paper',
      dark: false,
      accent: '#c2410c',
      css: 'radial-gradient(rgba(120, 90, 50, 0.08) 1px, transparent 1.2px) 0 0 / 22px 22px, linear-gradient(180deg, #fbf7ef 0%, #f3ecdf 100%)',
    },
    {
      id: 'sky',
      name: 'Sky',
      dark: false,
      accent: '#0369a1',
      css: `${svg(waves('#38bdf8', 860))} center / cover no-repeat, linear-gradient(180deg, #e0f2fe 0%, #f8fbff 100%)`,
    },
    {
      id: 'mint',
      name: 'Mint',
      dark: false,
      accent: '#047857',
      css: 'radial-gradient(60% 80% at 100% 0%, rgba(110, 231, 183, 0.55), transparent 70%), radial-gradient(50% 70% at 0% 100%, rgba(167, 243, 208, 0.6), transparent 70%), #f0fdf7',
    },
    {
      id: 'blush',
      name: 'Blush',
      dark: false,
      accent: '#be185d',
      css: 'radial-gradient(60% 80% at 0% 0%, rgba(251, 207, 232, 0.9), transparent 70%), radial-gradient(60% 80% at 100% 100%, rgba(254, 215, 170, 0.8), transparent 70%), #fff7f5',
    },
  ];
  // "image" uses a picture from Media as the background, darkened so text stays readable.
  const IMAGE_BACKGROUND = { id: 'image', name: 'Your picture', dark: true, accent: '#ffffff' };

  const FONTS = [
    { id: 'modern', name: 'Modern', css: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
    { id: 'classic', name: 'Classic', css: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif' },
    { id: 'rounded', name: 'Friendly', css: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Arial Rounded MT Bold", system-ui, sans-serif' },
  ];

  // ---------- templates ----------

  /**
   * Each template lists the text boxes it fills in. `lines` fields keep line breaks.
   * `image` says what an optional picture is used for in that template.
   */
  const TEMPLATES = [
    {
      id: 'announcement',
      name: 'Announcement',
      hint: 'A headline and a short message, with an optional picture beside it',
      image: 'Picture (shown beside the text)',
      background: 'sinewave',
      fields: [
        { key: 'label', label: 'Small heading', max: 60, example: 'Announcement' },
        { key: 'title', label: 'Headline', max: 120, example: 'The office is closed on Friday' },
        { key: 'message', label: 'Message', max: 500, lines: true, example: 'We are moving to the new building. Normal hours resume on Monday at 9am.' },
        { key: 'footer', label: 'Footer', max: 120, example: 'Questions? Ask at reception' },
      ],
    },
    {
      id: 'welcome',
      name: 'Welcome',
      hint: 'A big centred greeting, with your logo above it',
      image: 'Logo (shown above the greeting)',
      background: 'aurora',
      fields: [
        { key: 'title', label: 'Greeting', max: 80, example: 'Welcome' },
        { key: 'subtitle', label: 'Who or where', max: 120, example: 'to Riverside Library' },
        { key: 'message', label: 'Message', max: 300, lines: true, example: 'Free Wi-Fi: Riverside-Guest' },
      ],
    },
    {
      id: 'event',
      name: 'Event',
      hint: 'What is on, with the date, time and place',
      image: 'Picture (shown beside the details)',
      background: 'confetti',
      fields: [
        { key: 'label', label: 'Small heading', max: 60, example: 'Coming up' },
        { key: 'title', label: 'Event name', max: 100, example: 'Summer Quiz Night' },
        { key: 'date', label: 'Date', max: 60, example: 'Friday 12 June' },
        { key: 'time', label: 'Time', max: 60, example: '7:30pm' },
        { key: 'place', label: 'Place', max: 80, example: 'The main hall' },
        { key: 'message', label: 'Details', max: 300, lines: true, example: 'Teams of up to six. Prizes for the top three!' },
      ],
    },
    {
      id: 'menu',
      name: 'Menu or list',
      hint: 'A menu, price list, timetable or opening hours',
      image: 'Logo (shown in the corner)',
      background: 'paper',
      fields: [
        { key: 'title', label: 'Title', max: 80, example: "Today's menu" },
        { key: 'subtitle', label: 'Subtitle', max: 120, example: 'Served 12 – 3pm' },
        {
          key: 'items',
          label: 'Items',
          max: 1500,
          lines: true,
          rows: 7,
          help: 'One per line. Put a price or time at the end of a line to line it up on the right. End a line with a colon to make it a heading.',
          example: 'Mains:\nTomato & basil soup  4.50\nChicken pie with greens  9.95\nMushroom risotto  8.50\nDesserts:\nApple crumble  4.25\nLemon tart  4.00',
        },
        { key: 'footer', label: 'Footer', max: 120, example: 'Please tell us about any allergies' },
      ],
    },
    {
      id: 'quote',
      name: 'Big message',
      hint: 'One short message or quote, as large as possible',
      image: 'Photo (a small round photo by the name)',
      background: 'sunset',
      fields: [
        { key: 'message', label: 'Message', max: 240, lines: true, example: 'Thank you to everyone who helped raise £12,000 this year!' },
        { key: 'author', label: 'Name or source', max: 80, example: 'The fundraising team' },
      ],
    },
  ];

  const byId = (list, id) => list.find((x) => x.id === id);
  const template = (id) => byId(TEMPLATES, id) || TEMPLATES[0];
  const background = (id) => (id === 'image' ? IMAGE_BACKGROUND : byId(BACKGROUNDS, id) || BACKGROUNDS[0]);
  const font = (id) => byId(FONTS, id) || FONTS[0];
  const isColour = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

  /** The example text for a template, so a new slide starts out looking finished. */
  function exampleFields(templateId) {
    const out = {};
    for (const f of template(templateId).fields) out[f.key] = f.example || '';
    return out;
  }

  /**
   * Clean up slide settings from anywhere (a form, the API, an old version). Unknown values
   * fall back to defaults and text is trimmed to each field's limit. Picture ids are passed
   * through for the server to check.
   */
  function normalize(input = {}) {
    const t = template(input.template);
    const fields = {};
    const given = input.fields && typeof input.fields === 'object' ? input.fields : {};
    for (const f of t.fields) {
      let v = typeof given[f.key] === 'string' ? given[f.key] : '';
      v = v.replace(/\r\n?/g, '\n');
      v = f.lines ? v.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : v.replace(/\s+/g, ' ').trim();
      fields[f.key] = v.slice(0, f.max);
    }
    const bg = input.background === 'image' || byId(BACKGROUNDS, input.background) ? input.background : t.background;
    return {
      template: t.id,
      background: bg,
      font: font(input.font).id,
      accent: isColour(input.accent) ? input.accent.toLowerCase() : null,
      imageId: typeof input.imageId === 'string' && input.imageId ? input.imageId : null,
      backgroundImageId: bg === 'image' && typeof input.backgroundImageId === 'string' && input.backgroundImageId ? input.backgroundImageId : null,
      fields,
    };
  }

  // ---------- rendering ----------

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cssUrl = (u) => `url("${String(u).replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;

  /** Shrink long text: full size up to `fits` characters, then smaller, down to `min` of full size. */
  function scale(text, fits, min = 0.45) {
    const n = String(text || '').length;
    return n <= fits ? 1 : Math.max(min, Math.sqrt(fits / n));
  }
  const size = (base, text, fits, min) => `font-size:${(base * scale(text, fits, min)).toFixed(2)}cqmin`;

  const ICONS = {
    date: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    time: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.4" fill="currentColor"/></svg>',
  };

  // "Tomato soup  4.50" or "Mon – Fri 9:00 – 17:00": split a trailing price or time off a line.
  // After a clear gap (two spaces, dots, a dash run or a |) any number counts; after a single
  // space only something that looks like a price or a time does, so "Room 101" stays whole.
  const VALUE = '(?:[£$€¥₹]\\s?)?\\d[\\d.,:]*(?:\\s?(?:€|kr|am|pm|p))?(?:\\s?[-–]\\s?\\d[\\d.,:]*(?:\\s?(?:am|pm))?)?|free|closed';
  const AFTER_GAP = new RegExp(`^(.*?\\S)(?:\\s*[.…·\\-–—]{2,}\\s*|\\s*\\|\\s*|\\s{2,}|\\t+)(${VALUE})$`, 'i');
  const AFTER_SPACE = new RegExp(`^(.*?\\S)\\s(${VALUE})$`, 'i');
  const looksLikeValue = (v) => /[£$€¥₹:.,]|am|pm|kr|free|closed/i.test(v);

  function menuRows(text) {
    return String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        if (line.endsWith(':') && line.length > 1) return { heading: line.slice(0, -1) };
        let m = AFTER_GAP.exec(line);
        if (!m) {
          m = AFTER_SPACE.exec(line);
          if (m && !looksLikeValue(m[2])) m = null;
        }
        return m ? { name: m[1], price: m[2] } : { name: line, price: '' };
      });
  }

  const multi = (text) => esc(text).replace(/\n/g, '<br>');

  /**
   * Build a slide's HTML. `slide` is what the server sends: the normalized settings plus
   * `imageUrl` and `backgroundUrl` for any pictures. All text is escaped.
   */
  function toHTML(slide = {}) {
    const s = normalize(slide);
    const f = s.fields;
    const t = template(s.template);
    const bg = background(s.background);
    const accent = s.accent || bg.accent;
    const imageUrl = slide.imageUrl || null;
    const bgUrl = s.background === 'image' ? slide.backgroundUrl || null : null;

    const style = [`--accent:${accent}`, `font-family:${font(s.font).css.replace(/"/g, "'")}`];
    if (s.background === 'image') {
      style.push(
        bgUrl
          ? `background:linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,.6)), ${cssUrl(bgUrl)} center / cover no-repeat, #111`
          : 'background:linear-gradient(160deg, #2a2f3a, #14161b)',
      );
    } else style.push(`background:${bg.css}`);

    const img = (cls) => (imageUrl ? `<div class="sw-img ${cls}"><img src="${esc(imageUrl)}" alt=""></div>` : '');
    const text = (cls, value, extra = '') => (value ? `<div class="${cls}"${extra ? ` style="${extra}"` : ''}>${multi(value)}</div>` : '');
    let body = '';

    if (t.id === 'announcement') {
      body = `<div class="sw-main">
          ${text('sw-label', f.label)}
          ${text('sw-title', f.title, size(imageUrl ? 8.5 : 10, f.title, imageUrl ? 30 : 40))}
          ${text('sw-message', f.message, size(4.2, f.message, 140, 0.6))}
        </div>${img('sw-side')}${text('sw-footer', f.footer)}`;
    } else if (t.id === 'welcome') {
      body = `<div class="sw-center">${img('sw-logo')}
          ${text('sw-title', f.title, size(16, f.title, 10, 0.4))}
          ${text('sw-subtitle', f.subtitle, size(6, f.subtitle, 30, 0.55))}
          ${text('sw-message', f.message, size(3.8, f.message, 80, 0.6))}
        </div>`;
    } else if (t.id === 'event') {
      const facts = ['date', 'time', 'place']
        .filter((k) => f[k])
        .map((k) => `<div class="sw-fact">${ICONS[k]}<span>${esc(f[k])}</span></div>`)
        .join('');
      body = `<div class="sw-main">
          ${text('sw-label', f.label)}
          ${text('sw-title', f.title, size(imageUrl ? 9 : 11, f.title, imageUrl ? 22 : 28))}
          ${facts ? `<div class="sw-facts">${facts}</div>` : ''}
          ${text('sw-message', f.message, size(3.6, f.message, 120, 0.6))}
        </div>${img('sw-side')}`;
    } else if (t.id === 'menu') {
      const rows = menuRows(f.items);
      const count = rows.length;
      const twoCols = count > 9;
      // Size the rows to fill the space: an item row is about 2.3 times the font size tall,
      // a heading about 2. Roughly 54cqmin is left under the title.
      const headings = rows.filter((r) => r.heading !== undefined).length;
      const units = (count - headings) * 2.3 + headings * 2;
      const perCol = twoCols ? units / 2 + 1.2 : units;
      const rowSize = Math.max(1.8, Math.min(4.2, 54 / Math.max(perCol, 1)));
      const list = rows
        .map((r) =>
          r.heading !== undefined
            ? `<li class="sw-heading">${esc(r.heading)}</li>`
            : `<li><span class="sw-name">${esc(r.name)}</span>${r.price ? `<span class="sw-dots"></span><span class="sw-price">${esc(r.price)}</span>` : ''}</li>`,
        )
        .join('');
      body = `<div class="sw-menu-head">
          <div>${text('sw-title', f.title, size(8, f.title, 22))}${text('sw-subtitle', f.subtitle)}</div>${img('sw-corner')}
        </div>
        ${count ? `<ul class="sw-items${twoCols ? ' two' : ''}" style="font-size:${rowSize.toFixed(2)}cqmin">${list}</ul>` : ''}
        ${text('sw-footer', f.footer)}`;
    } else if (t.id === 'quote') {
      body = `<div class="sw-center">
          <div class="sw-mark" aria-hidden="true">“</div>
          ${text('sw-quote', f.message, size(11, f.message, 45, 0.4))}
          ${f.author || imageUrl ? `<div class="sw-author">${img('sw-avatar')}${f.author ? `<span>${esc(f.author)}</span>` : ''}</div>` : ''}
        </div>`;
    }

    const classes = ['sw-slide', `sw-t-${t.id}`, bg.dark ? 'sw-dark' : 'sw-light', imageUrl ? 'sw-has-img' : ''].filter(Boolean).join(' ');
    return `<div class="${classes}" style="${esc(style.join(';'))}"><div class="sw-inner">${body}</div></div>`;
  }

  /** A small swatch of a background, for pickers. */
  function swatchStyle(id) {
    const bg = background(id);
    return bg.css ? `background:${bg.css}` : 'background:linear-gradient(135deg,#475569,#1e293b)';
  }

  return { TEMPLATES, BACKGROUNDS, FONTS, IMAGE_BACKGROUND, template, background, normalize, exampleFields, menuRows, toHTML, swatchStyle };
});
