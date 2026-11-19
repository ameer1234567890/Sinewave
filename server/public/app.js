// Sinewave dashboard: a small single-page app with hash routing and no build step.

const view = document.getElementById('view');
const dialog = document.getElementById('dialog');

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

function preview(media) {
  if (media.kind === 'image') return `<img src="${esc(media.url)}" alt="" loading="lazy">`;
  if (media.kind === 'video') return `<video src="${esc(media.url)}#t=1" muted preload="metadata"></video>`;
  return `<span>🌐 Web page</span>`;
}

/** Show a modal built from HTML. Resolves with the submitted form's data, or null if cancelled. */
function modal(html, { onOpen } = {}) {
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
    await api('/auth/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    err.hidden = true;
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

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

async function startApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  await route();
}

// ---------- screens ----------

async function screensPage() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Screens</h1><div class="sub" id="screen-summary">&nbsp;</div></div>
      <div class="actions"><button class="btn primary" id="pair">+ Pair screen</button></div>
    </div>
    <div class="card table-wrap" id="screens"></div>`;
  document.getElementById('pair').onclick = pairScreen;

  const render = async () => {
    const [screens, playlists] = await Promise.all([api('/screens'), api('/playlists')]);
    const online = screens.filter((s) => s.online).length;
    document.getElementById('screen-summary').textContent = screens.length
      ? `${online} of ${screens.length} online`
      : 'No screens yet';
    const box = document.getElementById('screens');
    if (!box) return;
    // Don't clobber a dropdown the user is using.
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    if (!screens.length) {
      box.innerHTML = `<div class="empty"><strong>No screens paired yet</strong>
        Open <a href="/player/" target="_blank" rel="noopener">/player/</a> on the display (in Chrome, ideally in kiosk mode),
        then choose <em>Pair screen</em> and type in the code it shows.</div>`;
      return;
    }
    const options = (selected) =>
      `<option value="">No playlist</option>` +
      playlists.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    box.innerHTML = `<table>
      <thead><tr><th>Screen</th><th>Status</th><th>Playlist</th><th>Now playing</th><th></th></tr></thead>
      <tbody>${screens
        .map(
          (s) => `<tr data-id="${s.id}">
          <td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.lastIp || '')}</div></td>
          <td><span class="status"><span class="dot ${s.online ? 'on' : ''}"></span>${s.online ? 'Online' : 'Offline'}</span>
            <div class="muted">${s.online ? (s.connected ? 'Live connection' : 'Polling') : `Last seen ${timeAgo(s.lastSeenAt)}`}</div></td>
          <td><select data-act="playlist">${options(s.playlistId)}</select></td>
          <td class="muted">${esc(s.nowPlaying || '—')}</td>
          <td><div class="actions">
            <button class="btn small" data-act="refresh" ${s.connected ? '' : 'disabled'} title="Re-sync content now">Refresh</button>
            <button class="btn small" data-act="reload" ${s.connected ? '' : 'disabled'} title="Restart the player page">Reload</button>
            <button class="btn small" data-act="rename">Rename</button>
            <button class="btn small danger" data-act="delete">Remove</button>
          </div></td></tr>`,
        )
        .join('')}</tbody></table>`;
  };

  document.getElementById('screens').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'playlist') return;
    const id = e.target.closest('tr').dataset.id;
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
    const row = btn.closest('tr');
    const id = row.dataset.id;
    const name = row.querySelector('strong').textContent;
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
  refreshTimer = setInterval(() => render().catch(() => {}), 5000);
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
      <div><h1>Media</h1><div class="sub">Images, videos and web pages to put in playlists</div></div>
      <div class="actions">
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
      box.innerHTML = `<div class="card empty"><strong>No media yet</strong>Upload images or videos, or add a web page.</div>`;
      return;
    }
    box.innerHTML = `<div class="grid">${media
      .map(
        (m) => `<div class="card tile" data-id="${m.id}">
        <div class="thumb">${preview(m)}<span class="badge">${m.kind}</span></div>
        <div class="tile-body"><div class="tile-name" title="${esc(m.name)}">${esc(m.name)}</div>
          <div class="muted">${m.kind === 'web' ? esc(new URL(m.url).hostname) : bytes(m.sizeBytes)}${m.usedIn ? ` · in ${m.usedIn} playlist${m.usedIn > 1 ? 's' : ''}` : ''}</div></div>
        <div class="tile-foot"><button class="link" data-act="rename">Rename</button><button class="link" data-act="delete" style="color:var(--danger)">Delete</button></div>
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
      if (btn.dataset.act === 'rename') {
        const res = await modal(`
          <div class="dlg-body form"><h2>Rename</h2><label>Name <input name="name" value="${esc(name)}" required maxlength="200"></label></div>
          <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`);
        if (!res) return;
        await api(`/media/${id}`, { method: 'PATCH', body: res });
      } else {
        if (!(await confirmModal(`Delete ${name}?`, 'It will also be removed from every playlist that uses it.'))) return;
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
                  <div><div class="name" title="${esc(m.name)}">${esc(m.name)}</div><div class="muted">${m.kind}</div></div>
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

  function defaultDuration(m) {
    return m.kind === 'video' ? 'full' : m.kind === 'web' ? 30 : 10;
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
        <div class="dur"><input type="number" min="1" max="86400" step="1" data-dur placeholder="${defaultDuration(i.media)}" value="${i.durationSeconds ?? ''}" title="Seconds on screen. Leave blank for the default${i.media.kind === 'video' ? ' (play the whole video)' : ''}."><span class="muted">s</span></div>
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

// ---------- boot ----------

api('/auth/session')
  .then((s) => (s.signedIn ? startApp() : showLogin()))
  .catch(() => showLogin());
