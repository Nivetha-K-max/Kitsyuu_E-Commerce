'use client';
import { useState } from 'react';
import type { ImageInfo } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { ComingSoon } from './ui';

/* Primary image plus thumbnails when official photos are added to media.gallery. Zoom stays off. */
export default function Gallery({ p, images, caption }: { p: Product; images: ImageInfo[]; caption: [string, string] }) {
  const [i, setI] = useState(0), img = images[i];
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
          {images.map((m, n) => <li key={m.src}><button type="button" data-image={n} aria-pressed={n === i} aria-label={`Show image ${n + 1} of ${images.length}`} onClick={() => setI(n)}><img src={m.src} alt="" loading="lazy" /></button></li>)}
        </ul>
      )}
    </section>
  );
}
