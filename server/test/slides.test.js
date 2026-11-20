// Unit tests for slide templates and rendering. Run with: npm test (from server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// slides.js pulls in the database module, so point it at a throwaway folder first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sinewave-test-'));
const { Slides, normalizeSlideOptions } = await import('../src/slides.js');
const { migrate, query } = await import('../src/db.js');
migrate(); // also checks the migration that adds slides applies cleanly

test('normalize fills defaults and keeps only known values', () => {
  const s = Slides.normalize({ template: 'nope', background: 'nope', font: 'comic', accent: 'red', fields: { title: '  Hi   there ', extra: 'x' } });
  assert.equal(s.template, 'announcement');
  assert.equal(s.background, Slides.template('announcement').background);
  assert.equal(s.font, 'modern');
  assert.equal(s.accent, null);
  assert.equal(s.fields.title, 'Hi there');
  assert.equal(s.fields.extra, undefined);
  assert.deepEqual(Object.keys(s.fields), Slides.template('announcement').fields.map((f) => f.key));
});

test('normalize trims text to each field limit and keeps line breaks only where allowed', () => {
  const s = Slides.normalize({ template: 'event', fields: { title: 'a'.repeat(500), message: 'one\r\n\r\n\r\n\r\ntwo  ', date: 'Fri\n12' } });
  assert.equal(s.fields.title.length, 100);
  assert.equal(s.fields.message, 'one\n\ntwo');
  assert.equal(s.fields.date, 'Fri 12');
});

test('a picture background is only kept with the image background', () => {
  assert.equal(Slides.normalize({ background: 'ocean', backgroundImageId: 'abc' }).backgroundImageId, null);
  assert.equal(Slides.normalize({ background: 'image', backgroundImageId: 'abc' }).backgroundImageId, 'abc');
});

test('the server keeps pictures that are images in Media, and drops anything else', () => {
  const imageId = '11111111-1111-4111-8111-111111111111';
  query(`INSERT INTO media (id, name, kind, filename) VALUES ($1, 'Logo', 'image', 'logo.png')`, [imageId]);
  query(`INSERT INTO media (id, name, kind, options) VALUES ($1, 'A slide', 'slide', '{}')`, ['22222222-2222-4222-8222-222222222222']);
  assert.equal(normalizeSlideOptions({ imageId }).imageId, imageId);
  const s = normalizeSlideOptions({ template: 'welcome', imageId: '00000000-0000-4000-8000-000000000000', background: 'image', backgroundImageId: 'x' });
  assert.equal(s.imageId, null);
  assert.equal(s.backgroundImageId, null);
});

test('menu lines split into names and prices', () => {
  const rows = Slides.menuRows('Drinks:\nFlat white  3.20\nTea | 2\nRoom 101\nLatte £3.50\nMon – Fri 9:00 – 17:00\nSunday closed\n\n');
  assert.deepEqual(rows, [
    { heading: 'Drinks' },
    { name: 'Flat white', price: '3.20' },
    { name: 'Tea', price: '2' },
    { name: 'Room 101', price: '' },
    { name: 'Latte', price: '£3.50' },
    { name: 'Mon – Fri', price: '9:00 – 17:00' },
    { name: 'Sunday', price: 'closed' },
  ]);
});

test('rendering escapes text and includes the picture', () => {
  for (const t of Slides.TEMPLATES) {
    const html = Slides.toHTML({
      template: t.id,
      fields: Object.fromEntries(t.fields.map((f) => [f.key, '<script>alert(1)</script> & "quotes"'])),
      imageUrl: '/media/1/logo.png',
    });
    assert.ok(!html.includes('<script>'), `${t.id} escapes text`);
    assert.ok(html.includes('&lt;script&gt;'), `${t.id} shows the text`);
    assert.ok(html.includes('src="/media/1/logo.png"'), `${t.id} shows the picture`);
    assert.ok(html.includes(`sw-t-${t.id}`));
  }
});

test('every background renders and light ones use dark text', () => {
  for (const b of Slides.BACKGROUNDS) {
    const html = Slides.toHTML({ background: b.id });
    assert.ok(html.includes(b.dark ? 'sw-dark' : 'sw-light'), b.id);
  }
  const html = Slides.toHTML({ background: 'image', backgroundImageId: 'x', backgroundUrl: '/media/x/a b.jpg' });
  assert.ok(html.includes('/media/x/a b.jpg'));
});
