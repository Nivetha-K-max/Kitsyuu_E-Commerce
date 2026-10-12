-- KITSYUU packaging materials (2026-10-12). Additive only; safe to re-run. No new stock table.
-- LOCAL ONLY so far: prepared and tested on throwaway local test databases. It must be reviewed and go through the
-- live-migration procedure (database/README.md) before any production use.
--
-- Packaging (courier bags, cartons, tissue, tags, stickers…) is stock of the same kind as fabric and trims: one quantity
-- per item, changed only through adjust_material_stock() and recorded row by row in material_movements, received on
-- purchase orders like any material. It therefore stays in the existing materials table and ledger; this migration only
-- lets an item be marked as packaging (so it has its own view) and records where it is usually bought and kept.
-- * materials.kind         'material' (everything that exists today) or 'packaging'.
-- * materials.vendor_id    the usual supplier (information for reordering; purchase orders still name their own vendor).
-- * materials.location_id  where the item is kept (information: material stock is one quantity per item, not per location).
-- The ledger's existing reason 'consume' records packaging used, as it records material used in production.

alter table public.materials add column if not exists kind text not null default 'material';
do $$ begin
  alter table public.materials add constraint materials_kind_check check (kind in ('material', 'packaging'));
exception when duplicate_object then null; end $$;
alter table public.materials add column if not exists vendor_id uuid references public.vendors (id) on delete set null;
alter table public.materials add column if not exists location_id uuid references public.locations (id) on delete set null;
create index if not exists materials_kind_idx on public.materials (kind, is_active);
