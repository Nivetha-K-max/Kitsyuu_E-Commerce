/* Runs the storefront suites against the Next.js app (npm start → :3001).
   The landing-page check uses the untouched static site (node server.cjs → :3000).
   2026-10-08: a suite that stops early is a FAILED run. Before, a file that crashed (e.g. a page that did not finish
   loading) printed no checks, was counted as "0/0" and the run still ended "TOTAL: n/n", exit 0. Now a file must exit
   cleanly AND report at least one check; otherwise it is listed as ABORTED and the run fails. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

let pass = 0, total = 0;
const aborted = [];
for (const f of ['check.mjs', 'phase2.mjs', 'hero.mjs']) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(f, import.meta.url))], {encoding: 'utf8', timeout: 900000});
  const lines = (r.stdout || '').split('\n').filter(l => /^(PASS|FAIL)/.test(l));
  lines.filter(l => l.startsWith('FAIL')).forEach(l => console.log(l));
  const p = lines.filter(l => l.startsWith('PASS')).length;
  pass += p; total += lines.length;
  // Did not complete: killed by the timeout (status null), crashed (non-zero status with every reported check passing), or reported nothing.
  const why = r.error ? `did not finish (${r.error.code ?? r.error.message})` : r.status === null ? `stopped by signal ${r.signal}` : lines.length === 0 ? `reported no checks (exit ${r.status})`
    : r.status !== 0 && p === lines.length ? `exited ${r.status} after its last reported check` : null;
  if (why) aborted.push(`${f}: ${why}`);
  console.log(`${f}: ${p}/${lines.length}${why ? `  ABORTED — ${why}` : ''}`);
  if (r.stderr) console.error(r.stderr.slice(0, 2000));
}
console.log(`TOTAL: ${pass}/${total}${aborted.length ? `  — INCOMPLETE: ${aborted.length} suite(s) did not complete` : ''}`);
for (const a of aborted) console.log(`ABORTED  ${a}`);
process.exit(pass === total && total > 0 && aborted.length === 0 ? 0 : 1);
