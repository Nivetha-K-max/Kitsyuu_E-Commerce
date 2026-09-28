/* M3 end-to-end checks for the Admin/ERP app in headless Chrome, against a LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs, which provides BASE (the admin server), SERVER_LOG (its stdout, where the console
   mailer writes emails) and INVITE_FILE (the bootstrap link written by database/scripts/create-staff.mjs). */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';

const {BASE, SERVER_LOG, INVITE_FILE, KITSYUU_DB_URL} = process.env;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'e2e passphrase for the admin';
const q = async sql => { const c = new pg.Client({connectionString: KITSYUU_DB_URL}); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } };

const b = await launch(9371);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr).catch(() => false)) return true; await w(100); } return false; };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
// Submit buttons are looked up inside the page content (main), never the sidebar's sign-out form.
// submit() waits for THIS submission to start (form aria-busy, or navigation) and then finish, so later checks never
// read text left over from an earlier attempt.
const submit = async (formSel = 'main form') => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  // Wait until React has hydrated the form (its handlers are attached); a click before that is a plain browser submission.
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  // A MutationObserver set up before the click records that the form went busy, however briefly: a fast (or late) answer
  // is never mistaken for "nothing happened yet".
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});
    window.__busySeen=false;if(f)new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const formMessage = () => ev(`document.querySelector('main [data-form-message]')?.innerText ?? ''`);
const fieldError = name => ev(`document.querySelector('main input[name=${name}]')?.closest('.field')?.querySelector('.field-error')?.innerText ?? ''`);
const path_ = () => ev('location.pathname + location.search');
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const mails = () => fs.readFileSync(SERVER_LOG, 'utf8').match(/token=[A-Za-z0-9_-]{43}/g) ?? [];
const lastMailLink = async prevCount => { for (let i = 0; i < 50; i++) { const m = mails(); if (m.length > prevCount) return m.at(-1).slice(6); await w(100); } return null; };
const cookie = async () => (await b.send('Network.getAllCookies')).cookies.find(c => c.name === '__Host-kitsyuu_admin');
const signOutBrowser = () => b.send('Network.clearBrowserCookies');
const allErrors = [];
const visit = async (p, ready = 'document.readyState==="complete"') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };

