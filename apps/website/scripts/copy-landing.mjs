/* M5: brings the original KITSYUU landing page (dist/, the source of truth — never modified here) into the Next.js
   /our-story page at build time (see app/our-story/page.tsx; the homepage `/` is the store).
   Runs before `next build`, `next dev` and `tsc` (npm pre-scripts). Everything it writes is generated and git-ignored
   (see ../.gitignore), so the 99 MB frame sequence is not committed a second time.

   Output:
   - lib/landing.generated.ts — the landing's <body> markup, rendered by components/Landing.tsx. Only technically
     required edits are made, each asserted so a changed dist/landing.html stops the build instead of drifting:
       · <main id="top"> becomes <div id="top"> (the page already has the store's <main>; one main landmark per page);
       · one nav link to the store: <a href="/">Store</a> (the landing's own header is hidden on /our-story by store.css);
       · asset URLs become root-absolute (/assets/…), so they resolve on any URL;
       · the "Japan → India" route wording is removed (client request; see EDITS and CONTENT_EDITS).
   - public/: app.js, content.json, the sequence manifest, images and the 241 frames, unchanged.
   Files the store already ships in public/ (styles.css, fonts, logo, editorial image) are shared, not copied: they must
   be byte-identical to dist/, otherwise the build stops so the landing can never change by accident. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB, '../../dist');
const PUBLIC = path.join(WEB, 'public');
const MODULE = path.join(WEB, 'lib/landing.generated.ts');
const FRAMES = 'assets/upscaled-1440';
const COPY = ['app.js', 'assets/sequence.json', 'assets/upscaled-poster.webp', 'assets/volume.webp', 'assets/layers.webp'];
const SHARED = ['styles.css', 'fonts.css', 'assets/kitsyuu-icon.svg', 'assets/editorial.webp',
  ...fs.readdirSync(path.join(DIST, 'assets/fonts')).filter(f => f.endsWith('.woff2')).map(f => `assets/fonts/${f}`)];

const fail = msg => { console.error(`copy-landing: ${msg}`); process.exit(1); };
if (!fs.existsSync(path.join(DIST, 'landing.html'))) fail(`dist/landing.html not found at ${DIST}`);

// Shared files must match the landing's own copies exactly.
const differs = SHARED.filter(f => !fs.existsSync(path.join(PUBLIC, f)) || !fs.readFileSync(path.join(PUBLIC, f)).equals(fs.readFileSync(path.join(DIST, f))));
if (differs.length) fail(`these public/ files differ from dist/ and would change the landing page: ${differs.join(', ')}`);

// Static files: scripts, content, images and the frame sequence named by assets/sequence.json.
const seq = JSON.parse(fs.readFileSync(path.join(DIST, 'assets/sequence.json'), 'utf8'));
if (!seq.pattern.startsWith(`${FRAMES}/`)) fail(`unexpected frame pattern ${seq.pattern}`);
const frames = Array.from({ length: seq.count }, (_, i) => seq.pattern.replace('{index}', String(i).padStart(seq.padding, '0')));
let copied = 0, bytes = 0;
for (const rel of [...COPY, ...frames]) {
  const from = path.join(DIST, rel), to = path.join(PUBLIC, rel);
  if (!fs.existsSync(from)) fail(`missing source file dist/${rel}`);
  const size = fs.statSync(from).size;
  bytes += size;
  if (fs.existsSync(to) && fs.statSync(to).size === size && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}
fs.rmSync(path.join(PUBLIC, 'landing.html'), { force: true });   // left over from the earlier stand-alone version

// content.json (the wording app.js puts into [data-copy] elements), with the "Japan → India" route wording removed
// (client request, 2026-10-01). Each edit is asserted, so a changed dist/content.json stops the build instead of drifting.
const content = JSON.parse(fs.readFileSync(path.join(DIST, 'content.json'), 'utf8'));
const CONTENT_EDITS = [
  [['hero', 'eyebrow'], 'KITSYUU — FROM JAPAN TO INDIA', ''],
  [['about', 'description'], 'Kitsyuu brings streetwear from Japan to India. An approach to getting dressed that starts with shape, builds through layers, and becomes your own.',
    'An approach to getting dressed that starts with shape, builds through layers, and becomes your own.'],
];
for (const [[a, b], from, to] of CONTENT_EDITS) {
  if (content[a]?.[b] !== from) fail(`expected content.json ${a}.${b} to be "${from}"`);
  content[a][b] = to;
}
const contentOut = JSON.stringify(content, null, 2) + '\n';
if (!fs.existsSync(path.join(PUBLIC, 'content.json')) || fs.readFileSync(path.join(PUBLIC, 'content.json'), 'utf8') !== contentOut) { fs.writeFileSync(path.join(PUBLIC, 'content.json'), contentOut); copied++; }

// The landing markup (<body> contents) with the required edits.
const html = fs.readFileSync(path.join(DIST, 'landing.html'), 'utf8');
const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1];
if (!body) fail('no <body> in dist/landing.html');
const edits = [
  ['<main id="top">', '<div id="top">'],
  ['</main>', '</div>'],
  ['<a href="#about">Our world</a></nav>', '<a href="#about">Our world</a><a href="/">Store</a></nav>'],
  // The client asked to remove this line wherever it appears (2026-09-30).
  ['<p class="eyebrow"><span aria-hidden="true"></span><span data-copy="hero.eyebrow">KITSYUU — FROM JAPAN TO INDIA</span></p>', ''],
  // The other "Japan → India" route lines (2026-10-01): the film's top-right label and the "Our world" section label.
  ['<span>KITSYUU / FORM STUDY 001</span><span>JAPAN <b>→</b> INDIA</span>', '<span>KITSYUU / FORM STUDY 001</span>'],
  ['<span>03 — OUR WORLD</span><span>JAPAN → INDIA</span>', '<span>03 — OUR WORLD</span>'],
  // The same sentence as content.json about.description (the markup's text before app.js fills it, and what search engines read).
  ['<p data-copy="about.description">Kitsyuu brings streetwear from Japan to India. An approach', '<p data-copy="about.description">An approach'],
];
let markup = body;
for (const [from, to] of edits) {
  if (markup.split(from).length !== 2) fail(`expected exactly one "${from}" in dist/landing.html`);
  markup = markup.replace(from, to);
}
// Line endings as the browser parses them (CRLF becomes LF), so the server-rendered markup matches on every checkout.
markup = markup.replace(/(src|href)="assets\//g, '$1="/assets/').replace(/\r\n?/g, '\n').trim();
if (/<main[\s>]|<script/i.test(markup)) fail('landing markup still contains <main> or <script>');
fs.writeFileSync(MODULE, `/* GENERATED by scripts/copy-landing.mjs from dist/landing.html — do not edit. */\nexport const LANDING_HTML = ${JSON.stringify(markup)};\n`);

console.log(`copy-landing: landing ready (${frames.length} frames, ${(bytes / 1048576).toFixed(1)} MB; ${copied} file(s) copied, ${SHARED.length} shared files verified; markup ${markup.length} chars)`);
