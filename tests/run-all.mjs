// Runs every suite; exits nonzero on the first failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter(f => f.startsWith('test-') && f.endsWith('.mjs')).sort();
let failed = false;
for (const f of suites) {
  console.log('\n━━ ' + f + ' ━━');
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
