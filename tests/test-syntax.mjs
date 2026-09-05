// Whole-file parse check. The extraction suites only parse the functions they pull out,
// so a typo in pure UI code (a template literal, an event handler) could ship an
// unparseable app while every other suite stayed green. vm.Script parses each <script>
// block completely without executing anything.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { t, ok, report } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

t('ledger.html contains the expected script blocks', () => {
  ok(scripts.length >= 2, 'found ' + scripts.length);
});
scripts.forEach((src, i) => {
  t('script block ' + i + ' parses (' + (src.length / 1024).toFixed(0) + 'KB)', () => {
    new vm.Script(src, { filename: 'ledger-block-' + i + '.js' }); // throws with line info on failure
  });
});

report('syntax');
