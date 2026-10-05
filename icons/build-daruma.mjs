// Daruma's logo, drawn once here and written out as every file that carries it:
//   icons/daruma.svg               the tile (served as /pulse-icon.svg and /icon.svg: favicons, notifications)
//   icons/{pulse,ledger}-192.png, -512.png  rounded tiles for the manifests (purpose "any")
//   icons/{pulse,ledger}-180.png            full-bleed for iPhone's home screen (iOS rounds it)
//   icons/{pulse,ledger}-maskable-512.png   full-bleed, the mark inside Android's safe zone
// The mark: a daruma whose outline is a progress track, 72% painted, with one eye filled in
// (a goal set, not yet met). TS9 colours: acid green on green-black, glow only on the live parts.
// The in-app copy (pzMark in app/pulse.js) draws the same shape from the colorway's CSS variables.
//
// Run after changing the mark: node icons/build-daruma.mjs   (needs Playwright's Chromium, or PW_CHROMIUM=/path/to/chrome)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BODY = 'M50 8C70 8 82 24 84 44C87 66 82 92 50 92C18 92 13 66 16 44C18 24 30 8 50 8Z';
const FACE = 'M50 30C63 30 71 36 71 47C71 57 62 62 50 62C38 62 29 57 29 47C29 36 37 30 50 30Z';
const ACC = '#7dff4f', BG = '#050705';

// the mark in a 100×100 box
const mark = `<path d="${BODY}" fill="#0b140a" stroke="#16291a" stroke-width="8"/>`
  + `<g filter="url(#glow)" opacity=".55"><path d="${BODY}" fill="none" stroke="${ACC}" stroke-width="8" stroke-linecap="round" pathLength="100" stroke-dasharray="72 100"/><circle cx="40.5" cy="47" r="6.5" fill="${ACC}"/></g>`
  + `<path d="${BODY}" fill="none" stroke="${ACC}" stroke-width="8" stroke-linecap="round" pathLength="100" stroke-dasharray="72 100"/>`
  + `<path d="${FACE}" fill="${BG}" stroke="#1f3a1a" stroke-width="1.5"/>`
  + `<circle cx="40.5" cy="47" r="7.75" fill="${ACC}"/>`
  + `<circle cx="59.5" cy="47" r="6.5" fill="none" stroke="#93a393" stroke-width="2.5"/>`;

// a square tile: the ground, a faint dot grid, the mark at `scale` of the side
function tile({ size, rounded, scale }) {
  const k = size * scale / 100, dot = size / 21;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<defs><pattern id="dots" width="${dot}" height="${dot}" patternUnits="userSpaceOnUse"><circle cx="${dot / 2}" cy="${dot / 2}" r="${(size / 320).toFixed(2)}" fill="${ACC}" fill-opacity=".09"/></pattern>`
    + `<filter id="glow" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>`
    + `<rect width="${size}" height="${size}"${rounded ? ` rx="${Math.round(size * .225)}"` : ''} fill="${BG}"/>`
    + `<rect width="${size}" height="${size}"${rounded ? ` rx="${Math.round(size * .225)}"` : ''} fill="url(#dots)"/>`
    + `<g transform="translate(${size / 2} ${size / 2}) scale(${k.toFixed(4)}) translate(-50 -50)">${mark}</g></svg>`;
}

// one logo for both installable apps: Daruma (pulse-*) and the full journal (ledger-*)
// The mark's body spans 84% of its box, so at scale .84 it stands nearly edge to edge: the full-bleed
// home-screen tile (iOS rounds and shrinks it) and the rounded tiles fill their square the way app
// icons do; the maskable one keeps the mark inside Android's safe zone (the middle 80%).
const outputs = ['pulse', 'ledger'].flatMap(app => [
  [app + '-192.png', { size: 192, rounded: true, scale: .84 }],
  [app + '-512.png', { size: 512, rounded: true, scale: .84 }],
  [app + '-180.png', { size: 180, rounded: false, scale: .88 }],
  [app + '-maskable-512.png', { size: 512, rounded: false, scale: .7 }],
]);

fs.writeFileSync(path.join(DIR, 'daruma.svg'), tile({ size: 180, rounded: true, scale: .84 }) + '\n');

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch (e) { console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium'); process.exit(1); }
// PW_CHROMIUM=/path/to/chrome uses a Chromium already on the machine instead of Playwright's own download
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
try {
  for (const [file, o] of outputs) {
    const page = await browser.newPage({ viewport: { width: o.size, height: o.size } });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${tile(o)}`);
    // the full-bleed ones are opaque (iOS shows black behind any transparency anyway)
    fs.writeFileSync(path.join(DIR, file), await page.screenshot({ omitBackground: o.rounded, clip: { x: 0, y: 0, width: o.size, height: o.size } }));
    await page.close();
    console.log('wrote icons/' + file);
  }
} finally { await browser.close(); }
console.log('wrote icons/daruma.svg');
