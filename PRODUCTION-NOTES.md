# Current upscaled hero

The active source is the user-supplied upscalled.mp4, preserved unchanged. All 241 frames retain 2560 × 1440 source dimensions and are exported at WebP quality 100 (high-quality lossy, not lossless). No resizing or frame-rate conversion is applied. Canvas supports up to 2× device pixels and a 3840-pixel longest edge. The existing scroll timing, KITSYUU animation and supplied logo remain. The earlier 720p lossless export was superseded before publication.

# Frame quality correction

Active frames are lossless WebP extracted directly from the original 1280 × 720 transformation video, without frame-rate conversion. Frame 120 was compared with an independently decoded PNG: mean channel error below 1/255, reflecting decoder color conversion; the previous lossy export exceeded 1.5/255. Canvas resolution now supports up to 2× device pixels and a 3840-pixel longest edge, with high-quality image smoothing. Source resolution remains 720p; enlarging cannot add original detail. Lossless assets increase download size; bounded lazy loading remains enabled.

# KITSYUU identity update

The user corrected the name to KITSYUU. The supplied Kitsyuu Icon.pdf is retained unchanged, with its artwork extracted to a cropped SVG for navigation, footer and favicon. A central heavy DM Sans title scales, rotates and moves upward on native scroll, reversing with scroll direction. Reduced motion keeps it static.

# Production notes

## Direction

Dark Atelier Ã— Japanese Street, chosen by the user. Washed black and charcoal denim, amber practical lighting, concrete, raw seams, oversized proportions, and a vermilion accent. The layout pairs large Barlow Condensed headings with readable DM Sans body copy and monospaced secondary annotations. The generated KIETSU wordmark was selected for its angular, condensed letterforms and subtle distressing. Its original 1024 Ã— 1024 PNG is preserved; CSS crops its surrounding white margin and inverts it on the dark website without modifying the original.

## Current transformation edition

The active hero uses the full user-supplied transformation video, preserved as `source-assets/transformation.mp4`. A sculptural dark form unravels into streetwear. No new generation was used. 241 WebP frames at 1280 × 720 and 24 fps cover the 10.05-second source. The first frame supplies the poster.

The redesigned stage moves headlines to the lower edge, leaving the central transformation visible. Copy disappears through the unraveling beat and returns for the final outfit reveal. The scroll timeline includes opening and final holds across 480 viewport-height units. The palette follows the video's wine-red details, with a warm paper lookbook and dark street editorial. Mobile captions sit beneath the film. Bounded frame caching, reversible native scrolling, filters and reduced motion remain supported. Audio is not played.

Previous hero videos remain as historical source assets, not the active sequence.

## Provenance

All newly generated images and video used ImagineArt MCP in the user's selected organization. No Higgsfield, alternate image provider, or browser generation was used.

- Hero still: `a1f768cf-41cc-4bf7-8240-7b51e361f3ab`.
- Alley editorial: `c582616f-0a6d-4689-8fad-6adeb82fa139`.
- Logo: `c1aa74ad-76fc-49aa-bd87-8bf4f24710d3`.
- Initial video: `01a08fce-e3c3-7c40-9bf3-6a598b0eb87c`, LTX 2.3, 10.28 seconds, 1920 Ã— 1080. No longer used as the hero.
- Corrective video: `01a08fdb-5e15-7a52-8a17-5a6ef3616ac3`, same format, not used in the website.

Exact still prompts and service metadata are in `source-assets/manifest.json`; exact video prompts and selection rationale are in `source-assets/video-prompts.json`. The default image model and its default square output were used. The video tool produced the supported default landscape composition.

The Volume and Layers studies use CSS crops of the user's supplied moodboards (filenames ending `02_34_23 PM.png` and `02_36_40 PM.png`). They illustrate an aesthetic, not verified Kietsu stock. Selected source moodboards are preserved unchanged. Fonts are locally downloaded Google Fonts assets: Barlow Condensed and DM Sans.

## Verification and limits

Static asset references, internal links, JavaScript syntax, all sequence files and dimensions, frame numbering, adjoining timeline boundaries, posters, and editable media references were checked. See `validation.json` for measured output.

Browser checks cover desktop and mobile layout, ordinary forward and reverse scrolling, the copy-free middle beat, the final hold, the skip action, style filtering, and the motion toggle with its persisted static fallback. No checkout or message-sending flow exists because no real destination or commerce details were supplied. System/network fallback branches were reviewed in code; browser tests exercise the same static view using the visible motion control. This is not a device-lab performance benchmark.
