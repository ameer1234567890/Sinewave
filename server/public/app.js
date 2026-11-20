// Sinewave dashboard: a small single-page app with hash routing and no build step.

const view = document.getElementById('view');
const dialog = document.getElementById('dialog');

// The signed-in account. Standard users can't pair or remove screens, or manage users.
// The server enforces this too; the dashboard just hides what you can't use.
let me = null;
const isSuper = () => me?.role === 'super_admin';
const ROLE_NAMES = { super_admin: 'Super admin', standard: 'Standard' };

// ---------- utilities ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401 && !path.startsWith('/auth')) {
    showLogin();
    throw new Error('Signed out');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}
const fail = (err) => err.message !== 'Signed out' && toast(err.message, 'error');

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function bytes(n) {
  if (n === null || n === undefined) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const Slides = window.SinewaveSlides;

function preview(media) {
  if (media.kind === 'slide') return Slides.toHTML(media.slide);
  if (media.kind === 'image') return `<img src="${esc(media.url)}" alt="" loading="lazy">`;
  if (media.kind === 'video') return `<video src="${esc(media.url)}#t=1" muted preload="metadata"></video>`;
  if (media.kind === 'news') {
    const n = media.news || {};
    return `<div class="news-thumb ${n.options?.theme === 'light' ? 'light' : ''}" style="--news-accent:${esc(n.options?.accent || '#e5484d')}">
      ${n.image && n.options?.showImages !== false ? `<img src="${esc(n.image)}" alt="" loading="lazy">` : ''}
      <span class="news-thumb-text">${esc(n.headline || 'Waiting for headlines…')}</span></div>`;
  }
  return `<span>🌐 Web page</span>`;
}

/** Seconds a playlist item shows for when no duration is set. */
function defaultDuration(m) {
  if (m.kind === 'video') return 'full';
  if (m.kind === 'web') return 30;
  if (m.kind === 'slide') return 10;
  if (m.kind === 'news') return Math.max(1, m.news?.storyCount || 0) * (m.news?.options?.secondsPerStory || 10);
  return 10;
}

/** Show a modal built from HTML. Resolves with the submitted form's data, or null if cancelled. */
function modal(html, { onOpen, wide = false, xwide = false } = {}) {
  dialog.classList.toggle('wide', wide || xwide);
  dialog.classList.toggle('xwide', xwide);
  dialog.innerHTML = `<form method="dialog">${html}</form>`;
  const form = dialog.querySelector('form');
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.close();
      resolve(value);
    };
    form.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => done(null)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(Object.fromEntries(new FormData(form)));
    });
    dialog.onclose = () => resolve(null);
    dialog.showModal();
    onOpen?.(form, done);
  });
}

async function confirmModal(title, text, action = 'Delete') {
  const res = await modal(`
    <div class="dlg-body"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>
    <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button>
      <button class="btn primary" value="ok">${esc(action)}</button></div>`);
  return res !== null;
}

// ---------- auth ----------