try {
  await b.viewport(1440, 900);
  await signOutBrowser();

  // ---------- signed out ----------
  await visit('/staff');
  ok('signed-out visitor is sent to sign-in (with next)', (await path_()) === '/login?next=%2Fstaff');
  const h = await fetch(BASE + '/login');
  ok('admin is never indexed (X-Robots-Tag noindex)', /noindex/.test(h.headers.get('x-robots-tag') ?? ''));
  ok('admin cannot be framed (CSP frame-ancestors none + X-Frame-Options DENY)', /frame-ancestors 'none'/.test(h.headers.get('content-security-policy') ?? '') && h.headers.get('x-frame-options') === 'DENY');
  ok('no referrer leaks one-time links', h.headers.get('referrer-policy') === 'no-referrer');
  ok('robots meta noindex on pages', /<meta name="robots" content="noindex, nofollow/.test(await h.text()));
  const noCookie = await fetch(BASE + '/dashboard', {redirect: 'manual'});
  ok('server refuses /dashboard without a session (redirect)', noCookie.status >= 300 && noCookie.status < 400);
  const fake = await fetch(BASE + '/dashboard', {redirect: 'manual', headers: {cookie: '__Host-kitsyuu_admin=' + 'A'.repeat(43)}});
  ok('a forged session cookie is rejected by the server (not just the proxy)', fake.status >= 300 && fake.status < 400 && /\/login/.test(fake.headers.get('location') ?? ''));

  // ---------- bootstrap super admin (link from the create-staff script's file) ----------
  const link = fs.readFileSync(INVITE_FILE, 'utf8').match(/https?:\/\/\S+accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit(link.replace(/^https?:\/\/[^/]+/, ''));
  await fill('input[name=fullName]', 'E2E Root'); await fill('input[name=password]', 'short'); await fill('input[name=confirm]', 'short'); await submit();
  ok('weak password rejected with a field error', /at least 12/i.test(await fieldError('password')), await fieldError('password'));
  ok('what the person typed is kept after a validation error (name not wiped)', (await ev(`document.querySelector('input[name=fullName]').value`)) === 'E2E Root');
  // Only the passwords are re-typed: the kept name must be submitted as-is.
  await fill('input[name=password]', PW); await fill('input[name=confirm]', PW); await submit();
  ok('accepting the invitation signs in and opens the dashboard', await until(`location.pathname==='/dashboard'`));
  const c = await cookie();
  // Chrome only stores a __Host- cookie if it is Secure, Path=/ and has no Domain attribute; the flags are also checked explicitly.
  ok('session cookie: __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/, host-only', !!c && c.httpOnly && c.secure && c.sameSite === 'Lax' && c.path === '/' && c.domain === new URL(BASE).hostname && !c.session,
    JSON.stringify(c && {httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, path: c.path, domain: c.domain, persistent: !c.session}));
  ok('session token is not readable by page scripts', !(await ev('document.cookie')).includes('kitsyuu_admin'));
  await visit(link.replace(/^https?:\/\/[^/]+/, ''));
  await fill('input[name=fullName]', 'Again'); await fill('input[name=password]', PW); await fill('input[name=confirm]', PW); await submit();
  ok('the invitation link cannot be used twice', /invalid, already used, or expired/.test(await formMessage()) && (await path_()).startsWith('/accept-invite'), await formMessage());

  // ---------- dashboard: live figures ----------
  await visit('/dashboard', '!!document.querySelector("[data-kpis]")');
  const kpi = async label => (await text(`[data-kpi="${label}"] dd`)).replace(/\s+/g, ' ');
  const [dbCounts] = await q(`select (select count(*)::int from products) p, (select count(*)::int from product_variants v join products x on x.id=v.product_id where v.is_active and x.status='active') v,
    (select coalesce(sum(stock_qty),0)::int from product_variants) u, (select count(*)::int from orders) o, (select count(*)::int from customers) c`);
  ok('dashboard products = database', (await kpi('Products')).startsWith(String(dbCounts.p)), await kpi('Products'));
  ok('dashboard sellable SKUs and units = database', (await kpi('Sellable SKUs')).startsWith(String(dbCounts.v)) && (await kpi('Sellable SKUs')).includes('1,100 units'), await kpi('Sellable SKUs'));
  ok('dashboard orders and revenue are real zeros (no fake numbers)', (await kpi('Orders')).startsWith(String(dbCounts.o)) && (await kpi('Revenue (paid orders)')).startsWith('₹0'), `${await kpi('Orders')} | ${await kpi('Revenue (paid orders)')}`);
  ok('dashboard customers = database', (await kpi('Customers')).startsWith(String(dbCounts.c)));
  ok('dashboard shows no inventory alerts (none in the data)', !!(await ev('!!document.querySelector("[data-empty=low-stock]")')));
  const nav = await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`);
  ok('super admin sees every section', nav === 'Dashboard|Products|Categories|Collections|Attributes|Inventory|Orders|Customers|Payments|Reviews|Vendors|Materials|Purchase orders|Production|Staff|Roles|Audit|Settings|System', nav);

  // ---------- M9: System page, sign-in history, health check ----------
  await visit('/system', '!!document.querySelector("[data-system-db]")');
  ok('M9 System page: database up, configuration shown as modes only', /Up/.test(await text('[data-system-db]'))
    && !/postgres(ql)?:\/\//i.test(await text('main')), await text('[data-system-db]'));
  await visit('/audit/sign-ins', '!!document.querySelector("main")');
  ok('M9 sign-in history page opens (filters + list or empty state)', await ev(`!!document.querySelector('[data-signin-filters]') && !!document.querySelector('[data-signins-table],[data-empty]')`));
  const health = await ev(`fetch('/api/health').then(async r=>({s:r.status,j:await r.json()}))`);
  // ---------- M11: collections, bulk status, product merchandising sections ----------
  await visit('/collections', '!!document.querySelector("[data-collections-table]")');
  ok('M11 collections: New Arrivals listed and in the store', /New Arrivals/.test(await text('[data-collections-table]')) && /in store/i.test(await text('[data-collection="new-arrivals"]')));
  await fill('#create-collection-form input[name=label]', 'E2E Edit'); await fill('#create-collection-form input[name=id]', 'e2e-edit');
  await submit('#create-collection-form');
  await until(`location.pathname === '/collections/e2e-edit'`, 15000);
  ok('M11 collections: a new collection opens hidden', /Hidden/.test(await text('[data-collection-status]')), await text('[data-collection-status]'));
  await visit('/products', '!!document.querySelector("[data-products-table]")');
  ok('M11 products: bulk status form and one checkbox per product', (await exists('#bulk-status-form')) && (await ev(`document.querySelectorAll('input[name="productIds[]"]').length`)) === (await ev(`document.querySelectorAll('[data-product-row]').length`)));
  await visit(`/products/${(await q(`select id from products order by id limit 1`))[0].id}`, '!!document.querySelector("[data-section=related]")');
  ok('M11 product page: Complete the look and SEO fields', (await exists('[data-section=related]')) && (await exists('input[name=seoTitle]')) && (await exists('textarea[name=seoDescription]')));
  // ---------- M12: review moderation queue ----------
  await visit('/reviews', '!!document.querySelector("[data-review-tabs]")');
  ok('M12 reviews: moderation queue opens with its tabs (empty)', (await exists('[data-review-tabs]')) && (await exists('[data-empty=reviews]')));
  // ---------- M13: vendor → material → purchase order → delivery ----------
  await visit('/vendors', '!!document.querySelector("#create-vendor-form")');
  await fill('#create-vendor-form input[name=name]', 'E2E Mills'); await submit('#create-vendor-form');
  await visit('/materials', '!!document.querySelector("#create-material-form")');
  await fill('#create-material-form input[name=code]', 'E2E-TWILL'); await fill('#create-material-form input[name=name]', 'Twill');
  await fill('#create-material-form input[name=unit]', 'm'); await submit('#create-material-form');
  ok('M13 vendor and material created', /E2E-TWILL/.test(await text('[data-materials-table]')));
  await visit('/purchase-orders', '!!document.querySelector("#create-po-form")');
  await submit('#create-po-form');
  await until(`/^/purchase-orders/[0-9a-f-]{36}$/.test(location.pathname)`, 15000);
  await fill('#po-line-form input[name=qty]', '25'); await submit('#po-line-form');
  await visit(await ev('location.pathname'), '!!document.querySelector("#po-place-form")');
  await ev(`window.confirm = () => true`);
  await submit('#po-place-form');
  await visit(await ev('location.pathname'), '!!document.querySelector("#receive-form")');
  await ev(`(()=>{const i=document.querySelector('#receive-form input[name^="received:"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'25');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await submit('#receive-form');
  // Once fully received the delivery form is no longer offered, so the result is checked in the database and on the page.
  await until(`!document.querySelector('#receive-form')`, 10000);
  ok('M13 order placed and fully received; stock follows', (await q(`select status from purchase_orders order by created_at desc limit 1`))[0].status === 'received'
    && (await q(`select stock_qty::int n from materials where code = 'E2E-TWILL'`))[0].n === 25);
  // ---------- M14: plan and start a production order ----------
  await visit('/production', '!!document.querySelector("#create-production-form")');
  await fill('#create-production-form input[name=qty]', '3'); await submit('#create-production-form');
  await until(`/^/production/[0-9a-f-]{36}$/.test(location.pathname)`, 15000);
  await submit('#production-start-form');
  await visit(await ev('location.pathname'), '!!document.querySelector("#qc-form")');
  ok('M14 production order planned and started; the quality check form is offered', (await exists('#qc-form')) && /in progress/i.test(await text('main')));
  ok('M9 /api/health: 200 with up/down only', health.s === 200 && JSON.stringify(Object.keys(health.j).sort()) === '["app","database","latencyMs","ok"]', JSON.stringify(health));

  // ---------- invite a support user through the UI ----------
  await visit('/staff/invite', '!!document.querySelector("input[name=email]")');
  let before = mails().length;
  await fill('input[name=email]', 'support.e2e@test.local'); await fill('input[name=fullName]', 'Support E2E');
  await ev(`document.querySelector('[data-role=support] input').click(),true`);
  await submit();
  ok('invite via UI → staff page with notice', await until(`location.pathname.startsWith('/staff/') && !!document.querySelector('[data-notice=invited]')`));
  const supportLink = await lastMailLink(before);
  ok('invitation email written by the console mailer (server log only)', !!supportLink);
  ok('invited staff appears as Invited', /invited/i.test(await text('.page-head .badge')), await text('.page-head .badge'));
  const rolesLocked = await (async () => { await visit('/staff/invite', '!!document.querySelector("[data-role]")'); return ev(`[...document.querySelectorAll('[data-locked=true]')].length`); })();
  ok('super admin has no locked roles', rolesLocked === 0);

  // ---------- support user: least privilege ----------
  await signOutBrowser();
  await visit(`/accept-invite?token=${supportLink}`);
  await fill('input[name=fullName]', 'Support E2E'); await fill('input[name=password]', PW); await fill('input[name=confirm]', PW); await submit();
  ok('support user signs in', await until(`location.pathname==='/dashboard'`));
  const supNav = await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`);
  // support holds dashboard.read, orders.read, products.read and inventory.read (seeded roles), nothing for staff/roles/audit.
  ok('support sees only what its role permits in the menu', supNav === 'Dashboard|Products|Inventory|Orders|Customers|Reviews', supNav);
  for (const p of ['/staff', '/staff/invite', '/roles', '/roles/new', '/audit']) {
    await visit(p, '!!document.querySelector("main")');
    ok(`support gets "not permitted" on ${p} (server-side)`, !!(await ev('!!document.querySelector("[data-gate=forbidden]")')) && !(await ev('!!document.querySelector("table,[data-perm-matrix],input[name=email]")')));
  }
  await visit('/dashboard', '!!document.querySelector("[data-kpis]")');
  await until('!!document.querySelector("[data-kpis]") && !document.querySelector("[data-loading]")', 15000);   // a slow render must not read as a failure
  ok('support without audit.read sees no activity feed', /Needs the audit\.read permission/.test(await text('main')));

  // ---------- sign out / sign in ----------
  await ev(`document.querySelector('[data-logout]').click(),true`);
  ok('sign out → sign-in page with notice', await until(`location.pathname==='/login' && !!document.querySelector('[data-notice=signed_out]')`));
  await visit('/dashboard');
  ok('after sign-out the dashboard needs a new sign-in', (await path_()).startsWith('/login'));
  await fill('input[name=email]', 'root.e2e@test.local'); await fill('input[name=password]', 'wrong wrong wrong'); await submit();
  ok('wrong password: generic message', (await formMessage()) === 'Email or password is incorrect.', await formMessage());
  const wrongPwMessage = await formMessage();
  await fill('input[name=email]', 'nobody@test.local'); await fill('input[name=password]', PW); await submit();
  ok('unknown email: exactly the same message (no account enumeration)', (await formMessage()) === wrongPwMessage && (await path_()).startsWith('/login'), await formMessage());
  await fill('input[name=email]', 'ROOT.E2E@test.local'); await fill('input[name=password]', PW); await submit();
  ok('super admin signs in (email is case-insensitive)', await until(`location.pathname==='/dashboard'`));

  // ---------- roles ----------
  await visit('/roles', '!!document.querySelector("[data-roles-table]")');
  const roleRows = await ev(`[...document.querySelectorAll('[data-role-row]')].map(r=>r.dataset.roleRow).sort().join(',')`);
  ok('roles page lists the 7 built-in roles', roleRows === 'accountant,admin,inventory_manager,manager,sales,super_admin,support', roleRows);
  await visit('/roles/new', '!!document.querySelector("input[name=code]")');
  await fill('input[name=name]', 'E2E temp'); await fill('input[name=code]', 'e2e_temp'); await submit();
  ok('create role → role page', await until(`location.pathname.startsWith('/roles/') && !!document.querySelector('[data-perm-matrix]')`));
  await ev(`document.querySelector('[data-perm="reports.read"] input').click(),true`);
  await submit('main form.grid');
  ok('role permissions saved', (await formMessage()) === 'Role saved.', await formMessage());
  const [tr] = await q(`select array_agg(rp.permission_code) p from roles r join role_permissions rp on rp.role_id=r.id where r.code='e2e_temp'`);
  ok('database holds exactly the chosen permission', JSON.stringify(tr.p) === '["reports.read"]', JSON.stringify(tr.p));
  await ev('window.confirm=()=>true');
  await submit('main section.card form');   // the Delete role form
  ok('delete role → back to roles', await until(`location.pathname==='/roles' && !document.querySelector('[data-role-row=e2e_temp]')`));

  // ---------- disable the support user ----------
  const [sup] = await q(`select id from staff_users where email='support.e2e@test.local'`);
  await visit(`/staff/${sup.id}`, '!!document.querySelector("#status")');
  await ev('window.confirm=()=>true');
  await submit('#status');
  ok('disable account', /Account disabled/.test(await ev(`document.querySelector('#status [data-form-message]')?.innerText ?? ''`)));
  const [live] = await q(`select count(*)::int n from staff_sessions where staff_user_id='${sup.id}' and revoked_at is null`);
  ok('disabling ended every session of that person', live.n === 0);

  // ---------- change own email is audited; roles form present ----------
  ok('staff detail offers roles and details forms', !!(await ev('!!document.querySelector("[data-section=roles] input[name=roleIds]") && !!document.querySelector("[data-section=details] input[name=email]")')));

  // ---------- forgot / reset password ----------
  await signOutBrowser();
  await visit('/forgot-password', '!!document.querySelector("input[name=email]")');
  before = mails().length;
  await fill('input[name=email]', 'root.e2e@test.local'); await submit();
  ok('reset request: generic confirmation', /If an active staff account uses that email/.test(await formMessage()), await formMessage());
  const resetToken = await lastMailLink(before);
  ok('reset email written to the server log', !!resetToken);
  await visit(`/reset-password?token=${resetToken}`, '!!document.querySelector("input[name=password]")');
  await fill('input[name=password]', PW + ' v2'); await fill('input[name=confirm]', PW + ' v2'); await submit();
  ok('reset → sign-in page with notice', await until(`!!document.querySelector('[data-notice=reset]')`));
  await fill('input[name=email]', 'root.e2e@test.local'); await fill('input[name=password]', PW + ' v2'); await submit();
  ok('sign in with the new password', await until(`location.pathname==='/dashboard'`));

  // ---------- audit ----------
  await visit('/audit', '!!document.querySelector("[data-audit-table]")');
  const actions = new Set(await ev(`[...document.querySelectorAll('[data-audit-action]')].map(r=>r.dataset.auditAction)`));
  const need = ['staff.invite', 'staff.invite_accept', 'auth.login', 'auth.logout', 'role.create', 'role.update', 'role.delete', 'staff.disable', 'auth.password_reset_request', 'auth.password_reset'];
  ok('audit log shows every action from this run', need.every(a => actions.has(a)), need.filter(a => !actions.has(a)).join(',') || 'all present');
  await visit('/audit?action=role.update', '!!document.querySelector("[data-audit-table],[data-empty=audit]")');
  ok('audit filter by action', (await ev(`[...document.querySelectorAll('[data-audit-action]')].every(r=>r.dataset.auditAction==='role.update')`)) && (await ev(`document.querySelectorAll('[data-audit-action]').length`)) >= 1);
  const [a] = await q(`select count(*)::int n from audit_logs where action='role.update' and before_data is not null and after_data is not null`);
  ok('role update recorded before and after', a.n >= 1);

  // ---------- phone width ----------
  await b.viewport(390, 844, true);
  for (const p of ['/dashboard', '/staff', '/roles', '/audit']) {
    await visit(p, '!!document.querySelector("main")');
    ok(`no horizontal page scroll at 390px: ${p}`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  await b.shot('m3-admin-mobile.png');
  await b.viewport(1440, 900);
  await visit('/dashboard', '!!document.querySelector("[data-kpis]")');
  await b.shot('m3-admin-dashboard.png');

  // ---------- secrets never reach the browser ----------
  const staticDir = path.join(HERE, '..', '.next', 'static');
  const files = fs.readdirSync(staticDir, {recursive: true}).filter(f => /\.(js|css|html|json)$/.test(f)).map(f => path.join(staticDir, f));
  const blob = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const envVals = Object.entries(process.env).filter(([k, v]) => /DATABASE_URL|DB_URL|PASSWORD|SECRET|SERVICE_ROLE/.test(k) && v && v.length > 8).map(([, v]) => v);
  ok('no env secret value appears in any browser bundle', envVals.every(v => !blob.includes(v)), `${files.length} files scanned`);
  ok('no server-only code in browser bundles (argon2, pg, postgres URLs, service key names)', !/@node-rs\/argon2|postgresql:\/\/|SUPABASE_SERVICE_ROLE_KEY|ADMIN_DATABASE_URL|staff_sessions/.test(blob));
  const html = await (await fetch(BASE + '/login')).text();
  ok('no secret in page HTML', envVals.every(v => !html.includes(v)));

  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
