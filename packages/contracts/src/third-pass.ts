// ======================= client change request, third pass =======================
// Locations, stock transfers, stock per location, colour variants. Shape only; permissions and every business check
// are in @kitsyuu/core (locations.ts, colour-variants.ts).
import { z } from 'zod';

const uuid = z.uuid();
const optText = (max: number) => z.string().trim().max(max).optional().transform(v => v || null);
const slugOrNone = z.string().trim().max(40).optional().transform(v => v || null)
  .pipe(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Choose a colour from the list.').nullable());

export const locationInput = z.object({
  locationId: uuid.optional().or(z.literal('').transform(() => undefined)),
  code: z.string().trim().min(2, 'Give a short code, e.g. RB-1.').max(20),
  name: z.string().trim().min(2, 'Name the location.').max(80),
  kind: z.enum(['warehouse', 'retail', 'other'], { message: 'Choose the kind of location.' }),
  address: optText(300),
  active: z.enum(['on']).optional().transform(v => v === 'on'),
});

export const locationAdjustInput = z.object({
  locationId: uuid,
  variantId: uuid,
  delta: z.string().trim().regex(/^[+-]?\d{1,6}$/, 'Enter a whole number, e.g. 5 or -2.').transform(Number)
    .refine(n => n !== 0, 'Enter a whole number other than 0.'),
  reason: z.string().trim().min(1, 'Choose a reason.').max(40),
  note: optText(300),
  expectedQty: z.coerce.number().int().min(0),
});

export const transferIdInput = z.object({ transferId: uuid });
export const transferCancelInput = z.object({ transferId: uuid, note: z.string().trim().min(1, 'Give a reason; it is kept in the history.').max(300) });

/** The new-transfer form: one quantity field per size, named qty:<variantId>; empty fields are skipped. */
export const transferCreateInput = z.object({
  fromLocationId: uuid,
  toLocationId: uuid,
  note: optText(300),
});

export const colourVariantInput = z.object({ productId: uuid, size: z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, 'Use 1–8 letters or digits, e.g. XS, M, 32, FREE.').transform(v => v.toUpperCase()), colour: slugOrNone });
export const variantColourInput = z.object({ variantId: uuid, colour: slugOrNone });
export const imageColourInput = z.object({ imageId: uuid, colour: slugOrNone });

const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined));
export const locationReportQuery = z.object({ from: day, to: day });