function showLogin() {
  stopRefresh();
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  try {
    const res = await api('/auth/login', {
      method: 'POST',
      body: { username: e.target.username.value, password: e.target.password.value },
    });
    e.target.reset();
    err.hidden = true;
    startApp(res.user);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

document.getElementById('change-password').addEventListener('click', async () => {
  const res = await modal(
    `<div class="dlg-body form"><h2>Change your password</h2>
      <label>Current password <input type="password" name="currentPassword" required autocomplete="current-password"></label>
      <label>New password <input type="password" name="newPassword" required minlength="8" autocomplete="new-password"></label>
      <p class="muted" style="margin:0">At least 8 characters. You'll be signed out on your other devices.</p>
      <p class="form-error" hidden></p></div>
    <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Change password</button></div>`,
    { onOpen: submitInDialog((data) => api('/account/password', { method: 'POST', body: data })) },
  );
  if (res) toast('Password changed');
});

/** Dialog helper: run `action` on submit and keep the dialog open, showing the error, if it fails. */
function submitInDialog(action) {
  return (form, done) => {
    form.addEventListener(
      'submit',
      async (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          done((await action(Object.fromEntries(new FormData(form)))) ?? true);
        } catch (err) {
          const el = form.querySelector('.form-error');
          el.textContent = err.message;
          el.hidden = false;
        }
      },
      { capture: true },
    );
  };
}

// ---------- routing ----------

let refreshTimer;
function stopRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

const routes = [
  [/^#\/screens$/, 'screens', screensPage],
  [/^#\/media$/, 'media', mediaPage],
  [/^#\/playlists$/, 'playlists', playlistsPage],
  [/^#\/playlists\/([0-9a-f-]+)$/, 'playlists', playlistEditor],
  [/^#\/users$/, 'users', usersPage],
];

async function route() {
  stopRefresh();
  const hash = location.hash || '#/screens';
  const match = routes.find(([re]) => re.test(hash));
  if (!match) return (location.hash = '#/screens');
  const [re, nav, page] = match;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  try {
    await page(...hash.match(re).slice(1));
  } catch (err) {
    fail(err);
  }
}
window.addEventListener('hashchange', route);

async function startApp(user) {
  me = user;
  document.getElementById('me-name').textContent = me.username;
  document.getElementById('me-role').textContent = ROLE_NAMES[me.role] || me.role;
  document.querySelectorAll('[data-super]').forEach((el) => (el.hidden = !isSuper()));
  if (!isSuper() && location.hash === '#/users') location.hash = '#/screens';
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  await route();
}

// ---------- screens ----------

/**
 * The live preview for a screen card: whatever the screen reported it is showing right now.
 * Videos play muted in the card and web pages load scaled down, so it looks like the real screen.
 */
function screenPreview(s) {
  const m = s.nowPlayingMedia;
  if (!m) {
    const msg = !s.playlistId ? 'No playlist assigned' : s.nowPlaying === null && s.online ? 'Playlist is empty' : 'Nothing playing';
    return `<div class="preview-empty"><span>${esc(msg)}</span></div>`;
  }
  if (m.kind === 'image') return `<img src="${esc(m.url)}" alt="">`;
  if (m.kind === 'video') return `<video src="${esc(m.url)}" muted autoplay loop playsinline preload="auto"></video>`;
  if (m.kind === 'news' || m.kind === 'slide') return preview(m);
  // A dashboard shown inside a preview would preview itself forever; stop at one level.
  if (window.top !== window) return `<div class="preview-empty"><span>🌐 ${esc(m.name)}</span></div>`;
  return `<iframe src="${esc(m.url)}" tabindex="-1" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" allow="autoplay 'none'" title="${esc(m.name)}"></iframe>`;
}

/** Key that changes only when the preview content changes, so we don't restart videos every poll. */
const previewKey = (s) =>
  s.nowPlayingMedia
    ? `${s.nowPlayingMedia.id}|${s.nowPlayingMedia.url}|${s.nowPlayingMedia.slide ? JSON.stringify(s.nowPlayingMedia.slide) : ''}`
    : `none|${!!s.playlistId}|${s.online}`;

function screenCard(s) {
  const el = document.createElement('article');
  el.className = 'card screen-card';
  el.dataset.id = s.id;
  el.innerHTML = `
    <div class="screen-preview"><div class="preview-content"></div><span class="badge live-badge"></span></div>
    <div class="screen-body">
      <div class="screen-title">
        <div class="screen-name-wrap"><strong class="screen-name"></strong><div class="muted screen-ip"></div></div>
        <span class="status"><span class="dot"></span><span class="status-text"></span></span>
      </div>
      <div class="screen-meta">
        <div class="muted screen-conn"></div>
        <div class="screen-now"><span class="muted">Now playing</span> <span class="now-name"></span></div>
      </div>
      <label class="screen-playlist"><span class="muted">Playlist</span><select data-act="playlist"></select></label>
      <div class="actions">
        <button class="btn small" data-act="refresh" title="Re-sync content now">Refresh</button>
        <button class="btn small" data-act="reload" title="Restart the player page">Reload</button>
        <button class="btn small" data-act="rename">Rename</button>
        ${isSuper() ? '<button class="btn small danger" data-act="delete">Remove</button>' : ''}
      </div>
    </div>`;
  return el;
}

function updateScreenCard(el, s, playlists) {
  el.classList.toggle('offline', !s.online);
  el.querySelector('.screen-name').textContent = s.name;
  el.querySelector('.screen-ip').textContent = s.lastIp || '';
  el.querySelector('.dot').classList.toggle('on', s.online);
  el.querySelector('.status-text').textContent = s.online ? 'Online' : 'Offline';
  el.querySelector('.screen-conn').textContent = s.online
    ? s.connected
      ? 'Live connection'
      : 'Polling'
    : `Last seen ${timeAgo(s.lastSeenAt)}`;
  el.querySelector('.now-name').textContent = s.nowPlaying || '—';
  const badge = el.querySelector('.live-badge');
  badge.textContent = s.online ? 'Live' : 'Last seen';
  badge.classList.toggle('on', s.online);
  for (const act of ['refresh', 'reload']) el.querySelector(`[data-act=${act}]`).disabled = !s.connected;

  const key = previewKey(s);
  if (el.dataset.preview !== key) {
    el.dataset.preview = key;
    el.querySelector('.preview-content').innerHTML = screenPreview(s);
  }

  const select = el.querySelector('select');
  if (document.activeElement !== select) {
    select.innerHTML =
      `<option value="">No playlist</option>` +
      playlists.map((p) => `<option value="${p.id}" ${p.id === s.playlistId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  }
}

async function screensPage() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Screens</h1><div class="sub" id="screen-summary">&nbsp;</div></div>
      <div class="actions">${isSuper() ? '<button class="btn primary" id="pair">+ Pair screen</button>' : ''}</div>
    </div>
    <div id="screens"></div>`;
  if (isSuper()) document.getElementById('pair').onclick = pairScreen;

  const render = async () => {
    const [screens, playlists] = await Promise.all([api('/screens'), api('/playlists')]);
    const online = screens.filter((s) => s.online).length;
    const summary = document.getElementById('screen-summary');
    if (!summary) return;
    summary.textContent = screens.length ? `${online} of ${screens.length} online` : 'No screens yet';
    const box = document.getElementById('screens');
    if (!screens.length) {
      box.className = 'card';
      box.innerHTML = isSuper()
        ? `<div class="empty"><strong>No screens paired yet</strong>
        Open <a href="/player/" target="_blank" rel="noopener">/player/</a> on the display (in Chrome, ideally in kiosk mode),
        then choose <em>Pair screen</em> and type in the code it shows.</div>`
        : `<div class="empty"><strong>No screens paired yet</strong>Ask a super admin to pair a screen.</div>`;
      return;
    }
    if (box.className !== 'screen-grid') {
      box.className = 'screen-grid';
      box.innerHTML = '';
    }
    // Update cards in place so previews (videos, web pages) keep playing between refreshes.
    const existing = new Map([...box.children].map((el) => [el.dataset.id, el]));
    screens.forEach((s, i) => {
      let el = existing.get(s.id);
      existing.delete(s.id);
      if (!el) el = screenCard(s);
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      updateScreenCard(el, s, playlists);
    });
    for (const el of existing.values()) el.remove();
  };

  document.getElementById('screens').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'playlist') return;
    const id = e.target.closest('.screen-card').dataset.id;
    try {
      await api(`/screens/${id}`, { method: 'PATCH', body: { playlistId: e.target.value || null } });
      toast('Playlist assigned. The screen updates right away.');
      e.target.blur();
      render();
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('screens').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.screen-card');
    const id = card.dataset.id;
    const name = card.querySelector('.screen-name').textContent;
    try {
      if (btn.dataset.act === 'refresh' || btn.dataset.act === 'reload') {
        await api(`/screens/${id}/commands`, { method: 'POST', body: { command: btn.dataset.act } });
        toast(btn.dataset.act === 'refresh' ? 'Sent refresh' : 'Sent reload');
      } else if (btn.dataset.act === 'rename') {
        const res = await modal(`
          <div class="dlg-body form"><h2>Rename screen</h2>
            <label>Name <input name="name" value="${esc(name)}" required maxlength="200"></label></div>
          <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`);
        if (!res) return;
        await api(`/screens/${id}`, { method: 'PATCH', body: { name: res.name } });
      } else if (btn.dataset.act === 'delete') {
        if (!(await confirmModal(`Remove ${name}?`, 'The player will go back to showing a pairing code.', 'Remove'))) return;
        await api(`/screens/${id}`, { method: 'DELETE' });
        toast('Screen removed');
      }
      render();
    } catch (err) {
      fail(err);
    }
  });

  await render();
  // Poll often so the preview follows the screen closely.
  refreshTimer = setInterval(() => render().catch(() => {}), 3000);
}

async function pairScreen() {
  const playlists = await api('/playlists').catch(() => []);
  const res = await modal(
    `<div class="dlg-body form">
      <h2>Pair a screen</h2>
      <p class="muted" style="margin:0">Open <strong>${esc(location.origin)}/player/</strong> on the display and enter the 6-character code it shows.</p>
      <label>Pairing code <input class="code-input" name="code" required minlength="6" maxlength="7" autocomplete="off" spellcheck="false" placeholder="ABC123"></label>
      <label>Screen name <input name="name" required maxlength="200" placeholder="Reception lobby"></label>
      <label>Playlist <select name="playlistId"><option value="">None for now</option>${playlists
        .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
        .join('')}</select></label>
      <p class="form-error" hidden></p>
    </div>
    <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Pair screen</button></div>`,
    {
      onOpen(form, done) {
        form.addEventListener(
          'submit',
          async (e) => {
            // Validate against the server before closing, so a typo keeps the dialog open.
            e.preventDefault();
            e.stopImmediatePropagation();
            const data = Object.fromEntries(new FormData(form));
            try {
              const screen = await api('/screens/pair', { method: 'POST', body: data });
              done(screen);
            } catch (err) {
              const el = form.querySelector('.form-error');
              el.textContent = err.message;
              el.hidden = false;
            }
          },
          { capture: true },
        );
      },
    },
  );
  if (res) {
    toast(`Paired ${res.name}`);
    route();
  }
}

// ---------- media ----------

async function mediaPage() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Media</h1><div class="sub">Images, videos, slides, web pages and news to put in playlists</div></div>
      <div class="actions">
        <button class="btn" id="add-slide">+ Slide</button>
        <button class="btn" id="add-news">+ News</button>
        <button class="btn" id="add-web">+ Web page</button>
        <label class="btn primary" style="flex-direction:row">+ Upload<input type="file" id="file" multiple accept="image/*,video/*" hidden></label>
      </div>
    </div>
    <div class="dropzone" id="drop">Drop images or videos here to upload<div class="progress" hidden><div></div></div></div>
    <div id="media"></div>`;

  const render = async () => {
    const media = await api('/media');
    const box = document.getElementById('media');
    if (!media.length) {
      box.innerHTML = `<div class="card empty"><strong>No media yet</strong>Upload images or videos, make a slide, or add a web page or news feed.</div>`;
      return;
    }
    box.innerHTML = `<div class="grid">${media
      .map(
        (m) => `<div class="card tile" data-id="${m.id}">
        <div class="thumb">${preview(m)}<span class="badge">${m.kind}</span></div>
        <div class="tile-body"><div class="tile-name" title="${esc(m.name)}">${esc(m.name)}</div>
          <div class="muted">${mediaDetail(m)}${m.usedIn ? ` · in ${m.usedIn} playlist${m.usedIn > 1 ? 's' : ''}` : ''}</div>
          ${m.news?.error ? `<div class="muted" style="color:var(--warn)" title="${esc(m.news.error)}">⚠ Last update failed</div>` : ''}</div>
        <div class="tile-foot">${
          m.kind === 'news'
            ? '<button class="link" data-act="news">Settings</button>'
            : m.kind === 'slide'
              ? '<button class="link" data-act="slide">Edit</button><button class="link" data-act="duplicate">Duplicate</button>'
              : '<button class="link" data-act="rename">Rename</button>'
        }<button class="link" data-act="delete" style="color:var(--danger)">Delete</button></div>
      </div>`,
      )
      .join('')}</div>`;
  };

  const uploadFiles = async (files) => {
    if (!files.length) return;
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const bar = document.querySelector('#drop .progress');
    bar.hidden = false;
    // XHR rather than fetch so we can show upload progress.
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media');
      xhr.upload.onprogress = (e) => e.lengthComputable && (bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`);
      xhr.onload = () => {
        if (xhr.status === 401) showLogin();
        else if (xhr.status >= 400) toast(JSON.parse(xhr.responseText || '{}').error || 'Upload failed', 'error');
        else toast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`);
        resolve();
      };
      xhr.onerror = () => {
        toast('Upload failed', 'error');
        resolve();
      };
      xhr.send(form);
    });
    bar.hidden = true;
    bar.firstElementChild.style.width = '0';
    render();
  };

  document.getElementById('file').onchange = (e) => uploadFiles([...e.target.files]);
  const drop = document.getElementById('drop');
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    uploadFiles([...e.dataTransfer.files]);
  };

  document.getElementById('add-slide').onclick = async () => {
    if (await slideDialog()) render();
  };

  document.getElementById('add-news').onclick = async () => {
    if (await newsDialog()) render();
  };

  document.getElementById('add-web').onclick = async () => {
    const res = await modal(`
      <div class="dlg-body form"><h2>Add a web page</h2>
        <label>URL <input name="url" type="url" required placeholder="https://example.com/menu"></label>
        <label>Name <input name="name" maxlength="200" placeholder="Optional"></label>
        <p class="muted" style="margin:0">Some sites refuse to be shown inside other pages. Web pages always load live and aren't cached offline.</p></div>
      <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Add</button></div>`);
    if (!res) return;
    await api('/media/web', { method: 'POST', body: res }).catch(fail);
    render();
  };

  document.getElementById('media').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const tile = btn.closest('.tile');
    const id = tile.dataset.id;
    const name = tile.querySelector('.tile-name').textContent;
    try {
      if (btn.dataset.act === 'news') {
        const media = (await api('/media')).find((m) => m.id === id);
        if (!media) return render();
        if (await newsDialog(media)) render();
        return;
      }
      if (btn.dataset.act === 'slide' || btn.dataset.act === 'duplicate') {
        const media = (await api('/media')).find((m) => m.id === id);
        if (!media) return render();
        if (btn.dataset.act === 'slide') {
          if (await slideDialog(media)) render();
          return;
        }
        await api('/media/slide', { method: 'POST', body: { name: `${media.name} (copy)`, options: media.slide } });
        toast('Slide duplicated');
        return render();
      }
      if (btn.dataset.act === 'rename') {
        const res = await modal(`
          <div class="dlg-body form"><h2>Rename</h2><label>Name <input name="name" value="${esc(name)}" required maxlength="200"></label></div>
          <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`);
        if (!res) return;
        await api(`/media/${id}`, { method: 'PATCH', body: res });
      } else {
        const isImage = tile.querySelector('.badge')?.textContent === 'image';
        const note = isImage ? ' Slides that use this picture will show without it.' : '';
        if (!(await confirmModal(`Delete ${name}?`, `It will also be removed from every playlist that uses it.${note}`))) return;
        await api(`/media/${id}`, { method: 'DELETE' });
        toast('Deleted');
      }
      render();
    } catch (err) {
      fail(err);
    }
  });

  await render();
}

function mediaDetail(m) {
  if (m.kind === 'slide') return `${esc(Slides.template(m.slide?.template).name)} slide`;
  if (m.kind === 'web') return esc(new URL(m.url).hostname);
  if (m.kind === 'news') {
    const n = m.news || {};
    return `${esc(n.feedTitle || new URL(m.url).hostname)}${n.storyCount ? ` · ${n.storyCount} stories` : ''}`;
  }
  return bytes(m.sizeBytes);
}

// ---------- news ----------

let popularFeeds;

const NEWS_LAYOUTS = [
  ['feature', 'Feature', 'Full-screen photo with the headline over it'],
  ['split', 'Split', 'Photo on the left, story on the right'],
  ['headlines', 'Headlines', 'A list of headlines, one highlighted at a time'],
];

/** Add a news item, or change one (pass the media). Resolves with the saved media, or null if cancelled. */
async function newsDialog(media = null) {
  popularFeeds ??= await api('/news/feeds').catch(() => []);
  const o = media?.news?.options || {
    layout: 'feature', theme: 'dark', accent: '#e5484d', maxStories: 8, secondsPerStory: 10,
    showImages: true, showSummary: true, showTime: true, label: '',
  };
  const current = media?.news?.feedUrl || popularFeeds[0]?.feeds[0]?.url || '';
  const known = popularFeeds.some((g) => g.feeds.some((f) => f.url === current));
  const checked = (b) => (b ? 'checked' : '');

  const html = `
    <div class="dlg-body form news-form">
      <h2>${media ? 'News settings' : 'Add news'}</h2>
      <p class="muted" style="margin:-8px 0 0">Headlines from an RSS or Atom feed, shown as a full-screen slide. Feeds refresh every 15 minutes, and screens keep the latest stories for offline playback.</p>
      <fieldset><legend>Feed</legend>
        <div class="feed-picker">${popularFeeds
          .map(
            (g) => `<div class="feed-group"><div class="feed-group-name">${esc(g.group)}</div><div class="chips">${g.feeds
              .map((f) => `<label class="chip"><input type="radio" name="feedChoice" value="${esc(f.url)}" data-name="${esc(f.name)}" ${f.url === current ? 'checked' : ''}><span>${esc(f.name)}</span></label>`)
              .join('')}</div></div>`,
          )
          .join('')}
          <div class="feed-group"><div class="feed-group-name">Your own</div><div class="chips">
            <label class="chip"><input type="radio" name="feedChoice" value="custom" ${known ? '' : 'checked'}><span>Custom feed URL…</span></label></div></div>
        </div>
        <label class="custom-url" ${known ? 'hidden' : ''}>Feed URL <input name="customUrl" type="url" placeholder="https://example.com/feed.xml" value="${known ? '' : esc(current)}"></label>
      </fieldset>
      <label>Name <input name="name" maxlength="200" placeholder="Defaults to the feed's name" value="${esc(media?.name || '')}"></label>
      <fieldset><legend>Layout</legend>
        <div class="layout-picker">${NEWS_LAYOUTS.map(
          ([v, label, hint]) => `<label class="layout-opt" title="${esc(hint)}"><input type="radio" name="layout" value="${v}" ${o.layout === v ? 'checked' : ''}>
            <span class="layout-art art-${v}"><i></i><b></b><b></b><b></b></span><span>${label}</span></label>`,
        ).join('')}</div>
      </fieldset>
      <div class="row3">
        <label>Theme <select name="theme"><option value="dark" ${o.theme === 'dark' ? 'selected' : ''}>Dark</option><option value="light" ${o.theme === 'light' ? 'selected' : ''}>Light</option></select></label>
        <label>Accent <input type="color" name="accent" value="${esc(o.accent)}"></label>
        <label>Header text <input name="label" maxlength="80" placeholder="Feed name" value="${esc(o.label || '')}"></label>
      </div>
      <div class="row3">
        <label>Stories <input type="number" name="maxStories" min="1" max="20" value="${o.maxStories}"></label>
        <label>Seconds each <input type="number" name="secondsPerStory" min="3" max="120" value="${o.secondsPerStory}"></label>
        <div class="muted total-time" style="align-self:end;padding-bottom:8px"></div>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="showImages" ${checked(o.showImages)}> Photos</label>
        <label class="check"><input type="checkbox" name="showSummary" ${checked(o.showSummary)}> Summaries</label>
        <label class="check"><input type="checkbox" name="showTime" ${checked(o.showTime)}> How long ago</label>
      </div>
      <p class="form-error" hidden></p>
    </div>
    <div class="dlg-foot">
      ${media ? '<button type="button" class="btn" data-refresh style="margin-right:auto">Refresh now</button>' : ''}
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button class="btn primary">${media ? 'Save' : 'Add news'}</button>
    </div>`;

  const save = async (data) => {
    const feedUrl = data.feedChoice === 'custom' ? (data.customUrl || '').trim() : data.feedChoice;
    if (!feedUrl) throw new Error('Pick a feed, or enter a feed URL');
    const body = {
      feedUrl,
      name: data.name,
      options: {
        layout: data.layout,
        theme: data.theme,
        accent: data.accent,
        label: data.label,
        maxStories: Number(data.maxStories),
        secondsPerStory: Number(data.secondsPerStory),
        showImages: data.showImages === 'on',
        showSummary: data.showSummary === 'on',
        showTime: data.showTime === 'on',
      },
    };
    const btn = dialog.querySelector('.dlg-foot .primary');
    btn.disabled = true;
    btn.textContent = 'Checking feed…';
    try {
      return media
        ? await api(`/media/${media.id}/news`, { method: 'PUT', body })
        : await api('/media/news', { method: 'POST', body });
    } finally {
      btn.disabled = false;
      btn.textContent = media ? 'Save' : 'Add news';
    }
  };

  const res = await modal(html, {
    wide: true,
    onOpen: (form, done) => {
      submitInDialog(save)(form, done);
      const custom = form.querySelector('.custom-url');
      const total = form.querySelector('.total-time');
      const updateTotal = () => {
        const secs = Number(form.maxStories.value) * Number(form.secondsPerStory.value);
        total.textContent = secs ? `About ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60 ? `${secs % 60} s` : ''}` : `${secs} s`} per loop` : '';
      };
      form.addEventListener('input', updateTotal);
      updateTotal();
      form.querySelectorAll('input[name=feedChoice]').forEach((r) =>
        r.addEventListener('change', () => {
          custom.hidden = r.value !== 'custom' || !r.checked;
          if (!custom.hidden) form.customUrl.focus();
        }),
      );
      // Scroll the feed list (only the list, not the dialog) to the chosen feed.
      const picker = form.querySelector('.feed-picker');
      const chosen = form.querySelector('input[name=feedChoice]:checked')?.closest('.feed-group');
      if (chosen) picker.scrollTop = chosen.offsetTop - 8;
      form.querySelector('[data-refresh]')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Refreshing…';
        try {
          await api(`/media/${media.id}/news/refresh`, { method: 'POST' });
          toast('Feed refreshed');
        } catch (err) {
          fail(err);
        } finally {
          e.target.disabled = false;
          e.target.textContent = 'Refresh now';
        }
      });
    },
  });
  if (res) toast(media ? 'News settings saved' : `Added ${res.name}`);
  return res;
}

