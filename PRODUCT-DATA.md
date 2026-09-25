# KITSYUU store: prototype product data

`dist/store/products.json` holds **22 prototype products**, one for each garment in `kitsyuu india catalogue.pdf` (pages 2–4). It exists so the store UI can be built and tested before official data arrives.

**Nothing in it is verified company data.** SKUs, names, categories, sizes, prices and descriptions come from the team's prototype catalogue (25 September 2026) and are estimates. Replace them before launch.

## Where each value came from

`meta.fieldStatus` in the JSON lists every field under one of four labels:

| Status | Meaning | Fields |
|---|---|---|
| prototypeCatalogue | The team's prototype catalogue | `sku`, `name`, `category`, `subcategory`, `variants` (sizes), `price`, `description`, `colour.label` |
| observed | Seen directly in the catalogue image | `catalogueRef`, `features`, `colour.swatches`, `styledWith`, `media.catalogueSource` |
| estimated | Placeholder chosen for the prototype | `slug` (made from the name), `availability`, `featured`, `tags` |
| pending | Unknown; left `null` or empty | `compareAtPrice`, `material`, `care`, `origin`, `media.primary`, `media.gallery` |

- **SKUs** (`KTS-TOP-###`, `KTS-BTM-###`, `KTS-OUT-###`) were created for development. They are one per product, not per size.
- **Sizes** are XS–XL, except the Faded Black Wide-Leg Jeans (`KTS-BTM-004`), which use waist sizes 28–36. Every size is marked available.
- **Prices** range from ₹2,199 to ₹3,799, in whole rupees. It isn't known whether they include GST (`meta.priceIncludesTax` is `null`).
- **Colour swatches** were sampled from the catalogue pixels and aren't official colourways.
- **`styledWith`** follows the catalogue's outfit layout. It doesn't mean items are sold as sets.
- **Featured picks** are four prototype selections (`KTS-BTM-002`, `KTS-OUT-002`, `KTS-OUT-001`, `KTS-BTM-008`). They're a placeholder for merchandising decisions. `KTS-OUT-002` replaced `KTS-TOP-006` on 25 September 2026 because that product's image is held.

## Categories and navigation

This is the prototype taxonomy. It isn't confirmed by the catalogue, and the moodboard titles were not used as categories.

```
New Arrivals              collection "new-arrivals" (prototype selection, 4 products)
Tops       ─ Shirts · Tops · Hoodies
Bottoms    ─ Trousers · Jeans · Shorts / Skirts
Outerwear  ─ Jackets
All Products
```

- `category` holds the top level (`tops`, `bottoms`, `outerwear`). `subcategory` holds the second level (`tops.shirts`, `bottoms.jeans`, and so on).
- `navigation` in the JSON defines the menu order, so the menu can change without code changes.
- **Subcategories were assigned by us:**
  - Joggers (`KTS-BTM-006`) go under Trousers.
  - Dark Denim Pleated Balloon Trousers (`KTS-BTM-010`) go under Jeans.
  - The Acid Wash Gothic Hooded Top (`KTS-TOP-004`) goes under Hoodies.
  - The Flame Print Washed Zip Hoodie (`KTS-TOP-006`) goes under Tops › Hoodies. It was listed under Outerwear in the prototype catalogue table and was moved on 25 September 2026.
- **New Arrivals** holds a prototype selection, in this order: `KTS-BTM-008`, `KTS-OUT-001`, `KTS-BTM-010` and `KTS-BTM-002`. `KTS-TOP-006` was removed on 25 September 2026 because its image is held. It's an estimate for UI development, **not officially confirmed new arrivals**. Replace the `id`s in `collections[0].productIds` once the company decides.

## Replacing with official data

1. Keep the file's structure. The store UI reads these keys.
2. For each product the company confirms:
   - Replace the prototype values.
   - If sizes carry their own SKUs, add `"sku"` to each entry in `variants`. Mark sizes that are out of stock with `"available": false`.
   - Fill in `material`, `care` and `origin`.
   - Set `"dataStatus": "official"`.
3. Delete products the company doesn't sell. Remove their IDs from other products' `styledWith` lists.
4. Add new products with a new `id`, and set `catalogueRef` to `null`.
5. Once no prototype products remain, set `meta.dataStatus` to `"official"` and update `meta.priceIncludesTax`.

`id` is the internal key used by the cart and wishlist. Keep it stable even if the SKU changes. `slug` is the product URL, so changing it breaks existing links.

## Images

