// Colorways: TS9 is the default (or the server's DEFAULT_THEME), INK and BB stay a tap away, the user's
// own pick wins and syncs, Light replaces them all, and the first paint already knows which one to show.
import vm from 'node:vm';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readAppSource(htmlPath), { grabFn } = makeExtractor(html);
const grabConst = name => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name); return html.slice(i, html.indexOf(';\n', i) + 1); };

// a body with a class list, a <meta> the server may or may not have sent
const mk = () => {
  const cls = new Set(), metas = {};
  const body = { classList: { toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c), add: c => cls.add(c) } };
  const ctx = { document: { body, querySelector: s => s === 'meta[name="default-theme"]' && metas.def ? { getAttribute: () => metas.def } : null },
    settings: {}, $: () => null, hasChart: () => false, matchMedia: () => ({ matches: false }), localStorage: { setItem() {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }), console };
  vm.createContext(ctx);
  vm.runInContext('let GRID,TXT;\n' + [grabConst('THEMES'), grabConst('COLORWAYS'), grabConst('APPEARANCES')].join('\n') + '\n' + ['appearanceIsLight', 'prefersLight', 'defaultTheme', 'applyTheme', 'themeGreen'].map(grabFn).join('\n'), ctx);
  return { ctx, cls, metas };
};
t('TS9 by default; INK and BB when asked; Light replaces the colorway', () => {
  const { ctx, cls } = mk();
  ctx.applyTheme(undefined); ok(cls.has('ts9') && !cls.has('bb') && !cls.has('light'), [...cls].join()); eq(ctx.settings.theme, 'ts9');
  ctx.applyTheme('bb'); ok(cls.has('bb') && !cls.has('ts9')); eq(ctx.settings.theme, 'bb');
  ctx.applyTheme('ink'); ok(!cls.has('bb') && !cls.has('ts9')); eq(ctx.settings.theme, 'ink');
  ctx.applyTheme('nope'); ok(cls.has('ts9'), 'an unknown value falls back to the default');
  ctx.settings.appearance = 'light'; ctx.applyTheme('ts9'); ok(cls.has('light') && !cls.has('ts9'), 'light wins'); eq(ctx.settings.theme, 'ts9', 'but the colorway is remembered for when dark returns');
});
t('the server’s DEFAULT_THEME is the default; the user’s own pick still wins', () => {
  const { ctx, cls, metas } = mk();
  metas.def = 'ink'; eq(ctx.defaultTheme(), 'ink'); ctx.applyTheme(undefined); ok(!cls.has('ts9') && !cls.has('bb'));
  ctx.applyTheme('ts9'); ok(cls.has('ts9'));
  metas.def = 'nope'; eq(ctx.defaultTheme(), 'ts9');
});
t('Daruma’s chart colours follow the colorway', () => {
  const cls = new Set(['ts9']);
  const ctx = { document: { body: { classList: { contains: c => cls.has(c) } } }, Proxy };
  vm.createContext(ctx);
  vm.runInContext([grabConst('PZ_COL_DARK'), grabConst('PZ_COL_LIGHT'), grabConst('PZ_COL_TS9'), grabConst('PZ_COL')].join('\n'), ctx);
  eq(vm.runInContext('PZ_COL.good', ctx), '#7dff4f'); cls.delete('ts9'); eq(vm.runInContext('PZ_COL.good', ctx), '#3FE0A0'); cls.add('light'); eq(vm.runInContext('PZ_COL.good', ctx), '#0A9A63');
});
t('the pick: footer button cycles, Daruma has the switch, it syncs and rides backups, BB users keep BB', () => {
  ok(html.includes("const i=COLORWAYS.indexOf(settings.theme); setColorway(COLORWAYS[(i+1)%COLORWAYS.length]);"), 'the footer button');
  ok(grabFn('pzSheetHtml').includes('data-pz-colorway') && html.includes("if(ds.pzColorway){ await setColorway(ds.pzColorway); return true; }"), 'Daruma’s switch');
  ok(grabFn('setColorway').includes('settings.colorway=COLORWAYS.includes(t)?t:defaultTheme()'));
  ok(html.includes("'calMode','colorway','calWeeks'") && html.includes('colorway:settings.colorway,appearance:settings.appearance}') && html.includes("if(['ts9','ink','bb'].includes(data.settings.colorway))settings.colorway=data.settings.colorway;"));
  ok(html.includes("if(!settings.colorway&&settings.theme==='bb')settings.colorway='bb';") && html.includes('applyTheme(settings.colorway);'), 'boot: BB was chosen by hand, INK was the old default');
  ok(grabFn('setAppearance').includes('applyTheme(settings.colorway)'), 'switching appearance keeps the pick, not the resolved default');
});
t('both surfaces carry the TS9 tokens, and the first paint knows the colorway', () => {
  ok(html.includes('body.ts9{') && html.includes('--profit:#7dff4f; --loss:#ff6b4a;'), 'journal tokens');
  ok(html.includes('body.ts9 #pz{--pz-acc:#7dff4f;--pz-bg:#050705;'), 'Daruma tokens');
  ok(html.includes("var th=localStorage.getItem('ledger_theme'); if(th===null){ var m=document.querySelector('meta[name=\"default-theme\"]'); th=m?m.getAttribute('content'):'ts9'; } if(th==='ts9'||th==='bb')document.body.classList.add(th);"), 'first paint: the last one shown, else the server’s default, else TS9');
  ok(html.includes("localStorage.setItem('ledger_theme',light?'':t)"), 'and applyTheme keeps that in step');
  ok(!html.includes("borderColor:'#2FD08C'") && grabFn('themeGreen').includes("getPropertyValue('--profit')"), 'the equity and projection charts take the colorway’s green');
});

console.log('\nServer');
const mkApp = o => server.createApp(Object.assign({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-theme-')), auth: '', htmlPath, push: false, pushTick: false, offsiteTimer: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) }, o));
for (const [opt, want] of [[{ defaultTheme: 'ink' }, '<meta name="default-theme" content="ink">'], [{}, null], [{ defaultTheme: 'purple' }, null]]) {
  const app = mkApp(opt);
  const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
  try {
    await t('DEFAULT_THEME ' + JSON.stringify(opt) + (want ? ' is served as a <meta>' : ' sends no <meta> (TS9 by default)'), async () => {
      for (const p of ['/', '/daruma']) { const h = await (await fetch(B + p)).text(); if (want) ok(h.includes(want), p); else ok(!h.includes('<meta name="default-theme"'), p); }
    });
  } finally { await new Promise(r => app.close(r)); }
}
report('theme');