// ---------- slides ----------

/**
 * Make a slide, or edit one (pass the media). Pick a template and a background, fill in the
 * text, and optionally add a picture. A live preview shows exactly what screens will show.
 * Resolves with the saved media, or null if cancelled.
 */
async function slideDialog(media = null) {
  let images = (await api('/media')).filter((m) => m.kind === 'image');
  const start = media?.slide || { template: Slides.TEMPLATES[0].id };
  const s = Slides.normalize(start);
  // Text typed so far, kept across template changes so switching doesn't lose anything.
  const values = media ? { ...s.fields } : Slides.exampleFields(s.template);
  let bgTouched = Boolean(media);
  let accent = s.accent; // null means "use the background's colour"

  const tplArt = (t) => Slides.toHTML({ template: t.id, background: t.background, fields: Slides.exampleFields(t.id) });
  const picker = (name, selected, noneLabel) => `
    <div class="pic-picker" data-picker="${name}">
      <label class="pic-opt pic-none"><input type="radio" name="${name}" value="" ${selected ? '' : 'checked'}><span>${noneLabel}</span></label>
      ${images
        .map(
          (m) => `<label class="pic-opt" title="${esc(m.name)}"><input type="radio" name="${name}" value="${m.id}" ${m.id === selected ? 'checked' : ''}>
            <span><img src="${esc(m.url)}" alt="${esc(m.name)}" loading="lazy"></span></label>`,
        )
        .join('')}
      <label class="pic-opt pic-upload" title="Upload a picture"><input type="file" accept="image/*" data-upload="${name}"><span>+ Upload</span></label>
    </div>`;

  const html = `
    <div class="dlg-body form slide-form">
      <h2>${media ? 'Edit slide' : 'New slide'}</h2>
      <div class="slide-editor">
        <div class="slide-controls">
          <fieldset><legend>Template</legend>
            <div class="tpl-picker">${Slides.TEMPLATES.map(
              (t) => `<label class="tpl-opt" title="${esc(t.hint)}"><input type="radio" name="template" value="${t.id}" ${t.id === s.template ? 'checked' : ''}>
                <span class="tpl-art">${tplArt(t)}</span><span>${esc(t.name)}</span></label>`,
            ).join('')}</div>
          </fieldset>
          <fieldset><legend>Background</legend>
            <div class="bg-picker">${[...Slides.BACKGROUNDS, Slides.IMAGE_BACKGROUND]
              .map(
                (b) => `<label class="bg-opt" title="${esc(b.name)}"><input type="radio" name="background" value="${b.id}" ${b.id === s.background ? 'checked' : ''}>
                  <span class="bg-swatch${b.id === 'image' ? ' bg-image-swatch' : ''}" style="${esc(Slides.swatchStyle(b.id))}">${b.id === 'image' ? '🖼' : ''}</span><span class="bg-name">${esc(b.name)}</span></label>`,
              )
              .join('')}</div>
            <div class="bg-image-pick" ${s.background === 'image' ? '' : 'hidden'}>${picker('backgroundImageId', s.backgroundImageId, 'Choose…')}</div>
          </fieldset>
          <fieldset><legend>Text</legend><div class="slide-fields"></div></fieldset>
          <fieldset><legend class="image-legend"></legend>${picker('imageId', s.imageId, 'None')}</fieldset>
          <div class="row3">
            <label>Font <select name="font">${Slides.FONTS.map((f) => `<option value="${f.id}" ${f.id === s.font ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
            <label>Highlight colour <span class="accent-row"><input type="color" name="accentPick"><button type="button" class="link" data-accent-reset>Auto</button></span></label>
            <label>Name <input name="name" maxlength="200" placeholder="Defaults to the headline" value="${esc(media?.name || '')}"></label>
          </div>
          <p class="form-error" hidden></p>
        </div>
        <div class="slide-preview-col">
          <div class="slide-preview"></div>
          <p class="muted">Preview at 16:9. Screens show it full screen, and it stays sharp at any size.</p>
        </div>
      </div>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button class="btn primary">${media ? 'Save' : 'Add slide'}</button>
    </div>`;

  const res = await modal(html, {
    xwide: true,
    onOpen: (form, done) => {
      const fieldsBox = form.querySelector('.slide-fields');
      const previewBox = form.querySelector('.slide-preview');
      const accentPick = form.accentPick;
      const checkedValue = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value || '';
      const imageUrl = (id) => images.find((m) => m.id === id)?.url || null;

      function current() {
        return Slides.normalize({
          template: checkedValue('template'),
          background: checkedValue('background'),
          font: form.font.value,
          accent,
          imageId: checkedValue('imageId') || null,
          backgroundImageId: checkedValue('backgroundImageId') || null,
          fields: values,
        });
      }

      function renderFields() {
        const t = Slides.template(checkedValue('template'));
        fieldsBox.innerHTML = t.fields
          .map((f) => {
            const attrs = `name="f-${f.key}" data-field="${f.key}" maxlength="${f.max}" placeholder="${esc(f.example || '')}"`;
            const input = f.lines
              ? `<textarea ${attrs} rows="${f.rows || 3}">${esc(values[f.key] || '')}</textarea>`
              : `<input ${attrs} value="${esc(values[f.key] || '')}">`;
            return `<label>${esc(f.label)}${input}${f.help ? `<span class="muted field-help">${esc(f.help)}</span>` : ''}</label>`;
          })
          .join('');
        form.querySelector('.image-legend').textContent = t.image;
      }

      function renderPreview() {
        const slide = current();
        previewBox.innerHTML = Slides.toHTML({ ...slide, imageUrl: imageUrl(slide.imageId), backgroundUrl: imageUrl(slide.backgroundImageId) });
        if (!accent) accentPick.value = Slides.background(slide.background).accent;
        form.querySelector('.bg-image-pick').hidden = slide.background !== 'image';
      }

      form.addEventListener('change', (e) => {
        const name = e.target.name;
        if (name === 'template') {
          const t = Slides.template(e.target.value);
          // Swap example text for the new template's examples, but keep anything the user typed.
          const examples = Object.fromEntries(Slides.TEMPLATES.flatMap((x) => x.fields.map((f) => [`${x.id}.${f.key}`, f.example])));
          const isExample = (key) => !values[key] || Slides.TEMPLATES.some((x) => examples[`${x.id}.${key}`] === values[key]);
          for (const f of t.fields) if (isExample(f.key)) values[f.key] = f.example || '';
          if (!bgTouched) form.querySelector(`input[name=background][value="${t.background}"]`).checked = true;
          renderFields();
        }
        if (name === 'background') bgTouched = true;
        renderPreview();
      });
      form.addEventListener('input', (e) => {
        if (e.target.dataset.field) values[e.target.dataset.field] = e.target.value;
        if (e.target === accentPick) accent = accentPick.value;
        renderPreview();
      });
      form.querySelector('[data-accent-reset]').addEventListener('click', () => {
        accent = null;
        renderPreview();
      });

      // Upload a picture from inside the editor; it lands in Media like any other upload.
      form.addEventListener('change', async (e) => {
        const target = e.target.dataset.upload;
        if (!target || !e.target.files.length) return;
        const label = e.target.closest('.pic-upload').querySelector('span');
        label.textContent = 'Uploading…';
        try {
          const body = new FormData();
          body.append('files', e.target.files[0]);
          const [created] = await api('/media', { method: 'POST', form: body });
          images = [created, ...images];
          for (const p of form.querySelectorAll('[data-picker]')) {
            const opt = document.createElement('label');
            opt.className = 'pic-opt';
            opt.title = created.name;
            opt.innerHTML = `<input type="radio" name="${p.dataset.picker}" value="${created.id}"><span><img src="${esc(created.url)}" alt="${esc(created.name)}"></span>`;
            p.querySelector('.pic-none').after(opt);
          }
          form.querySelector(`input[name="${target}"][value="${created.id}"]`).checked = true;
          renderPreview();
        } catch (err) {
          fail(err);
        } finally {
          label.textContent = '+ Upload';
          e.target.value = '';
        }
      });

      submitInDialog(async (data) => {
        const options = current();
        if (options.background === 'image' && !options.backgroundImageId) throw new Error('Choose a picture for the background, or pick another background');
        const body = { name: data.name, options };
        return media
          ? await api(`/media/${media.id}/slide`, { method: 'PUT', body })
          : await api('/media/slide', { method: 'POST', body });
      })(form, done);

      renderFields();
      renderPreview();
    },
  });
  if (res) toast(media ? 'Slide saved. Screens showing it update right away.' : `Added ${res.name}`);
  return res;
}

// ---------- playlists ----------

async function playlistsPage() {
  const playlists = await api('/playlists');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Playlists</h1><div class="sub">Ordered loops of content you assign to screens</div></div>
      <div class="actions"><button class="btn primary" id="new">+ New playlist</button></div>
    </div>
    <div class="card table-wrap">${
      playlists.length
        ? `<table><thead><tr><th>Name</th><th>Items</th><th>Screens</th><th>Updated</th><th></th></tr></thead><tbody>${playlists
            .map(
              (p) => `<tr data-id="${p.id}"><td><a href="#/playlists/${p.id}"><strong>${esc(p.name)}</strong></a></td>
              <td>${p.itemCount}</td><td>${p.screenCount}</td><td class="muted">${timeAgo(p.updatedAt)}</td>
              <td><div class="actions"><a class="btn small" href="#/playlists/${p.id}">Edit</a>
              <button class="btn small danger" data-act="delete" data-name="${esc(p.name)}">Delete</button></div></td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<div class="empty"><strong>No playlists yet</strong>Create one, add media to it, then assign it to a screen.</div>`
    }</div>`;

  document.getElementById('new').onclick = async () => {
    const res = await modal(`
      <div class="dlg-body form"><h2>New playlist</h2><label>Name <input name="name" required maxlength="200" placeholder="Lobby loop"></label></div>
      <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Create</button></div>`);
    if (!res) return;
    const pl = await api('/playlists', { method: 'POST', body: res }).catch(fail);
    if (pl) location.hash = `#/playlists/${pl.id}`;
  };

  view.querySelector('tbody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="delete"]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (!(await confirmModal(`Delete ${btn.dataset.name}?`, 'Screens using it will show nothing until you assign another playlist.'))) return;
    await api(`/playlists/${id}`, { method: 'DELETE' }).catch(fail);
    route();
  });
}

