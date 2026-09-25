-- KITSYUU platform M2: staff accounts, roles and permissions (additive only).
-- Staff are a separate account type from customers: nothing on the public website can create a staff user.
-- Authorization is by permission code (e.g. 'inventory.adjust'). Roles and their permissions are rows, not code.
-- The staff login flow itself is built in M3; this migration only creates the tables and seeds roles/permissions.
-- Safe to re-run: every statement is guarded (if not exists / on conflict do nothing).

-- ---------- types ----------
do $$ begin
  create type public.staff_status as enum ('invited', 'active', 'disabled');
exception when duplicate_object then null; end $$;

-- ---------- staff users ----------
create table if not exists public.staff_users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null check (email = lower(btrim(email)) and email like '%_@_%'),   -- stored normalised
  full_name           text not null default '',
  password_hash       text,                                   -- argon2id; null until the invitation is accepted
  status              public.staff_status not null default 'invited',
  email_verified_at   timestamptz,
  password_changed_at timestamptz,
  last_login_at       timestamptz,
  invited_by          uuid references public.staff_users (id) on delete set null,
  disabled_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint staff_users_active_has_password check (status <> 'active' or password_hash is not null)
);
create unique index if not exists staff_users_email_key on public.staff_users (email);
drop trigger if exists staff_users_updated_at on public.staff_users;
create trigger staff_users_updated_at before update on public.staff_users for each row execute function public.set_updated_at();

-- ---------- roles and permissions ----------
create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  name        text not null,
  description text not null default '',
  is_system   boolean not null default false,               -- seeded roles; the admin app must not delete them
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists roles_updated_at on public.roles;
create trigger roles_updated_at before update on public.roles for each row execute function public.set_updated_at();

