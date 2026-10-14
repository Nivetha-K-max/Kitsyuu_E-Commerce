-- Shipping address permission (2026-10-14, LOCAL ONLY until reviewed and approved for production).
-- New permission shipping.addresses: see the customer's name, contact and delivery address on shipments (the Shipping
-- queue and the shipment page). Until now shipping.read alone showed them. Enforced in packages/core (shipping-admin.ts).
--
-- Who gets it here (no one gains or loses anything with this file):
--   * super_admin, admin: every permission (admin = all but roles.manage, checked by db:verify-platform).
--   * manager, sales, support: they handle deliveries and delivery questions, and already see the same addresses on the
--     order itself (orders.read).
--   * inventory_manager: PROVISIONAL. Kept so its access stays exactly as it is until the role matrix is reviewed
--     (docs/reviews/2026-10-14/review-1-inventory-address-access.md). Taking it away later is one row:
--       delete from public.role_permissions using public.roles r
--        where role_permissions.role_id = r.id and r.code = 'inventory_manager' and role_permissions.permission_code = 'shipping.addresses';
-- Additive, no existing row changed. Safe to run twice.
-- Roll back: delete from public.role_permissions where permission_code = 'shipping.addresses';
--            delete from public.permissions where code = 'shipping.addresses';
--            (staff without it then see no addresses on shipments until the code is rolled back too).

insert into public.permissions (code, module, description) values
  ('shipping.addresses', 'shipping', 'See the customer''s name, contact and delivery address on shipments')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'shipping.addresses'), ('admin', 'shipping.addresses'),
  ('manager', 'shipping.addresses'), ('sales', 'shipping.addresses'), ('support', 'shipping.addresses'),
  ('inventory_manager', 'shipping.addresses')   -- provisional: see the header
) x(role, code) on r.code = x.role
on conflict do nothing;