async function playlistEditor(id) {
  const [playlist, library] = await Promise.all([api(`/playlists/${id}`), api('/media')]);
  // Local working copy; nothing is sent until Save.
  let items = playlist.items.map((i) => ({ media: i.media, durationSeconds: i.durationSeconds }));
  let dirty = false;

  view.innerHTML = `
    <div class="page-head">
      <div style="flex:1;min-width:240px"><a href="#/playlists" class="muted">← Playlists</a>
        <input id="pl-name" value="${esc(playlist.name)}" maxlength="200" style="font-size:20px;font-weight:700;margin-top:6px;max-width:420px"></div>
      <div class="actions"><span class="muted" id="pl-meta"></span><button class="btn primary" id="save">Save</button></div>
    </div>
    <div class="editor">
      <div class="card"><ul class="items" id="items"></ul></div>
      <div class="card"><div style="padding:14px 14px 6px"><h2 style="margin:0">Add media</h2></div>
        <div class="library" id="library">${
          library.length
            ? library
                .map(
                  (m) => `<div class="lib-item"><div class="mini">${preview(m)}</div>
                  <div style="min-width:0"><div class="name" title="${esc(m.name)}">${esc(m.name)}</div><div class="muted">${m.kind}</div></div>
                  <button class="btn small" data-add="${m.id}">Add</button></div>`,
                )
                .join('')
            : `<div class="empty">No media yet. <a href="#/media">Upload some</a>.</div>`
        }</div></div>
    </div>`;

  const nameInput = document.getElementById('pl-name');
  nameInput.oninput = () => markDirty();

  function markDirty() {
    dirty = true;
    document.getElementById('save').textContent = 'Save changes';
  }

  function renderItems() {
    const list = document.getElementById('items');
    const total = items.reduce((t, i) => t + (i.durationSeconds || (i.media.kind === 'video' ? 0 : defaultDuration(i.media))), 0);
    document.getElementById('pl-meta').textContent = `${items.length} item${items.length === 1 ? '' : 's'}${total ? ` · ~${Math.round(total)}s loop` : ''}`;
    if (!items.length) {
      list.innerHTML = `<li class="empty"><strong>This playlist is empty</strong>Add media from the list on the right.</li>`;
      return;
    }
    list.innerHTML = items
      .map(
        (i, idx) => `<li class="item" data-idx="${idx}">
        <span class="num">${idx + 1}</span>
        <div class="mini">${preview(i.media)}</div>
        <div style="min-width:0"><div class="tile-name">${esc(i.media.name)}</div><div class="muted">${i.media.kind}</div></div>
        <div class="dur"><input type="number" min="1" max="86400" step="1" data-dur placeholder="${defaultDuration(i.media)}" value="${i.durationSeconds ?? ''}" title="Seconds on screen. Leave blank for the default${i.media.kind === 'video' ? ' (play the whole video)' : i.media.kind === 'news' ? ' (show every story once)' : ''}."><span class="muted">s</span></div>
        <div class="btns">
          <button class="icon-btn" data-move="-1" ${idx === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="icon-btn" data-move="1" ${idx === items.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="icon-btn" data-remove title="Remove">✕</button>
        </div></li>`,
      )
      .join('');
  }

  document.getElementById('items').addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    const idx = Number(li.dataset.idx);
    const move = e.target.closest('[data-move]');
    if (move) {
      const to = idx + Number(move.dataset.move);
      [items[idx], items[to]] = [items[to], items[idx]];
    } else if (e.target.closest('[data-remove]')) {
      items.splice(idx, 1);
    } else return;
    markDirty();
    renderItems();
  });

  document.getElementById('items').addEventListener('input', (e) => {
    if (!e.target.matches('[data-dur]')) return;
    const idx = Number(e.target.closest('.item').dataset.idx);
    const v = e.target.value.trim();
    items[idx].durationSeconds = v === '' ? null : Math.max(1, Math.round(Number(v)));
    markDirty();
  });

  document.getElementById('library').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const media = library.find((m) => m.id === btn.dataset.add);
    items.push({ media, durationSeconds: null });
    markDirty();
    renderItems();
  });

  document.getElementById('save').onclick = async () => {
    try {
      const saved = await api(`/playlists/${id}`, {
        method: 'PUT',
        body: {
          name: nameInput.value,
          items: items.map((i) => ({ mediaId: i.media.id, durationSeconds: i.durationSeconds })),
        },
      });
      items = saved.items.map((i) => ({ media: i.media, durationSeconds: i.durationSeconds }));
      dirty = false;
      document.getElementById('save').textContent = 'Saved';
      renderItems();
      toast('Saved. Screens using this playlist update right away.');
    } catch (err) {
      fail(err);
    }
  };

  window.onbeforeunload = () => (dirty ? true : undefined);
  window.addEventListener('hashchange', () => (window.onbeforeunload = null), { once: true });
  renderItems();
}

