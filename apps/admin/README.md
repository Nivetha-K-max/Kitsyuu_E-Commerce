# @kitsyuu/admin

KITSYUU Admin/ERP: a separate Next.js app, deployed independently from the customer website and never served from it.

- Staff login, invitations, roles and permissions, audit log (M3).
- Dashboard, products, categories, sizes, images, New Arrivals, stock adjustments and orders (M4).
- ERP modules (customers, payments, fulfilment, returns/refunds, reports, settings) arrive in M8.

Runs on http://localhost:3002 (`npm run dev:admin`). Configuration: `apps/admin/.env.example`. Tests: `npm run test:admin`.
