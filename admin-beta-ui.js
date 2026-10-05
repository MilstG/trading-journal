// The admin panel's Beta access screen (private beta mode: see the beta section in social.js and
// beta.html). admin.html loads this before its own script; it stays out of admin.html because that page
// has a size budget. It reaches the panel through window.ADM (api, render and the form helpers), which
// admin.html sets up, and answers its own buttons (ids and data- attributes starting with bt).
//
//   - The mode: on or off, whether profiles from before keep access, whether the docs stay public, how long
//     new invites last, and the line under the beta page's title.
//   - Invites: made in batches (one per name, or a number of them). A code is shown once, when it's made,
//     with its /join# link: the server keeps only its hash. Each one is withdrawn while unused, or replaced
//     by a new one (the old link stops working).
(function () {
  'use strict';
  let st = null, loading = false, fresh = null, busy = false, filter = 'all';
  const A = () => window.ADM;
  const $ = id => document.getElementById(id);
  const esc = s => A().esc(s);
  const day = ms => ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—';
  const linkOf = code => location.origin + '/join#' + code;
  async function refresh() { loading = true; try { st = await A().api('/beta'); } catch (e) { st = { error: e.message }; } loading = false; A().render(); }
  async function run(fn, msg) { if (busy) return; busy = true;
    try { const r = await fn(); if (msg) A().note(msg); await refresh(); return r || {}; } catch (e) { A().note(e.message, true); } finally { busy = false; } }

  const STATE = { open: ['Waiting', 'wait'], used: ['Activated', 'ok'], expired: ['Expired', ''], revoked: ['Withdrawn', 'ban'] };
  function rows() {
    const list = st.invites.filter(x => filter === 'all' || (filter === 'closed' ? x.state === 'expired' || x.state === 'revoked' : x.state === filter));
    if (!list.length) return '<p class="muted" style="margin:0">' + (st.invites.length ? 'None here.' : 'No invites yet. Make the first ones above.') + '</p>';
    return `<div class="scroll"><table><thead><tr><th>For</th><th>Code</th><th>Made</th><th>Expires</th><th>Status</th><th aria-label="Actions"></th></tr></thead><tbody>${list.slice(0, 300).map(x => {
      const [label, cls] = STATE[x.state] || [x.state, ''];
      const who = x.used ? (x.used.handle ? `<a href="#members/${esc(encodeURIComponent(x.used.id))}">@${esc(x.used.handle)}</a>` : '<span class="muted">deleted profile</span>') + ' · ' + esc(day(x.used.at)) : '';
      const acts = (x.state === 'open' ? `<button class="sm danger fit" data-btrev="${esc(x.id)}">Withdraw</button>` : '') +
        (x.state !== 'used' ? `<button class="sm fit" data-btnew="${esc(x.id)}">New link</button>` : '');
      return `<tr><td><b>${esc(x.note || '—')}</b>${x.unlocked ? ' <span class="pill xp">unlocked</span>' : ''}</td><td><code>••••-${esc(x.tail)}</code></td><td class="nw">${esc(day(x.at))}<div class="muted small">${esc(x.by || '')}</div></td>
        <td class="nw">${x.state === 'used' ? '—' : esc(day(x.exp))}</td><td class="nw"><span class="pill ${cls}">${esc(label)}</span> ${who}</td><td class="n nw"><div class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap">${acts}</div></td></tr>`; }).join('')}</tbody></table></div>`;
  }
  function freshBox() {
    if (!fresh || !fresh.length) return '';
    return `<div class="sub" style="margin-top:14px;border-color:#1F4A36"><b>${fresh.length === 1 ? 'Invite ready' : fresh.length + ' invites ready'}</b>
      <p class="hint" style="margin:2px 0 10px">Copy ${fresh.length === 1 ? 'it' : 'them'} now and send each one yourself (Telegram, DM, email). Only a fingerprint of each code is kept, so this is the one time ${fresh.length === 1 ? 'the link' : 'the links'} can be shown. Each works once.</p>
      ${fresh.map((f, i) => `<div class="row" style="align-items:center;flex-wrap:nowrap;gap:8px;padding:6px 0;border-top:1px solid var(--line)"><b class="fit" style="min-width:60px">${esc(f.note || 'Invite ' + (i + 1))}</b>
        <code style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(linkOf(f.code))}">${esc(linkOf(f.code))}</code><button class="sm fit" data-btcopy="${i}">Copy</button></div>`).join('')}
      <div class="row" style="gap:8px;margin-top:8px">${fresh.length > 1 ? '<button class="sm fit" id="btCopyAll">Copy all</button>' : ''}<button class="sm fit" id="btDone">Done</button></div></div>`;
  }
  function view() {
    if (!st) { if (!loading) refresh(); return '<p class="muted">Loading…</p>'; }
    if (st.error) return `<p class="warn">${esc(st.error)}</p>`;
    const c = st.config, F = A(), ttl = [7, 14, 30, 60, 90].map(d => [d, d + ' days']);
    const lead = st.active ? `<span class="pill ok">On</span> <span class="muted small">since ${esc(day(c.since))}${c.by ? ' · by ' + esc(c.by) : ''}</span>` : '<span class="pill">Off</span> <span class="muted small">anyone can open the app; Settings → Joining applies</span>';
    return `<div class="two"><section class="card"><div class="ch"><h2>Private beta mode</h2><div>${lead}</div></div>
        ${F.box('btOn', 'Private beta mode', c.on, 'On: the journal, Daruma and their data need an activated profile; guest mode and open joining stop; this panel works as before. Off: everything goes back to how it was, and no one’s profile or data changes.')}
        <h3>Who gets in</h3>
        ${F.box('btKeep', 'Profiles from before keep access', c.keepExisting, F.fmt(st.existing) + ' profile' + (st.existing === 1 ? '' : 's') + ' didn’t come by an invite. Untick and they need one too: the beta page asks them for a code the first time.')}
        ${F.box('btDocs', 'Help, docs and the tutorial stay public', c.publicDocs, 'So you can send people there before they’re in.')}
        <h3>Invites and the beta page</h3>
        <div class="row">${F.field('btTtl', 'New invites last', F.sel('btTtl', ttl, ttl.some(t => t[0] === c.ttlDays) ? c.ttlDays : 14))}</div>
        ${F.field('btMsg', 'Line under the beta page’s title', `<input id="btMsg" maxlength="300" value="${esc(c.message)}" placeholder="We’re letting traders in a few at a time. If we sent you an invite, open the link or enter your code.">`, 'Empty shows the line in the placeholder. Put where to ask for an invite here, if you like.')}
        <div class="actions"><button class="primary" id="btSave">Save</button></div></section>
      <section class="card" id="btMake"><h2>Create invites</h2>
        <p class="hint" style="margin-top:0">Each invite is one link (and the same code to type) that activates one profile, once. Later sign-ins use a passkey, the member’s wallet, or a sign-in code.</p>
        ${F.field('btNames', 'Who they’re for (only you see this)', '<input id="btNames" maxlength="2000" placeholder="Ana, Ben, Carla" autocomplete="off">', 'One invite per name, separated by commas. Or leave it empty and set how many.')}
        <div class="row">${F.field('btCount', 'How many', '<input id="btCount" type="number" min="1" max="50" placeholder="1">')}${F.field('btExp', 'Expires after', F.sel('btExp', ttl, c.ttlDays))}</div>
        ${F.box('btUnlock', 'Unlock every feature for them', false)}
        ${F.box('btLeagues', 'Put them in the auto-join leagues', true)}
        <div class="actions"><button class="primary" id="btCreate">Create invites</button></div>${freshBox()}</section></div>
      <div style="margin-top:16px">${F.tiles([['Invites made', F.fmt(st.counts.all)], ['Activated', F.fmt(st.counts.used), st.counts.all ? Math.round(100 * st.counts.used / st.counts.all) + '% of made' : ''], ['Waiting to be used', F.fmt(st.counts.open)], ['Expired or withdrawn', F.fmt(st.counts.closed)]])}</div>
      <section class="card" style="margin-top:16px"><div class="ch"><h2>Invites</h2><div class="row" style="gap:6px;flex:1 1 auto;justify-content:flex-end">${[['all', 'All', st.counts.all], ['open', 'Waiting', st.counts.open], ['used', 'Activated', st.counts.used], ['closed', 'Expired', st.counts.closed]]
        .map(([k, l, n]) => `<button class="sm fit${filter === k ? ' primary' : ''}" data-btf="${k}" aria-pressed="${filter === k}">${l} ${n}</button>`).join('')}</div></div>
        ${rows()}
        <p class="hint">“New link” replaces a lost or expired invite; an unused one it replaces stops working. To shut out someone who already activated, suspend or delete them under Members, or sign them out of every device there.</p></section>`;
  }

  const copy = t => navigator.clipboard ? navigator.clipboard.writeText(t).then(() => A().note('Copied.'), () => A().note('Couldn’t copy: select the link and copy it.', true)) : A().note('Select the link and copy it.', true);
  document.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b || !window.ADM || busy) return;
    const d = b.dataset, val = id => $(id) ? $(id).value : '', chk = id => !!($(id) && $(id).checked);
    if (b.id === 'btSave') {
      const on = chk('btOn');
      if (on !== st.config.on && !confirm(on ? 'Turn on private beta mode? From now on, people without an activated profile see the beta page instead of the journal and Daruma.'
        : 'Turn off private beta mode? Anyone can open the journal and Daruma again, and joining follows Settings → Joining.')) return;
      return run(() => A().api('/beta', { method: 'PUT', body: { on, keepExisting: chk('btKeep'), publicDocs: chk('btDocs'), ttlDays: +val('btTtl'), message: val('btMsg').trim() } }),
        on === st.config.on ? 'Saved.' : on ? 'Private beta mode is on.' : 'Private beta mode is off.');
    }
    if (b.id === 'btCreate') {
      const names = val('btNames').split(/[,\n]/).map(x => x.trim()).filter(Boolean), count = +val('btCount') || (names.length ? 0 : 1);
      if (names.length > 50 || count > 50) return A().note('Make 1 to 50 invites at a time.', true);
      return run(async () => { const r = await A().api('/beta/invites', { body: { names, count, ttlDays: +val('btExp'), unlocked: chk('btUnlock'), leagues: chk('btLeagues') } });
        fresh = r.invites; if ($('btNames')) $('btNames').value = ''; if ($('btCount')) $('btCount').value = ''; });
    }
    if (d.btcopy != null && fresh && fresh[+d.btcopy]) return copy(linkOf(fresh[+d.btcopy].code));
    if (b.id === 'btCopyAll' && fresh) return copy(fresh.map((f, i) => (f.note || 'Invite ' + (i + 1)) + ': ' + linkOf(f.code)).join('\n'));
    if (b.id === 'btDone') { fresh = null; return A().render(); }
    if (d.btf) { filter = d.btf; return A().render(); }
    if (d.btrev) { if (!confirm('Withdraw this invite? Its link stops working.')) return; return run(() => A().api('/beta/invites/' + encodeURIComponent(d.btrev), { body: { action: 'revoke' } }), 'Invite withdrawn.'); }
    if (d.btnew) return run(async () => { const r = await A().api('/beta/invites/' + encodeURIComponent(d.btnew), { body: { action: 'replace' } }); fresh = [r]; });
  });
  window.ABETA = { view };
})();
