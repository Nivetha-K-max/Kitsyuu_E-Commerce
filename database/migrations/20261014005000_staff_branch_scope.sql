-- Staff branch scope (2026-10-14, LOCAL ONLY until reviewed and approved for production):
--   which locations (branches, warehouses, the online location) a staff member may work at.
-- Rules (enforced in packages/core, not here): a staff member with NO rows is unrestricted (every location), so every
-- existing login keeps working when this ships; a staff member WITH rows is limited to those locations; anyone holding
-- staff.manage (held by the super_admin and admin roles) is always unrestricted whatever rows they have.
-- Additive: one new table, no existing row changed, no new permission (assignments are made under staff.manage).
-- Safe to run twice.
-- Roll back: drop table staff_locations (only the assignments are lost; every staff member becomes unrestricted again).

create table if not exists public.staff_locations (
  staff_user_id uuid not null references public.staff_users (id) on delete cascade,
  location_id   uuid not null references public.locations (id) on delete restrict,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.staff_users (id) on delete set null,
  primary key (staff_user_id, location_id)
);
create index if not exists staff_locations_location on public.staff_locations (location_id);

-- ---------------------------------------------------------------- access: staff app only, like the other staff tables
alter table public.staff_locations enable row level security;
revoke all on public.staff_locations from anon, authenticated, kitsyuu_website;
drop policy if exists "app admin: all rows" on public.staff_locations;
create policy "app admin: all rows" on public.staff_locations for all to kitsyuu_admin using (true) with check (true);
grant select, insert, delete on public.staff_locations to kitsyuu_admin;   -- an assignment is added or removed, never edited
