/* Runs both storefront suites against the Next.js app (npm start → :3001).
   The landing-page check uses the untouched static site (node server.cjs → :3000). */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

let pass = 0, total = 0;
for (const f of ['check.mjs', 'phase2.mjs']) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(f, import.meta.url))], {encoding: 'utf8', timeout: 900000});
  const lines = (r.stdout || '').split('\n').filter(l => /^(PASS|FAIL)/.test(l));
  lines.filter(l => l.startsWith('FAIL')).forEach(l => console.log(l));
  const p = lines.filter(l => l.startsWith('PASS')).length;
  pass += p; total += lines.length;
  console.log(`${f}: ${p}/${lines.length}`);
  if (r.stderr) console.error(r.stderr.slice(0, 2000));
}
console.log(`TOTAL: ${pass}/${total}`);
process.exit(pass === total && total > 0 ? 0 : 1);
