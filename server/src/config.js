import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(here, '../../data');

export const config = {
  port: Number(process.env.PORT || 8080),
  // Everything Sinewave stores (the SQLite database and uploaded media) lives under one folder.
  dataDir,
  databasePath: process.env.DATABASE_PATH || path.join(dataDir, 'sinewave.db'),
  mediaDir: process.env.MEDIA_DIR || path.join(dataDir, 'media'),
  playerDir: process.env.PLAYER_DIR || path.resolve(here, '../../player'),
  publicDir: path.resolve(here, '../public'),
  migrationsDir: path.resolve(here, '../migrations'),
  // Only used on first boot, to create the first super admin account.
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim(),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  // Max upload size in megabytes.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 1024),
  // A screen counts as online if it has a live socket or was seen this recently.
  onlineWindowSeconds: Number(process.env.ONLINE_WINDOW_SECONDS || 90),
  pairingTtlMinutes: 15,
  secureCookies: process.env.SECURE_COOKIES === 'true',
};
