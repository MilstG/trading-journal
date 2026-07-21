// Shared test harness for every suite in this folder. Before this existed, each suite
// re-declared its own t / ok / eq / near and its own grabBlock / grabFn / evalFn, and they
// had drifted (three different `near` tolerances, three `ok` messages, async vs sync `t`).
// Import from here instead so the suites stay honest to one definition.
//
//   import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
//   const { grabFn, evalFn, evalClass } = makeExtractor(html);   // for suites that read ledger.html
//   ... await t('name', () => { ... });  // or bare t(...) for sync bodies
//   report();

import { Buffer } from 'node:buffer';

let pass = 0, fail = 0;

// Works for both call styles: `await t(name, asyncFn)` and bare `t(name, syncFn)`.
// A sync body settles the count before the next line; an async body returns the promise
// so the caller's `await` settles it. Either way the count is final before report().
export function t(name, fn){
  const done = () => { pass++; console.log('  \u2713 ' + name); };
  const failed = (e) => { fail++; console.error('  \u2717 ' + name + '\n    ' + (e && (e.stack || e.message) || e)); };
  let r;
  try { r = fn(); }
  catch (e) { failed(e); return; }
  if (r && typeof r.then === 'function') return r.then(done, failed);
  done();
}

export const ok = (v, m) => { if (!v) throw new Error(m || 'assertion failed'); };

export const eq = (a, b, m) => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((m || 'not equal') + '\n    got:  ' + ja + '\n    want: ' + jb);
};

export const near = (a, b, eps = 1e-6, m) =>
  ok(Math.abs(a - b) < eps, (m ? m + ': ' : '') + `${a} !~ ${b}`);

export function report(label){
  console.log(`\n${label ? label + ': ' : ''}${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// Pulls pure functions straight out of the shipped ledger.html so tests exercise real code.
// Brace-matched from the declaration; skips the `async ` prefix automatically. Assumes the
// target functions don't carry `{` in their parameter list (true for everything here).
export function makeExtractor(html){
  function grabBlock(header){
    const i = html.indexOf(header);
    if (i < 0) throw new Error(header + ' not found');
    let d = 0;
    for (let p = html.indexOf('{', i); p < html.length; p++){
      if (html[p] === '{') d++;
      else if (html[p] === '}' && --d === 0) return html.slice(i, p + 1);
    }
    throw new Error('unbalanced braces: ' + header);
  }
  function grabFn(name){
    const header = html.indexOf('async function ' + name + '(') >= 0
      ? 'async function ' + name + '('
      : 'function ' + name + '(';
    return grabBlock(header);
  }
  const evalFn = (name) => (0, eval)('(' + grabFn(name) + ')');
  const evalClass = (name) => (0, eval)('(' + grabBlock('class ' + name + '{') + ')');

  // Bundle several extracted functions into one ES module so they can reference each other
  // (e.g. reconstructTrades -> newTrade/tallyFill). `exports` defaults to every name.
  const evalModule = (names, exports) => {
    const src = names.map(grabFn).join('\n') +
      '\nexport { ' + (exports || names).join(', ') + ' };';
    return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  };

  return { grabBlock, grabFn, evalFn, evalClass, evalModule };
}
