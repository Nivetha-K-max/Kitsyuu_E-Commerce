# @kitsyuu/admin

KITSYUU Admin/ERP: a separate Next.js app, deployed independently from the customer website and never served from it.

- Staff login, invitations, roles and permissions, audit log (M3).
- Dashboard, products, categories, sizes, images, New Arrivals, stock adjustments and orders (M4).
- ERP modules: customers, payments (exceptions and manual-refund records only; there are no returns or refunds: all sales are final), fulfilment, settings (M8); attributes; System page and sign-in history (M9). Reports come later.

Runs on http://localhost:3002 (`npm run dev:admin`). Configuration: `apps/admin/.env.example`. Tests: `npm run test:admin`.
