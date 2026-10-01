'use client';
import { useEffect, useState } from 'react';
import type { ImageInfo } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { ComingSoon } from './ui';
import { useColour } from './ColourScope';

/* Primary image plus thumbnails when official photos are added to media.gallery. Zoom stays off. */
export default function Gallery({ p, images: all, caption }: { p: Product; images: ImageInfo[]; caption: [string, string] }) {
  // Third pass: with a colour chosen, that colour's photos first, then the general ones; other colours' photos are hidden.
  const { colour } = useColour();
  const shown = colour ? [...all.filter(m => m.colour === colour), ...all.filter(m => !m.colour)] : all;
  const images = shown.length ? shown : all;
  const [i, setI] = useState(0), img = images[Math.min(i, images.length - 1)];
  useEffect(() => setI(0), [colour]);
  return (
    <section className="st-gallery" aria-label="Product images" data-zoom={String(images[0].zoom)}>
      <figure className={`st-gallery-main${img.held ? ' is-held' : ''}`}>
        <div className="st-gallery-stage">
          {img.held ? <ComingSoon p={p} label /> : <img id="st-main-img" src={img.src} alt={img.alt} width={img.width} height={img.height} style={{ ['--w' as string]: img.width + 'px' }} decoding="async" fetchPriority="high" />}
        </div>
        <figcaption><span>{caption[0]}</span><span>{caption[1]}</span></figcaption>
      </figure>
      {images.length > 1 && (
        <ul className="st-thumbs" aria-label="Choose an image">
          {images.map((m, n) => <li key={m.src}><button type="button" data-image={n} aria-pressed={img === m} aria-label={`Show image ${n + 1} of ${images.length}`} onClick={() => setI(n)}><img src={m.src} alt="" loading="lazy" /></button></li>)}
        </ul>
      )}
    </section>
  );
}
