// Shared playbooks: a member shares a setup's rules (name, a note, the rules with their ids); others
// adopt a copy into their own journal, where the checklist and its scorecard work as on any playbook.
// Sharing again updates the shared copy (a new version when the name or rules change, and adopters hear
// of it); the author sees how many adopted it. Never trades or results. The owner can switch it off,
// keep sharing to mentors, and remove one.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor, storedText } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
let clock = Date.parse('2026-10-20T20:00:00Z');

const dataDir = mkdtempSync(join(tmpdir(), 'ledger-pbs-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(p === '/join' ? { 'X-Forwarded-For': '10.0.2.' + (++ipN) } : {}), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const join_ = async h => (await call('/join', { method: 'POST', body: { handle: h } })).d.key;
const idOf = async h => (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === h).id;
const inbox = async k => (await call('/inbox', { key: k })).d.items;
const share = (k, body) => call('/playbooks', { method: 'POST', key: k, body });
const adopt = (k, id, on) => call('/playbooks/' + id + '/adopt', { method: 'POST', key: k, body: on === false ? { on: false } : {} });
const BO = { src: 'pbk1', name: 'Breakout retest', about: 'Range breaks on the 15m. Not in chop.',
  rules: [{ id: 'ra', text: 'Wait for the retest' }, { id: 'rb', text: 'Stop under the range' }, { id: 'rc', text: 'Risk 1R or less' }, { id: 'rd', text: 'No entries in the first 15 minutes' }] };

let MIA, KAI, LEO, NED, boId;
try {
  await call('/admin/config', { method: 'PUT', admin: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  MIA = await join_('mia'); KAI = await join_('kai'); LEO = await join_('leo'); NED = await join_('ned');
  await call('/admin/members/' + await idOf('mia'), { method: 'POST', admin: true, body: { action: 'mentor' } });

  await t('on by default, open to every member: the league config says so', async () => {
    eq((await call('/config')).d.playbooks, { on: true, who: 'all' });
    const m = (await call('/playbooks/mine', { key: KAI })).d; eq([m.mine, m.have, m.canShare, m.max], [[], {}, true, 30]);
  });
  await t('sharing needs a profile, a name and a rule; junk rules are dropped and text is cleaned', async () => {
    eq((await call('/playbooks', { method: 'POST', body: BO })).status, 401);
    eq((await share(MIA, { src: 'x1', name: '  ', rules: BO.rules })).status, 400);
    eq((await share(MIA, { src: 'x1', name: 'Empty', rules: [] })).status, 400);
    eq((await share(MIA, { src: 'bad id!', name: 'Bad', rules: BO.rules })).status, 400);
    const r = await share(MIA, { src: 'x2', name: 'Fade', about: { no: 1 }, rules: [{ id: 'a', text: '  Fade the first push\u0007 ' }, { id: 'a', text: 'dup id' }, { id: 'b', text: '' }, { text: 'no id' }, null] });
    eq(r.status, 200); eq([r.d.playbook.about, r.d.playbook.rules], ['', [{ id: 'a', text: 'Fade the first push' }]]);
    eq((await call('/playbooks/' + r.d.playbook.id, { method: 'DELETE', key: MIA })).status, 200);
  });
  await t('a shared playbook keeps its rule ids, starts at version 1 and goes on the author’s feed', async () => {
    const r = await share(MIA, BO); eq(r.status, 200); boId = r.d.playbook.id;
    const p = r.d.playbook;
    eq([p.name, p.version, p.ruleN, p.adopts, p.mine, p.src, p.author.handle, p.author.mentor], ['Breakout retest', 1, 4, 0, true, 'pbk1', 'mia', true]);
    eq(p.rules.map(x => x.id), ['ra', 'rb', 'rc', 'rd']);
    const ev = (await call('/feed?scope=discover', { key: KAI })).d.events.find(e => e.type === 'playbook'); ok(ev, 'a feed line'); eq([ev.text, ev.quote, ev.pb], ['shared a playbook', 'Breakout retest', boId]);
  });
  await t('two of one member’s playbooks can’t share a name; sharing the same thing again changes nothing', async () => {
    eq((await share(MIA, Object.assign({}, BO, { src: 'pbk2', name: 'breakout RETEST' }))).status, 409);
    const r = await share(MIA, BO); eq([r.status, r.d.changed, r.d.playbook.version], [200, false, 1]);
  });
  await t('the list: cards with a preview of three rules, search by name, rule or handle, and who shared it', async () => {
    await share(KAI, { src: 'k1', name: 'Range fade', about: 'Fade the edges of a quiet range', rules: [{ id: 'k', text: 'Only in a quiet range' }] });
    const L = (await call('/playbooks', { key: LEO })).d;
    eq(L.total, 2); const c = L.playbooks.find(x => x.id === boId);
    eq([c.preview, c.ruleN, c.rules, c.src, c.mine, c.adopted], [['Wait for the retest', 'Stop under the range', 'Risk 1R or less'], 4, undefined, undefined, false, null]);
    eq((await call('/playbooks?q=retest', { key: LEO })).d.playbooks.map(x => x.name), ['Breakout retest']);
    eq((await call('/playbooks?q=quiet', { key: LEO })).d.playbooks.map(x => x.name), ['Range fade']);
    eq((await call('/playbooks?q=%40kai', { key: LEO })).d.playbooks.map(x => x.name), ['Range fade']);
    eq((await call('/playbooks?sort=mentors', { key: LEO })).d.playbooks.map(x => x.author.handle), ['mia', 'kai']);
    eq((await call('/playbooks/' + boId, { key: LEO })).d.playbook.rules.length, 4);
    eq((await call('/playbooks/0123456789ab', { key: LEO })).status, 404);
  });
  await t('adopting counts once per member, tells the author once, and can’t be your own', async () => {
    eq((await adopt(MIA, boId)).status, 400);
    const r = await adopt(LEO, boId); eq([r.status, r.d.playbook.adopts, !!r.d.playbook.adopted], [200, 1, true]);
    await adopt(LEO, boId); await adopt(NED, boId);
    eq((await call('/playbooks/' + boId, { key: KAI })).d.playbook.adopts, 2);
    eq((await inbox(MIA)).filter(x => x.title === 'Your playbook was adopted').length, 2);
    await adopt(LEO, boId, false); await adopt(LEO, boId);
    eq((await inbox(MIA)).filter(x => x.title === 'Your playbook was adopted').length, 2, 'dropping and adopting again doesn’t ping the author again');
    eq((await call('/playbooks?sort=popular', { key: KAI })).d.playbooks[0].id, boId, 'most adopted first');
  });
  await t('a new version when the name or rules change, and every adopter hears; a reworded note alone is quiet', async () => {
    clock += 3600000;
    let r = await share(MIA, Object.assign({}, BO, { about: 'Range breaks on the 15m and 1h.' }));
    eq([r.d.changed, r.d.playbook.version], [true, 1]);
    eq((await inbox(LEO)).filter(x => x.title === 'A playbook you use changed').length, 0);
    r = await share(MIA, Object.assign({}, BO, { rules: [...BO.rules.slice(0, 3), { id: 're', text: 'Out if it closes back inside' }] }));
    eq([r.d.changed, r.d.playbook.version, r.d.playbook.updated], [true, 2, clock]);
    for (const k of [LEO, NED]) eq((await inbox(k)).filter(x => x.title === 'A playbook you use changed').length, 1);
    const m = (await call('/playbooks/mine?have=' + boId + ',0123456789ab,zz', { key: LEO })).d;
    eq(m.have, { [boId]: { version: 2, name: 'Breakout retest', handle: 'mia' } }, 'only the ones still shared');
    eq((await call('/playbooks/mine', { key: MIA })).d.mine.map(x => [x.name, x.version, x.adopts]), [['Breakout retest', 2, 2]]);
  });
  await t('only the author stops sharing; the adoptions and the feed line go with it', async () => {
    eq((await call('/playbooks/' + boId, { method: 'DELETE', key: LEO })).status, 403);
    eq((await call('/playbooks/' + boId, { method: 'DELETE', key: MIA })).status, 200);
    eq((await call('/playbooks/' + boId, { key: LEO })).status, 404);
    eq((await call('/playbooks/mine?have=' + boId, { key: LEO })).d.have, {});
    ok(!JSON.stringify((await call('/feed?scope=discover', { key: KAI })).d.events).includes('Breakout retest'));
    ok(!storedText(dataDir).includes('"playbook":"' + boId + '"'));
    boId = (await share(MIA, BO)).d.playbook.id; await adopt(LEO, boId);
  });
  await t('a suspended author’s playbooks disappear; a deleted member’s are gone with their adoptions', async () => {
    const kaiId = await idOf('kai'), kai = (await call('/playbooks?q=fade', { key: LEO })).d.playbooks[0].id;
    await adopt(NED, kai);
    await call('/admin/members/' + kaiId, { method: 'POST', admin: true, body: { action: 'ban' } });
    eq((await call('/playbooks', { key: LEO })).d.playbooks.map(x => x.name), ['Breakout retest']);
    eq((await call('/playbooks/' + kai, { key: LEO })).status, 404);
    await call('/admin/members/' + kaiId, { method: 'POST', admin: true, body: { action: 'unban' } });
    eq((await call('/playbooks/' + kai, { key: LEO })).status, 200);
    await call('/admin/members/' + kaiId, { method: 'POST', admin: true, body: { action: 'remove' } });
    eq((await call('/playbooks/' + kai, { key: LEO })).status, 404);
    await call('/admin/members/' + await idOf('leo'), { method: 'POST', admin: true, body: { action: 'remove' } });
    eq((await call('/playbooks/' + boId, { key: NED })).d.playbook.adopts, 0, 'leo’s adoption went with leo');
    ok(!storedText(dataDir).includes('Range fade'));
  });
  await t('the owner: mentors only, off, and removing one (logged)', async () => {
    await call('/admin/config', { method: 'PUT', admin: true, body: { playbooks: { who: 'mentors', on: 'yes' } } });
    eq((await call('/config')).d.playbooks, { on: true, who: 'mentors' });
    eq((await share(NED, { src: 'n1', name: 'Mine', rules: [{ id: 'n', text: 'One rule' }] })).status, 403);
    eq((await call('/playbooks/mine', { key: NED })).d.canShare, false);
    eq((await share(MIA, { src: 'm2', name: 'Second', rules: [{ id: 'n', text: 'One rule' }] })).status, 200, 'a mentor still can');
    const A = (await call('/admin/playbooks', { admin: true })).d.playbooks; eq(A.map(x => [x.name, x.handle]), [['Second', 'mia'], ['Breakout retest', 'mia']]);
    eq((await call('/admin/overview', { admin: true })).d.playbooks, 2);
    eq((await call('/admin/playbooks/' + A[0].id, { method: 'DELETE', admin: true })).status, 200);
    ok((await call('/admin/log', { admin: true })).d.log.some(x => x.what === 'DELETE playbooks/' + A[0].id), 'logged like every admin change');
    await call('/admin/config', { method: 'PUT', admin: true, body: { playbooks: { on: false } } });
    eq((await call('/playbooks', { key: NED })).status, 403);
    eq((await call('/admin/playbooks', { admin: true })).d.playbooks.length, 1, 'kept while off');
  });
} finally { await new Promise(r => app.close(r)); }

console.log('\nIn the app: copies, updates and the journal’s playbooks');
const src = readAppSource(htmlPath), { evalModule, grabFn } = makeExtractor(src);
const P = await evalModule(['pbNorm', 'pbKey', 'pbsAdoptCopy', 'pbsApplyUpdate', 'pbsRuleDiff', 'pbsSharedFrom', 'pbsDiffers']);
const SH = { id: 'abcdef012345', name: 'Breakout retest', version: 3, author: { handle: 'mia' }, rules: [{ id: 'ra', text: 'Wait for the retest' }, { id: 'rb', text: 'Stop under the range' }] };
let n = 0; const mk = () => 'pbnew' + (++n);
t('a playbook’s source survives normalizing (so sync and backups keep it); junk sources are dropped', () => {
  const [a, b] = P.pbNorm([{ id: 'p1', name: 'A', rules: [], src: { id: 'abcdef012345', h: 'mia', v: 3, at: 5, x: 1 } }, { id: 'p2', name: 'B', rules: [], src: { id: 7 } }]);
  eq(a.src, { id: 'abcdef012345', h: 'mia', v: 3, at: 5 }); eq('src' in b, false);
});
t('adopting copies the name and rules with their ids and records where it came from', () => {
  const r = P.pbsAdoptCopy(SH, [], 1000, mk);
  eq(r.pb, { id: 'pbnew1', name: 'Breakout retest', rules: SH.rules, at: 1000, createdAt: 1000, src: { id: SH.id, h: 'mia', v: 3, at: 1000 } }); eq(r.renamed, false);
});
t('a name you already use gets the author’s handle; a copy you already hold isn’t copied twice', () => {
  const mine = [{ id: 'p1', name: 'breakout  retest', rules: [] }];
  const r = P.pbsAdoptCopy(SH, mine, 1000, mk); eq([r.pb.name, r.renamed], ['Breakout retest · @mia', true]);
  eq(P.pbsAdoptCopy(SH, [...mine, r.pb], 2000, mk).existing.id, r.pb.id);
  eq(P.pbsAdoptCopy(SH, [...mine, { id: 'p9', name: 'Breakout retest · @mia', rules: [] }], 1000, mk).error.length > 0, true);
  eq(P.pbsSharedFrom([{ id: 'p1', name: 'x', rules: [] }, r.pb], SH.id).id, r.pb.id);
});
t('taking an update keeps your name, replaces the rules (unchanged ones keep their ids) and the version', () => {
  const local = { id: 'p3', name: 'My breakout', rules: SH.rules, at: 1000, createdAt: 900, src: { id: SH.id, h: 'mia', v: 3, at: 1000 } };
  const next = Object.assign({}, SH, { version: 4, rules: [SH.rules[0], { id: 'rc', text: 'Risk 1R or less' }] });
  eq(P.pbsApplyUpdate(local, next, 5000), { id: 'p3', name: 'My breakout', rules: next.rules, at: 5000, createdAt: 900, src: { id: SH.id, h: 'mia', v: 4, at: 5000 } });
  eq(P.pbsRuleDiff(local.rules, next.rules), { added: ['Risk 1R or less'], removed: ['Stop under the range'], kept: 1 });
});
t('your own playbook differs from what you shared when its name or rules do', () => {
  const pb = { id: 'p1', name: 'A', rules: [{ id: 'a', text: 'one' }] };
  eq(P.pbsDiffers(pb, { name: 'A', rules: [{ id: 'a', text: 'one' }] }), false);
  eq(P.pbsDiffers(pb, { name: 'B', rules: [{ id: 'a', text: 'one' }] }), true);
  eq(P.pbsDiffers(pb, { name: 'A', rules: [{ id: 'a', text: 'one!' }] }), true);
  eq(P.pbsDiffers(pb, null), false);
});
t('the screen is a Daruma feature (#playbooks), and the journal keeps the source when a playbook is edited', () => {
  ok(src.includes("pzFeature({id:'playbooks'"));
  ok(grabFn('wirePlaybooks').includes('src:prev.src'), 'editing an adopted playbook in the journal keeps where it came from');
});
report('shared playbooks');
