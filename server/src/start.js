/*
 * Container entry point. When started as root (the Docker default), it makes sure the data
 * folder exists and is owned by PUID:PGID (default 1000:1000; Unraid uses 99:100), then drops
 * to that user before loading the server. Started as any other user, it changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function ownAll(dir, uid, gid) {
  // Only touch entries with the wrong owner, so big media folders aren't rewritten on every start.
  const fix = (p, st) => {
    if (st.uid !== uid || st.gid !== gid) fs.lchownSync(p, uid, gid);
  };
  fix(dir, fs.lstatSync(dir));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) ownAll(p, uid, gid);
    else fix(p, fs.lstatSync(p));
  }
}

function parseId(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name} must be a whole number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

if (process.getuid?.() === 0) {
  const uid = parseId('PUID', 1000);
  const gid = parseId('PGID', 1000);
  const dataDirs = [...new Set([config.dataDir, path.dirname(config.databasePath), config.mediaDir])];
  for (const dir of dataDirs) {
    fs.mkdirSync(dir, { recursive: true });
    ownAll(dir, uid, gid);
  }
  if (uid !== 0) {
    process.setgroups([gid]);
    process.setgid(gid);
    process.setuid(uid);
    console.log(`Running as ${uid}:${gid}`);
  }
}

await import('./index.js');
