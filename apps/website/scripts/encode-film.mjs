/* Performance (2026-10-01): builds the homepage film's web-sized frames and posters from the original landing frames
   (public/assets/upscaled-1440: 241 × 2560×1440 WebP, quality 100, ~100 MB), into public/assets/film-v1/:
     d/frame-NNNN.webp   1600×900, the whole frame (desktop, tablets, phones held sideways)
     m/frame-NNNN.webp   720×960, the centre 1080×1440 of each frame: exactly the part a portrait phone shows today
                         (the canvas covers the screen and centres the frame), so nothing visible is lost
     poster-<w>.{avif,webp}     1280 / 1920 / 2560 wide (the first frame, as before)
     poster-m-<w>.{avif,webp}   720 / 1080 wide, the portrait crop at the poster's own phone position (object-position 58%)
     film.json            what the homepage reads (sizes, patterns, frame count)
   The originals stay as they are (/our-story still plays them). A changed film must use a new folder (film-v2): the
   files are cached for a year. Usage (repo root): node apps/website/scripts/encode-film.mjs */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const SRC = path.join(PUB, 'assets/upscaled-1440');
const OUT = path.join(PUB, 'assets/film-v1');
const seq = JSON.parse(fs.readFileSync(path.join(PUB, 'assets/sequence.json'), 'utf8'));
const W = seq.width, H = seq.height;                       // 2560 × 1440
const CROP_W = Math.round(H * 0.75);                        // 1080: covers any screen narrower than 3:4
const pad = i => String(i).padStart(seq.padding, '0');
fs.mkdirSync(path.join(OUT, 'd'), {recursive: true}); fs.mkdirSync(path.join(OUT, 'm'), {recursive: true});
sharp.concurrency(1);

async function frame(i) {
  const src = path.join(SRC, `frame-${pad(i)}.webp`);
  const d = path.join(OUT, 'd', `frame-${pad(i)}.webp`), m = path.join(OUT, 'm', `frame-${pad(i)}.webp`);
  if (!fs.existsSync(d)) await sharp(src).resize(1600, 900).webp({quality: 72, effort: 5}).toFile(d);
  if (!fs.existsSync(m)) await sharp(src).extract({left: Math.round((W - CROP_W) / 2), top: 0, width: CROP_W, height: H}).resize(720, 960).webp({quality: 70, effort: 5}).toFile(m);
}
const queue = Array.from({length: seq.count}, (_, i) => i);
await Promise.all(Array.from({length: Math.max(2, os.cpus().length - 1)}, async () => { while (queue.length) await frame(queue.shift()); }));

const poster = path.join(PUB, seq.poster);
for (const w of [1280, 1920, 2560]) {
  await sharp(poster).resize(w, Math.round(w * H / W)).avif({quality: 55, effort: 6}).toFile(path.join(OUT, `poster-${w}.avif`));
  await sharp(poster).resize(w, Math.round(w * H / W)).webp({quality: 78, effort: 5}).toFile(path.join(OUT, `poster-${w}.webp`));
}
const left = Math.round(0.58 * (W - CROP_W));               // store.css (max-width:700px): object-position 58% 40%
for (const w of [720, 1080]) {
  const img = () => sharp(poster).extract({left, top: 0, width: CROP_W, height: H}).resize(w, Math.round(w * H / CROP_W));
  await img().avif({quality: 55, effort: 6}).toFile(path.join(OUT, `poster-m-${w}.avif`));
  await img().webp({quality: 78, effort: 5}).toFile(path.join(OUT, `poster-m-${w}.webp`));
}

const size = dir => fs.readdirSync(path.join(OUT, dir)).reduce((n, f) => n + fs.statSync(path.join(OUT, dir, f)).size, 0);
const manifest = {
  count: seq.count, padding: seq.padding, fps: seq.fps,
  desktop: {width: 1600, height: 900, pattern: 'assets/film-v1/d/frame-{index}.webp', totalBytes: size('d')},
  portrait: {width: 720, height: 960, pattern: 'assets/film-v1/m/frame-{index}.webp', totalBytes: size('m'), maxAspect: 0.75},
};
fs.writeFileSync(path.join(OUT, 'film.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
for (const f of fs.readdirSync(OUT).filter(f => f.startsWith('poster'))) console.log(f, fs.statSync(path.join(OUT, f)).size);
