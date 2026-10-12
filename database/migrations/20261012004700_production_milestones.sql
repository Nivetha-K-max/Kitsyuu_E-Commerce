-- KITSYUU production calendar: milestones and tasks (2026-10-12). Additive only; safe to re-run.
-- LOCAL ONLY so far: prepared and tested on throwaway local test databases. It must be reviewed and go through the
-- live-migration procedure (database/README.md) before any production use.
--
-- The calendar shows dates that already exist (a production order's due date) and the dated entries of this one table.
-- * A milestone belongs to a production order: 'ready_for_trial' or 'ex_factory', at most ONE of each per order
--   (unique index below), so the same milestone can never appear twice.
-- * A task ('task', with a title) belongs to a production order OR to a customer order. A customer order can carry
--   tasks only: "Ready for Trial" and "Ex-Factory" are production milestones and the database refuses them on a
--   customer order. Nothing in this migration (and nothing in the application) creates a row by itself: every milestone
--   and task is added by a staff member. Stock orders therefore never receive one automatically.
-- * done_at / done_by record who marked it done and when. Rows are staff data, never shown to customers.

create table if not exists public.production_milestones (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid references public.production_orders (id) on delete cascade,
  order_id            uuid references public.orders (id) on delete cascade,
  kind                text not null check (kind in ('ready_for_trial', 'ex_factory', 'task')),
  title               text check (title is null or length(title) between 1 and 120),
  due_on              date not null,
  note                text check (note is null or length(note) <= 300),
  done_at             timestamptz,
  done_by             uuid references public.staff_users (id) on delete set null,
  created_by          uuid references public.staff_users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint production_milestones_one_parent check ((production_order_id is not null) <> (order_id is not null)),
  constraint production_milestones_named_on_production check (kind = 'task' or production_order_id is not null),
  constraint production_milestones_task_titled check ((kind = 'task') = (title is not null))
);
create unique index if not exists production_milestones_one_of_each on public.production_milestones (production_order_id, kind) where kind <> 'task';
create index if not exists production_milestones_due_idx on public.production_milestones (due_on);
create index if not exists production_milestones_order_idx on public.production_milestones (order_id) where order_id is not null;
drop trigger if exists production_milestones_updated_at on public.production_milestones;
create trigger production_milestones_updated_at before update on public.production_milestones for each row execute function public.set_updated_at();

alter table public.production_milestones enable row level security;
revoke all on public.production_milestones from anon, authenticated, kitsyuu_website;
grant select, insert, update, delete on public.production_milestones to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.production_milestones;
create policy "app admin: all rows" on public.production_milestones for all to kitsyuu_admin using (true) with check (true);
