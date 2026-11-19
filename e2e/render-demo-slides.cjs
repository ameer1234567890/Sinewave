/*
 * Renders the slides for the "Demo" playlist that Sinewave creates on a fresh install.
 * The JPEGs are committed to server/demo/, so this only needs running when the slides change:
 *   cd e2e && npm install && node render-demo-slides.cjs
 * The text is set in Inter; install it first so the output matches the committed files.
 */
const { chromium } = require('playwright');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../server/demo');

const logo = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3b6cf6"/>
  <path d="M5 16c2.75-7 5.5-7 8.25 0s5.5 7 8.25 0 3.75-5.5 5.5-3" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`;

// Layered sine waves along the bottom of every slide.
function waves() {
  const path = (amp, period, phase, y) => {
    const pts = [];
    for (let x = 0; x <= 1920; x += 8) pts.push(`${x} ${(y + amp * Math.sin(((x + phase) / period) * Math.PI * 2)).toFixed(1)}`);
    return `M${pts.join(' L')}`;
  };
  return `<svg class="waves" width="1920" height="360" viewBox="0 0 1920 360">
    <path d="${path(46, 960, 0, 200)}" stroke="#3b6cf6" stroke-width="6" fill="none" opacity=".9"/>
    <path d="${path(34, 720, 180, 230)}" stroke="#6b8fff" stroke-width="4" fill="none" opacity=".55"/>
    <path d="${path(24, 1280, 420, 260)}" stroke="#a9bcff" stroke-width="3" fill="none" opacity=".35"/>
  </svg>`;
}

const page = (body) => `<!doctype html><html><head><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; position: relative; color: #fff;
    font-family: Inter, system-ui, sans-serif;
    background: radial-gradient(1200px 700px at 15% 10%, #1d2b5c 0%, transparent 70%),
                linear-gradient(160deg, #0f1730 0%, #0a0f1f 100%); }
  .waves { position: absolute; left: 0; bottom: 0; }
  .brand { position: absolute; top: 72px; left: 120px; display: flex; align-items: center; gap: 22px;
    font-size: 44px; font-weight: 700; letter-spacing: -0.5px; }
  .content { position: absolute; top: 230px; left: 120px; right: 120px; }
  .step { color: #8fa8ff; font-size: 40px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; }
  h1 { font-size: 124px; line-height: 1.05; font-weight: 800; letter-spacing: -3px; margin: 20px 0 40px; }
  p { font-size: 50px; line-height: 1.4; color: #c9d3ee; margin: 0; max-width: 1500px; }
  b { color: #fff; font-weight: 700; }
  code { font-family: "JetBrains Mono", monospace; font-size: 44px; color: #fff;
    background: rgba(107,143,255,.18); padding: 4px 16px; border-radius: 12px; }
  .center { position: absolute; inset: 0 0 160px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .center h1 { font-size: 150px; margin: 48px 0 24px; }
  .tagline { font-size: 56px; font-style: italic; color: #a9bcff; }
</style></head><body>${body}${waves()}</body></html>`;

const brand = `<div class="brand">${logo(64)} Sinewave</div>`;

const slides = [
  [
    'welcome.jpg',
    page(`<div class="center">${logo(200)}<h1>Welcome to Sinewave</h1><div class="tagline">Everyone, on the same wavelength</div></div>`),
  ],
  [
    'add-content.jpg',
    page(`${brand}<div class="content"><div class="step">Step 1</div><h1>Add your content</h1>
      <p>Open the dashboard and go to <b>Media</b>. Upload images and videos, or add a web page by its address.
      Then build a <b>playlist</b> and set how long each item shows.</p></div>`),
  ],
  [
    'pair-screen.jpg',
    page(`${brand}<div class="content"><div class="step">Step 2</div><h1>Pair a screen</h1>
      <p>On any screen with a web browser, open <code>/player</code> on your Sinewave server. It shows a code.
      In the dashboard, choose <b>Screens</b> then <b>Pair screen</b>, type the code and pick a playlist.</p></div>`),
  ],
  [
    'make-it-yours.jpg',
    page(`${brand}<div class="content"><div class="step">Step 3</div><h1>Make it yours</h1>
      <p>You are watching the <b>Demo</b> playlist. Change it, or make your own and delete this one when you are ready.
      Changes reach your screens in seconds, and they keep playing even if the network drops.</p></div>`),
  ],
];

(async () => {
  const browser = await chromium.launch();
  const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const [file, html] of slides) {
    await tab.setContent(html);
    await tab.evaluate(() => document.fonts.ready);
    await tab.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 88 });
    console.log(`Wrote server/demo/${file}`);
  }
  await browser.close();
})();