Every product has a `media.status`:

| Status | Products | What the store shows |
|---|---|---|
| `prototype` | 22 | `media.primary`: a single catalogue cutout at prototype quality. **No zoom** (`zoom: false`). |
| `held` | none | The store shows a "Photo coming soon" panel. `primary` is `null`, and `holdReason` says why. |
| `official` | none yet | For company-supplied photography |

**Where the images come from**
- The images are in `dist/store/images/products/<id>.webp`, one per product, named by the stable `id`. Paths are relative to the site root.
- Each is a transparent cutout **extracted from the photos embedded in `kitsyuu india catalogue.pdf`**. None were cropped from the page PNGs, AI-generated or upscaled. The originals are unchanged.
- Each cutout is limited to the area the catalogue shows. Canva's clipping hides parts of some embedded photos: `obj25` contains a small selfie inset that the catalogue hides, and it's excluded. Loose specks from overlapping items are removed.
- `media.catalogueSource.pdfPhoto` records the embedded photo (`object`), its size, and the crop used, in the photo's own pixels. `region` is still the matching area on the page PNG.
- KTS-TOP-005, KTS-BTM-005, KTS-TOP-006 and KTS-TOP-010 were held until 25 September 2026, when the user asked for their catalogue photos to be used. They were extracted the same way as the others, from their recorded `pdfPhoto` crops. Their `review` flags still apply: third-party text or logos (P3-3, P3-4, P3-5), a person (P3-4, P3-5, P4-7), and a monogrammed handbag (P3-5).

**Known limits**
- Cutouts are 274–525 px wide. That's fine for grid cards, but soft on high-density screens and too small for zoom.
- Some cutouts keep parts of the original shot:
  - shoes or boots: KTS-BTM-001, -003, -004, -006, -007, -008, -009
  - a hanger and a second garment: KTS-TOP-004
  - the shoulder bag: KTS-TOP-002
  - a person's neck and hair: KTS-TOP-007
  - a sleeve and a hand: KTS-BTM-010
  - the boxy top's tie ends: KTS-BTM-009
- `media.aiRenders` lists AI-generated images (OpenAI C2PA metadata) that re-create the garment. They aren't photographs, aren't used, and need approval before any use.

**Replacing with real photography**
1. Add the files, for example `store/images/products/<id>-front.webp`.
2. Set `media.primary` to the main photo, with `quality: "production"`.
3. Put the extra views in `media.gallery`, using the same shape as `primary`.
4. Set `zoom: true` only for images at least 1500 px on the long edge.
5. Set `media.status` to `"official"`. For a held product, also remove `holdReason`.

The storefront should rely only on `status`, `primary`, `gallery` and `placeholder`. It must never read the paths in `catalogueSource` or `aiRenders`.

## Review flags (`review` in each product)

| Flag | Products | Detail |
|---|---|---|
| `imageRights: "unconfirmed"` | all 22 | The catalogue photos appear to be web-sourced. Written confirmation of rights is needed. |
| `thirdPartyMarks` | P3-1, P3-3, P3-4, P3-5, P3-6, P3-7, P3-8, P4-1, P4-2, P4-4, P4-5 | **P3-3:** printed "mccann brothers / new concept" and a neck label. **P3-4:** waistband text that appears to read "Calvin Klein". **P3-5/P3-6:** small embroidered logos, a cap logo, and a handbag with a monogram resembling Louis Vuitton's. **P3-8:** three-stripe side tape. **P3-1, P3-7:** printed lettering, illegible. **P4-1:** pocket label. **P4-2:** chest badge. **P4-4, P4-5:** neck labels. |
| `personVisible` | P3-4, P3-5, P3-6, P3-7, P3-8, P4-3, P4-7, P4-8 | Worn by a person. P3-5/P3-6 and P4-7/P4-8 are mirror selfies. Consent is needed. |
| `otherItemsInFrame` | P2-2, P2-3, P2-4, P2-6, P3-1, P3-2, P3-4, P3-5, P3-6, P3-7, P3-8, P4-3, P4-6, P4-7, P4-8 | Shoes, bags, hangers or neighbouring garments inside the crop region |

## Still needed from the company

- Which garments are real products
- Names, SKUs, prices and GST treatment
- Sizes, size chart and stock per size
- Official colours, materials, care and origin
- The company's own categories
- Product photography: front, back, detail and on-model
- Image rights, and how to handle other brands' marks
- Consent from people shown in the photos
- Approval for any AI imagery
