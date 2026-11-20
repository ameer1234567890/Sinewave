import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findShareImage } from '../src/webpreview.js';

const page = 'https://example.com/menu/today';

test('prefers og:image and resolves it against the page', () => {
  const html = `<head><meta name="twitter:image" content="/tw.png"><meta property="og:image" content="/img/share.jpg?a=1&amp;b=2"></head>`;
  assert.equal(findShareImage(html, page), 'https://example.com/img/share.jpg?a=1&b=2');
});

test('accepts attributes in any order and single quotes', () => {
  const html = `<meta content='https://cdn.example.net/s.png' property='og:image'>`;
  assert.equal(findShareImage(html, page), 'https://cdn.example.net/s.png');
});

test('falls back to twitter:image, then a large icon', () => {
  assert.equal(findShareImage('<meta name="twitter:image" content="t.png">', page), 'https://example.com/menu/t.png');
  const icons = '<link rel="icon" sizes="32x32" href="/f32.png"><link rel="apple-touch-icon" href="/apple.png">';
  assert.equal(findShareImage(icons, page), 'https://example.com/apple.png');
});

test('ignores tiny favicons and non-web URLs', () => {
  assert.equal(findShareImage('<link rel="icon" sizes="32x32" href="/f32.png">', page), null);
  assert.equal(findShareImage('<meta property="og:image" content="javascript:alert(1)">', page), null);
  assert.equal(findShareImage('<p>No head at all</p>', page), null);
});

test('honours <base href>', () => {
  const html = '<base href="https://static.example.org/assets/"><meta property="og:image" content="hero.jpg">';
  assert.equal(findShareImage(html, page), 'https://static.example.org/assets/hero.jpg');
});
