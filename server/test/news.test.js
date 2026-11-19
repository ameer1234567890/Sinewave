// Unit tests for feed parsing. Run with: npm test (from server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// news.js pulls in the database module, so point it at a throwaway folder first.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sinewave-test-'));
const { parseFeed, plainText, normalizeNewsOptions, upgradeImageUrl, parseFeedUrl } = await import('../src/news.js');

const RSS_BBC_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">
  <channel>
    <title><![CDATA[BBC News]]></title>
    <link>https://www.bbc.co.uk/news</link>
    <atom:link href="https://feeds.bbci.co.uk/news/rss.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title><![CDATA[Older story about trains & buses]]></title>
      <description><![CDATA[Commuters face delays.]]></description>
      <link>https://www.bbc.co.uk/news/articles/aaa</link>
      <guid isPermaLink="false">https://www.bbc.co.uk/news/articles/aaa#0</guid>
      <pubDate>Wed, 18 Nov 2026 09:00:00 GMT</pubDate>
      <media:thumbnail width="240" height="135" url="https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/abc/live/x.jpg"/>
    </item>
    <item>
      <title>Newest story</title>
      <description>Something &lt;b&gt;bold&lt;/b&gt; happened &amp;amp; more.</description>
      <link>https://www.bbc.co.uk/news/articles/bbb</link>
      <guid isPermaLink="false">bbb</guid>
      <pubDate>Thu, 19 Nov 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const RSS_GUARDIAN_STYLE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>World news | The Guardian</title><link>https://www.theguardian.com/world</link>
<item><title>Headline one</title><link>https://www.theguardian.com/world/1</link>
<description>&lt;p&gt;First para.&lt;/p&gt; &lt;a href="x"&gt;Continue reading...&lt;/a&gt;</description>
<category domain="x">World</category><category domain="y">Europe</category>
<dc:date>2026-11-19T08:00:00Z</dc:date>
<media:content width="140" url="https://i.guim.co.uk/img/small.jpg"><media:credit>Photo</media:credit></media:content>
<media:content width="460" url="https://i.guim.co.uk/img/big.jpg"><media:credit>Photo</media:credit></media:content>
</item></channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Tech &amp;amp; Things</title>
  <link rel="self" href="https://example.com/feed.atom"/>
  <link rel="alternate" href="https://example.com/"/>
  <entry>
    <title type="html">An &lt;em&gt;Atom&lt;/em&gt; entry</title>
    <link rel="alternate" type="text/html" href="/posts/1"/>
    <id>tag:example.com,2026:1</id>
    <updated>2026-11-19T12:00:00Z</updated>
    <content type="html">&lt;p&gt;&lt;img src="https://example.com/pic.png"&gt;Body text here.&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
 <channel rdf:about="https://example.org/"><title>RDF feed</title><link>https://example.org/</link></channel>
 <item rdf:about="https://example.org/a"><title>RDF story</title><link>https://example.org/a</link><description>Desc</description></item>
</rdf:RDF>`;

test('parses a BBC-style RSS feed, newest first, with upgraded thumbnails', () => {
  const feed = parseFeed(RSS_BBC_STYLE, 'https://feeds.bbci.co.uk/news/rss.xml');
  assert.equal(feed.title, 'BBC News');
  assert.equal(feed.siteUrl, 'https://www.bbc.co.uk/news');
  assert.equal(feed.stories.length, 2);
  assert.equal(feed.stories[0].title, 'Newest story');
  assert.equal(feed.stories[0].summary, 'Something bold happened & more.');
  assert.equal(feed.stories[0].sourceImage, null);
  assert.equal(feed.stories[1].title, 'Older story about trains & buses');
  assert.equal(feed.stories[1].sourceImage, 'https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/abc/live/x.jpg');
  assert.equal(feed.stories[1].publishedAt, '2026-11-18T09:00:00.000Z');
});

test('picks the largest media:content image and strips HTML from summaries', () => {
  const [s] = parseFeed(RSS_GUARDIAN_STYLE, 'https://www.theguardian.com/world/rss').stories;
  assert.equal(s.sourceImage, 'https://i.guim.co.uk/img/big.jpg');
  assert.equal(s.summary, 'First para. Continue reading...');
  assert.equal(s.publishedAt, '2026-11-19T08:00:00.000Z');
});

test('parses Atom, resolving relative links and finding images in content', () => {
  const feed = parseFeed(ATOM, 'https://example.com/feed.atom');
  assert.equal(feed.title, 'Tech & Things');
  assert.equal(feed.siteUrl, 'https://example.com/');
  const [s] = feed.stories;
  assert.equal(s.title, 'An Atom entry');
  assert.equal(s.link, 'https://example.com/posts/1');
  assert.equal(s.sourceImage, 'https://example.com/pic.png');
  assert.equal(s.summary, 'Body text here.');
});

test('parses RSS 1.0 (RDF)', () => {
  const feed = parseFeed(RDF, 'https://example.org/rss');
  assert.equal(feed.title, 'RDF feed');
  assert.equal(feed.stories[0].title, 'RDF story');
});

test('rejects things that are not feeds', () => {
  assert.throws(() => parseFeed('<!doctype html><html><body>Hi</body></html>', 'https://x.test/'), /RSS or Atom/);
  assert.throws(() => parseFeed('not xml at all', 'https://x.test/'), /RSS or Atom/);
});

test('plainText decodes entities and truncates on a word boundary', () => {
  assert.equal(plainText('Fish &amp; chips &#163;5 &#x2014; &pound;6'), 'Fish & chips £5 — £6');
  assert.equal(plainText('one two three four', 9), 'one two…');
});

test('news options are clamped and validated', () => {
  const o = normalizeNewsOptions({ layout: 'nope', theme: 'light', accent: 'red', maxStories: 99, secondsPerStory: '1', showImages: 'false' });
  assert.equal(o.layout, 'feature');
  assert.equal(o.theme, 'light');
  assert.equal(o.accent, '#e5484d');
  assert.equal(o.maxStories, 20);
  assert.equal(o.secondsPerStory, 3);
  assert.equal(o.showImages, false);
  assert.equal(o.showSummary, true);
});

test('feed URLs must be http or https', () => {
  assert.throws(() => parseFeedUrl('file:///etc/passwd'), /http/);
  assert.throws(() => parseFeedUrl('bbc news'), /full feed URL/);
  assert.equal(parseFeedUrl(' https://example.com/rss#x '), 'https://example.com/rss');
});

test('only known thumbnail hosts are upgraded', () => {
  assert.equal(upgradeImageUrl('https://example.com/240/x.jpg'), 'https://example.com/240/x.jpg');
  assert.equal(upgradeImageUrl('https://ichef.bbci.co.uk/news/240/cpsprodpb/x.jpg'), 'https://ichef.bbci.co.uk/news/976/cpsprodpb/x.jpg');
});