-- A permission code names one capability the code checks with can(staff, '<code>'). New codes arrive with the
-- migration that ships the feature using them (and are granted to super_admin in that same migration).
create table if not exists public.permissions (
  code        text primary key check (code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  module      text not null,
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id         uuid not null references public.roles (id) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  granted_at      timestamptz not null default now(),
  primary key (role_id, permission_code)
);
create index if not exists role_permissions_permission_idx on public.role_permissions (permission_code);

create table if not exists public.staff_user_roles (
  staff_user_id uuid not null references public.staff_users (id) on delete cascade,
  role_id       uuid not null references public.roles (id) on delete restrict,   -- a role in use cannot be deleted
  granted_by    uuid references public.staff_users (id) on delete set null,
  granted_at    timestamptz not null default now(),
  primary key (staff_user_id, role_id)
);
create index if not exists staff_user_roles_role_idx on public.staff_user_roles (role_id);

-- ---------- staff sessions ----------
-- Only a SHA-256 hash of the session token is stored, so a copy of this table gives no working sessions.
create table if not exists public.staff_sessions (
  id              uuid primary key default gen_random_uuid(),
  staff_user_id   uuid not null references public.staff_users (id) on delete cascade,
  token_hash      bytea not null unique check (octet_length(token_hash) = 32),
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  ip              inet,
  user_agent      text
);
create index if not exists staff_sessions_user_idx on public.staff_sessions (staff_user_id);
create index if not exists staff_sessions_expires_idx on public.staff_sessions (expires_at);

-- ---------- lock down: RLS on, nothing for the public API roles ----------
-- (Supabase's default privileges grant anon/authenticated everything on new tables; revoke that explicitly.)
alter table public.staff_users      enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.staff_user_roles enable row level security;
alter table public.staff_sessions   enable row level security;
revoke all on public.staff_users, public.roles, public.permissions, public.role_permissions, public.staff_user_roles, public.staff_sessions
  from anon, authenticated;

-- ---------- seed: permissions ----------
insert into public.permissions (code, module, description) values
  ('dashboard.read',       'dashboard',  'View the admin dashboard'),
  ('staff.read',           'staff',      'View staff accounts'),
  ('staff.manage',         'staff',      'Invite, edit, disable staff and assign roles'),
  ('roles.read',           'roles',      'View roles and their permissions'),
  ('roles.manage',         'roles',      'Create and edit roles and their permissions'),
  ('audit.read',           'audit',      'View the audit log'),
  ('settings.read',        'settings',   'View platform settings'),
  ('settings.manage',      'settings',   'Change platform settings'),
  ('products.read',        'products',   'View products, variants and images'),
  ('products.write',       'products',   'Create and edit products, variants, SKUs, prices and images'),
  ('categories.read',      'categories', 'View categories and collections'),
  ('categories.write',     'categories', 'Create and edit categories and collections'),
  ('inventory.read',       'inventory',  'View stock levels and stock movements'),
  ('inventory.adjust',     'inventory',  'Adjust stock (recorded in the inventory ledger)'),
  ('orders.read',          'orders',     'View orders'),
  ('orders.update_status', 'orders',     'Change order status'),
  ('customers.read',       'customers',  'View customers and their order history'),
  ('customers.manage',     'customers',  'Edit or disable customer accounts'),
  ('billing.read',         'billing',    'View invoices, payments and refunds'),
  ('billing.manage',       'billing',    'Issue invoices and record payments'),
  ('refunds.create',       'billing',    'Create refunds'),
  ('reports.read',         'reports',    'View reports')
on conflict (code) do nothing;

-- ---------- seed: roles ----------
insert into public.roles (code, name, description, is_system) values
  ('super_admin',       'Super admin',       'Full access, including roles and permissions', true),
  ('admin',             'Admin',             'Runs the store and manages staff; cannot change role definitions', true),
  ('manager',           'Manager',           'Day-to-day operations: catalogue, stock, orders', true),
  ('inventory_manager', 'Inventory manager', 'Stock levels and adjustments', true),
  ('sales',             'Sales',             'Orders and customers', true),
  ('accountant',        'Accountant',        'Billing, payments, refunds and reports', true),
  ('support',           'Support',           'Read-only help for customers and orders', true)
on conflict (code) do nothing;

-- ---------- seed: role → permissions ----------
-- super_admin holds every permission (future permission migrations grant new codes to it the same way).
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join public.permissions p where r.code = 'super_admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join public.permissions p
where r.code = 'admin' and p.code <> 'roles.manage'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r
join (values
  ('manager', 'dashboard.read'), ('manager', 'staff.read'), ('manager', 'roles.read'), ('manager', 'audit.read'), ('manager', 'settings.read'),
  ('manager', 'products.read'), ('manager', 'products.write'), ('manager', 'categories.read'), ('manager', 'categories.write'),
  ('manager', 'inventory.read'), ('manager', 'inventory.adjust'), ('manager', 'orders.read'), ('manager', 'orders.update_status'),
  ('manager', 'customers.read'), ('manager', 'billing.read'), ('manager', 'reports.read'),
  ('inventory_manager', 'dashboard.read'), ('inventory_manager', 'products.read'), ('inventory_manager', 'categories.read'),
  ('inventory_manager', 'inventory.read'), ('inventory_manager', 'inventory.adjust'), ('inventory_manager', 'reports.read'),
  ('sales', 'dashboard.read'), ('sales', 'products.read'), ('sales', 'inventory.read'), ('sales', 'orders.read'),
  ('sales', 'orders.update_status'), ('sales', 'customers.read'),
  ('accountant', 'dashboard.read'), ('accountant', 'orders.read'), ('accountant', 'customers.read'), ('accountant', 'billing.read'),
  ('accountant', 'billing.manage'), ('accountant', 'refunds.create'), ('accountant', 'reports.read'),
  ('support', 'dashboard.read'), ('support', 'products.read'), ('support', 'inventory.read'), ('support', 'orders.read'),
  ('support', 'customers.read')
) as x (role_code, code) on x.role_code = r.code
on conflict do nothing;