// ---------- users ----------

async function usersPage() {
  const users = await api('/users');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Users</h1><div class="sub">Super admins can do everything. Standard users can edit screens, media and playlists, but can't pair or remove screens or manage users.</div></div>
      <div class="actions"><button class="btn primary" id="add-user">+ Add user</button></div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Username</th><th>Role</th><th>Last signed in</th><th></th></tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr data-id="${u.id}" data-name="${esc(u.username)}" data-role="${u.role}">
          <td><strong>${esc(u.username)}</strong>${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
          <td><span class="role-badge ${u.role === 'super_admin' ? 'super' : ''}">${esc(ROLE_NAMES[u.role] || u.role)}</span></td>
          <td class="muted">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</td>
          <td><div class="actions">
            <button class="btn small" data-act="edit">Edit</button>
            <button class="btn small" data-act="password">Set password</button>
            ${u.id === me.id ? '' : '<button class="btn small danger" data-act="delete">Delete</button>'}
          </div></td></tr>`,
        )
        .join('')}</tbody></table></div>`;

  const roleSelect = (selected) =>
    `<select name="role">${Object.entries(ROLE_NAMES)
      .map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`)
      .join('')}</select>`;

  document.getElementById('add-user').onclick = async () => {
    const res = await modal(
      `<div class="dlg-body form"><h2>Add a user</h2>
        <label>Username <input name="username" required maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="sam"></label>
        <label>Password <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <label>Role ${roleSelect('standard')}</label>
        <p class="muted" style="margin:0">Share the password with them. They can change it after signing in.</p>
        <p class="form-error" hidden></p></div>
      <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Add user</button></div>`,
      { onOpen: submitInDialog((data) => api('/users', { method: 'POST', body: data })) },
    );
    if (res) {
      toast(`Added ${res.username}`);
      route();
    }
  };

  view.querySelector('tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('tr');
    const { id, name, role } = row.dataset;
    try {
      if (btn.dataset.act === 'edit') {
        const res = await modal(
          `<div class="dlg-body form"><h2>Edit ${esc(name)}</h2>
            <label>Username <input name="username" value="${esc(name)}" required maxlength="64" autocapitalize="none" spellcheck="false"></label>
            <label>Role ${roleSelect(role)}</label>
            <p class="form-error" hidden></p></div>
          <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`,
          { onOpen: submitInDialog((data) => api(`/users/${id}`, { method: 'PATCH', body: data })) },
        );
        if (!res) return;
        if (id === me.id) return startApp(res);
        toast('Saved');
      } else if (btn.dataset.act === 'password') {
        const res = await modal(
          `<div class="dlg-body form"><h2>Set a new password for ${esc(name)}</h2>
            <label>New password <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
            <p class="muted" style="margin:0">${id === me.id ? 'Your other devices will be signed out.' : 'They will be signed out everywhere and need the new password.'}</p>
            <p class="form-error" hidden></p></div>
          <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Set password</button></div>`,
          { onOpen: submitInDialog((data) => api(`/users/${id}`, { method: 'PATCH', body: data })) },
        );
        if (!res) return;
        toast('Password changed');
      } else if (btn.dataset.act === 'delete') {
        if (!(await confirmModal(`Delete ${name}?`, 'They will be signed out and can no longer sign in.'))) return;
        await api(`/users/${id}`, { method: 'DELETE' });
        toast('User deleted');
      }
      route();
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- boot ----------

api('/auth/session')
  .then((s) => (s.signedIn ? startApp(s.user) : showLogin()))
  .catch(() => showLogin());
