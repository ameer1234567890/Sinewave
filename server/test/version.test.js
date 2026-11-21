// Unit tests for the app version and the "show version on screens" setting. Run with: npm test (from server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sinewave-test-'));
const { VERSION, showVersionOnScreens, setShowVersionOnScreens } = await import('../src/version.js');
const { buildManifest } = await import('../src/manifest.js');
const { migrate } = await import('../src/db.js');
migrate();

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the version is a plain x.y.z number', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('server/package.json has the same version as player/version.js', () => {
  assert.equal(pkg.version, VERSION, 'Bump "version" in server/package.json to match player/version.js');
});

test('screens show the version by default, and the setting turns it off and on', async () => {
  const screen = { id: 's1', name: 'Lobby', playlist_id: null };
  assert.equal(showVersionOnScreens(), true);
  const before = await buildManifest(screen);
  assert.equal(before.display.showVersion, true);

  setShowVersionOnScreens(false);
  const after = await buildManifest(screen);
  assert.equal(after.display.showVersion, false);
  assert.notEqual(after.version, before.version, 'changing the setting must update screens');

  setShowVersionOnScreens(true);
  assert.equal((await buildManifest(screen)).display.showVersion, true);
});
