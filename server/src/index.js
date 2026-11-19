import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { closeDatabase, migrate, query } from './db.js';
import { initAuth, login, logout, requireUser, sessionStatus } from './auth.js';
import { hub } from './hub.js';
import { admin } from './routes/admin.js';
import { users } from './routes/users.js';
import { player } from './routes/player.js';
import { HttpError } from './util.js';

migrate();
await initAuth();
fs.mkdirSync(config.mediaDir, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  query('SELECT 1');
  res.json({ ok: true });
});

// API
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/session', sessionStatus);
app.use('/api/player', player);
// Everything below needs a signed-in account. Super-admin-only routes check the role themselves.
app.use('/api', requireUser);
app.use('/api', users);
app.use('/api', admin);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// Uploaded files. Each lives in its own folder named after its id, and never changes, so it can be cached forever.
app.use(
  '/media',
  express.static(config.mediaDir, { immutable: true, maxAge: '365d', index: false, dotfiles: 'ignore', fallthrough: false }),
);

// The player is a static web app. The service worker must not be cached by HTTP or updates would stall.
app.use(
  '/player',
  express.static(config.playerDir, {
    setHeaders(res, file) {
      if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// Dashboard
app.use(express.static(config.publicDir, { index: 'index.html' }));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
});

const server = http.createServer(app);
hub.attach(server);
server.listen(config.port, () => console.log(`Sinewave server listening on :${config.port}`));

function shutdown() {
  console.log('Shutting down');
  hub.close();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
