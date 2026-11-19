import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || 'postgres://signage:signage@localhost:5432/signage',
  mediaDir: process.env.MEDIA_DIR || path.resolve(here, '../../data/media'),
  playerDir: process.env.PLAYER_DIR || path.resolve(here, '../../player'),
  publicDir: path.resolve(here, '../public'),
  migrationsDir: path.resolve(here, '../migrations'),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  // Max upload size in megabytes.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 1024),
  // A screen counts as online if it has a live socket or was seen this recently.
  onlineWindowSeconds: Number(process.env.ONLINE_WINDOW_SECONDS || 90),
  pairingTtlMinutes: 15,
  secureCookies: process.env.SECURE_COOKIES === 'true',
};
