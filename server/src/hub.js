import { WebSocketServer } from 'ws';
import { query } from './db.js';
import { screenFromToken } from './auth.js';

/**
 * Keeps one WebSocket per connected player and pushes change notifications to them.
 * Players re-fetch the manifest over HTTP when told something changed, so messages stay tiny.
 */
class Hub {
  constructor() {
    this.sockets = new Map(); // screenId -> Set<WebSocket>
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/player') return socket.destroy();
      const screen = await screenFromToken(url.searchParams.get('token')).catch(() => null);
      if (!screen) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, screen, req));
    });

    // Ping every 30s so dead connections (pulled network cable, sleeping device) get dropped.
    this.pingTimer = setInterval(() => {
      for (const set of this.sockets.values()) {
        for (const ws of set) {
          if (ws.isAlive === false) {
            ws.terminate();
            continue;
          }
          ws.isAlive = false;
          ws.ping();
        }
      }
    }, 30_000);
  }

  onConnection(ws, screen, req) {
    const id = screen.id;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      touch(id).catch(() => {});
    });
    if (!this.sockets.has(id)) this.sockets.set(id, new Set());
    this.sockets.get(id).add(ws);
    touch(id, req).catch(() => {});

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'status') {
        try {
          query(
            `UPDATE screens SET now_playing = $2, now_playing_media_id = $3, player_version = $4, last_seen_at = now()
              WHERE id = $1`,
            [
              id,
              typeof msg.nowPlaying === 'string' ? msg.nowPlaying.slice(0, 200) : null,
              typeof msg.nowPlayingMediaId === 'string' ? msg.nowPlayingMediaId.slice(0, 64) : null,
              typeof msg.playerVersion === 'string' ? msg.playerVersion.slice(0, 50) : null,
            ],
          );
        } catch (err) {
          console.error('Could not save screen status', err.message);
        }
      }
    });
    ws.on('close', () => {
      const set = this.sockets.get(id);
      if (!set) return;
      set.delete(ws);
      if (!set.size) this.sockets.delete(id);
      touch(id).catch(() => {});
    });
    ws.send(JSON.stringify({ type: 'hello', screenId: id }));
  }

  isConnected(screenId) {
    return this.sockets.has(screenId);
  }

  send(screenId, message) {
    const set = this.sockets.get(screenId);
    if (!set) return 0;
    const payload = JSON.stringify(message);
    for (const ws of set) ws.send(payload);
    return set.size;
  }

  /** Disconnect a screen, e.g. after it was deleted. */
  kick(screenId) {
    const set = this.sockets.get(screenId);
    if (!set) return;
    for (const ws of set) ws.close(4001, 'Screen removed');
  }

  async notifyScreens(screenIds) {
    for (const id of new Set(screenIds)) this.send(id, { type: 'content-changed' });
  }

  async notifyPlaylist(playlistId) {
    const { rows } = await query('SELECT id FROM screens WHERE playlist_id = $1', [playlistId]);
    await this.notifyScreens(rows.map((r) => r.id));
  }

  async notifyMedia(mediaId) {
    const { rows } = await query(
      `SELECT DISTINCT s.id FROM screens s JOIN playlist_items pi ON pi.playlist_id = s.playlist_id
        WHERE pi.media_id = $1`,
      [mediaId],
    );
    await this.notifyScreens(rows.map((r) => r.id));
  }

  close() {
    clearInterval(this.pingTimer);
    this.wss?.close();
  }
}

async function touch(screenId, req) {
  if (req) {
    await query('UPDATE screens SET last_seen_at = now(), last_ip = $2, user_agent = $3 WHERE id = $1', [
      screenId,
      req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
      req.headers['user-agent']?.slice(0, 300) || null,
    ]);
  } else {
    await query('UPDATE screens SET last_seen_at = now() WHERE id = $1', [screenId]);
  }
}

export const hub = new Hub();
