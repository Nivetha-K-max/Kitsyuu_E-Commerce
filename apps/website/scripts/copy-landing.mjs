/* M5: puts the original KITSYUU landing page (dist/, the source of truth — never modified here) into public/ at build
   time, so `/` can serve it as a static file while the Next.js store lives at /store. Runs before `next build` and
   `next dev` (npm pre-scripts). The copied files are generated and git-ignored (see ../.gitignore), so the 99 MB frame
   sequence is not committed twice.

   - Files the store already ships in public/ (styles.css, fonts, logo, editorial image) are shared, not copied: they
     must be byte-identical to dist/, otherwise the build stops so the landing can never change by accident.
   - The only difference from dist/landing.html is one added nav link to the store (<a href="/store">Store</a>). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB, '../../dist');
const PUBLIC = path.join(WEB, 'public');
const FRAMES = 'assets/upscaled-1440';
const COPY = ['app.js', 'content.json', 'assets/sequence.json', 'assets/upscaled-poster.webp', 'assets/volume.webp', 'assets/layers.webp'];
const SHARED = ['styles.css', 'fonts.css', 'assets/kitsyuu-icon.svg', 'assets/editorial.webp',
  ...fs.readdirSync(path.join(DIST, 'assets/fonts')).filter(f => f.endsWith('.woff2')).map(f => `assets/fonts/${f}`)];
const NAV_END = '<a href="#about">Our world</a></nav>';
const STORE_LINK = '<a href="#about">Our world</a><a href="/store">Store</a></nav>';

const fail = msg => { console.error(`copy-landing: ${msg}`); process.exit(1); };
if (!fs.existsSync(path.join(DIST, 'landing.html'))) fail(`dist/landing.html not found at ${DIST}`);

// Shared files must match the landing's own copies exactly.
const differs = SHARED.filter(f => !fs.existsSync(path.join(PUBLIC, f)) || !fs.readFileSync(path.join(PUBLIC, f)).equals(fs.readFileSync(path.join(DIST, f))));
if (differs.length) fail(`these public/ files differ from dist/ and would change the landing page: ${differs.join(', ')}`);

// The frame sequence the landing plays (assets/sequence.json → pattern + count).
const seq = JSON.parse(fs.readFileSync(path.join(DIST, 'assets/sequence.json'), 'utf8'));
if (!seq.pattern.startsWith(`${FRAMES}/`)) fail(`unexpected frame pattern ${seq.pattern}`);
const frames = Array.from({ length: seq.count }, (_, i) => seq.pattern.replace('{index}', String(i).padStart(seq.padding, '0')));

let copied = 0, bytes = 0;
const copy = rel => {
  const from = path.join(DIST, rel), to = path.join(PUBLIC, rel);
  if (!fs.existsSync(from)) fail(`missing source file dist/${rel}`);
  const size = fs.statSync(from).size;
  bytes += size;
  if (fs.existsSync(to) && fs.statSync(to).size === size && fs.readFileSync(to).equals(fs.readFileSync(from))) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
};
[...COPY, ...frames].forEach(copy);

// landing.html: the original page plus the store link (the only change).
const html = fs.readFileSync(path.join(DIST, 'landing.html'), 'utf8');
if (html.split(NAV_END).length !== 2) fail('could not find the landing navigation to add the store link (dist/landing.html changed?)');
fs.writeFileSync(path.join(PUBLIC, 'landing.html'), html.replace(NAV_END, STORE_LINK));

console.log(`copy-landing: landing ready (${frames.length} frames, ${(bytes / 1048576).toFixed(1)} MB; ${copied} file(s) copied, ${SHARED.length} shared files verified)`);
