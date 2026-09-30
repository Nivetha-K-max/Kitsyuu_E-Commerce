'use client';
/* Product list: search and filters apply as you type (the URL holds them, the server does the searching), sortable
   columns, a "⋯" menu per row, and a floating bar for bulk status changes. Every change still goes through the same
   server actions as before (checked, locked and audited in core). */
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { startTransition, useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { ActionState } from '@kitsyuu/contracts';
import { useConfirm } from '@/components/confirm';
import DataTable, { TableEmpty } from '@/components/DataTable';
import { Icon } from '@/components/icons';
import { StatusPill } from '@/components/StatusPill';

export interface ProductRowView {
  id: string; sku: string; name: string; status: 'active' | 'draft' | 'archived'; categoryLabel: string; subcategoryLabel: string | null;
  pricePaise: number; isFeatured: boolean; imageUrl: string | null; variants: number; sellableVariants: number; stockUnits: number;
  attentionVariants: number; storeUrl: string | null;
}
type Category = { id: string; label: string; parent_id: string | null };
type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
export interface ProductFilters { q: string; category: string; status: 'all' | 'active' | 'inactive' | 'draft' | 'archived'; pmin: string; pmax: string;
  /** Client change request: filter by collection and by availability (combine with the others). */
  collection: string; stock: 'all' | 'in_stock' | 'low' | 'out' }

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS_FILTERS = [{ value: 'active', label: 'Active' }, { value: 'draft', label: 'Draft' }, { value: 'archived', label: 'Archived' }, { value: 'inactive', label: 'Draft or archived' }] as const;
const STOCK_FILTERS = [{ value: 'in_stock', label: 'In stock' }, { value: 'low', label: 'Low or out of stock (a size)' }, { value: 'out', label: 'Sold out' }] as const;

export default function ProductsTable({ rows, categories, collections = [], filters, canWrite, bulkAction, statusAction }: {
  rows: ProductRowView[]; categories: Category[]; collections?: { id: string; label: string }[]; filters: ProductFilters; canWrite: boolean; bulkAction: Action; statusAction: Action;
}) {
  const router = useRouter();
  const path = usePathname();
  const ask = useConfirm();
  const [pending, navigate] = useTransition();
  const [q, setQ] = useState(filters.q);
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [working, setWorking] = useState(false);

  const setParams = (patch: Partial<ProductFilters>) => {
    const next = { ...filters, q, ...patch };
    const sp = new URLSearchParams();
    if (next.q.trim()) sp.set('q', next.q.trim());
    if (next.category) sp.set('category', next.category);
    if (next.status !== 'all') sp.set('status', next.status);
    if (next.pmin) sp.set('pmin', next.pmin);
    if (next.pmax) sp.set('pmax', next.pmax);
    if (next.collection) sp.set('collection', next.collection);
    if (next.stock !== 'all') sp.set('stock', next.stock);
    navigate(() => router.replace(sp.size ? `${path}?${sp}` : path, { scroll: false }));
  };
  // Search applies 300 ms after typing stops.
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => setParams({ q }), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected({}); }, [rows]);

  // Price range narrows the rows the server returned (no extra query).
  const min = filters.pmin ? Number(filters.pmin) * 100 : null;
  const max = filters.pmax ? Number(filters.pmax) * 100 : null;
  const shown = useMemo(() => rows.filter(r => (min == null || r.pricePaise >= min) && (max == null || r.pricePaise <= max)), [rows, min, max]);
  const catLabel = (id: string) => {
    const c = categories.find(x => x.id === id);
    const p = c?.parent_id ? categories.find(x => x.id === c.parent_id) : null;
    return c ? (p ? `${p.label} / ${c.label}` : c.label) : id;
  };
  const filtered = !!(filters.q || filters.category || filters.status !== 'all' || filters.pmin || filters.pmax || filters.collection || filters.stock !== 'all');
  const colLabel = (id: string) => collections.find(c => c.id === id)?.label ?? id;

  async function setStatus(p: ProductRowView, status: 'draft' | 'archived') {
    const yes = await ask(status === 'archived'
      ? { title: `Archive “${p.name}”?`, description: 'It is hidden from the store. Orders and history are kept, and you can move it back to draft at any time.', confirmLabel: 'Archive', tone: 'danger' }
      : { title: `Move “${p.name}” to draft?`, description: 'It stays hidden from the store until you make it active on its page.', confirmLabel: 'Move to draft' });
    if (!yes) return;
    const fd = new FormData(); fd.set('productId', p.id); fd.set('status', status);
    const res = await statusAction({}, fd);
    (res.ok ? toast.success : toast.error)(res.message ?? (res.ok ? 'Saved.' : 'Could not change the status.'));
    if (res.ok) startTransition(() => router.refresh());
  }

  async function bulkSet(status: 'active' | 'draft' | 'archived') {
    const ids = Object.keys(selected).filter(k => selected[k]);
    if (!ids.length) return;
    const label = status === 'active' ? 'Active' : status === 'draft' ? 'Draft' : 'Archived';
    if (!(await ask({ title: `Set ${ids.length} product${ids.length === 1 ? '' : 's'} to ${label}?`,
      description: 'Each product is checked as if changed on its own page: one that cannot be shown (no size or image) is reported and left as it is.',
      confirmLabel: `Set to ${label}`, tone: status === 'archived' ? 'danger' : 'default' }))) return;
    const fd = new FormData(); ids.forEach(id => fd.append('productIds[]', id)); fd.set('status', status);
    setWorking(true);
    const res = await bulkAction({}, fd);
    setWorking(false);
    (res.ok ? toast.success : toast.error)(res.message ?? '');
    setSelected({});
    startTransition(() => router.refresh());
  }

  const columns = useMemo<ColumnDef<ProductRowView, unknown>[]>(() => [
    {
      id: 'product', accessorFn: r => r.name, header: 'Product', meta: { label: 'Product', sticky: true, required: true, csv: r => r.name },
      cell: ({ row: { original: p } }) => (
        <div className="pcell">
          <span className="pthumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {p.imageUrl ? <img src={p.imageUrl} alt="" width={40} height={50} loading="lazy" decoding="async" /> : <Icon name="no-image" size={16} />}
          </span>
          <div>
            <div className="pname">
              <Link className="row-link" href={`/products/${p.id}`}>{p.name}</Link>
              {p.isFeatured && (
                <Tooltip.Root>
                  <Tooltip.Trigger asChild><span className="star" aria-label="Featured" data-featured><Icon name="star" size={13} fill /></span></Tooltip.Trigger>
                  <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>Featured in the store</Tooltip.Content></Tooltip.Portal>
                </Tooltip.Root>
              )}
            </div>
            <div className="pmeta">{p.id}</div>
          </div>
        </div>
      ),
    },
    { id: 'sku', accessorKey: 'sku', header: 'SKU', meta: { label: 'SKU', csv: r => r.sku }, cell: ({ getValue }) => <span className="mono nowrap">{String(getValue())}</span> },
    {
      id: 'category', accessorFn: r => `${r.categoryLabel} ${r.subcategoryLabel ?? ''}`, header: 'Category',
      meta: { label: 'Category', csv: r => r.subcategoryLabel ? `${r.categoryLabel} / ${r.subcategoryLabel}` : r.categoryLabel },
      cell: ({ row: { original: p } }) => <div className="cat-cell">{p.categoryLabel}{p.subcategoryLabel && <small>{p.subcategoryLabel}</small>}</div>,
    },
    {
      id: 'price', accessorKey: 'pricePaise', header: 'Price', meta: { label: 'Price', numeric: true, csv: r => (r.pricePaise / 100).toFixed(2) },
      cell: ({ row: { original: p } }) => <span className="money" data-price>{rupees(p.pricePaise)}</span>,
    },
    {
      id: 'stock', accessorKey: 'stockUnits', header: 'Stock', meta: { label: 'Stock', numeric: true, csv: r => r.stockUnits },
      cell: ({ row: { original: p } }) => (
        <div className="stock" data-warn={p.attentionVariants > 0 || undefined}>
          <b>{p.stockUnits.toLocaleString('en-IN')}</b>
          <small>{p.sellableVariants}/{p.variants} sizes</small>
          {p.attentionVariants > 0 && <span className="stock-warn" data-attention><Icon name="alert" size={12} />{p.attentionVariants} low</span>}
        </div>
      ),
    },
    {
      id: 'status', accessorKey: 'status', header: 'Status', meta: { label: 'Status', csv: r => r.status },
      cell: ({ row: { original: p } }) => <StatusPill status={p.status} />,
    },
  ], []);

  const selectedCount = Object.values(selected).filter(Boolean).length;

  const toolbar = (
    <>
      <div className="dt-search" role="search">
        <Icon name="search" size={15} />
        <label className="sr-only" htmlFor="p-q">Search products</label>
        <input id="p-q" name="q" value={q} onChange={e => setQ(e.currentTarget.value)} placeholder="Search name, SKU or ID" autoComplete="off"
          onKeyDown={e => { if (e.key === 'Enter') setParams({ q }); if (e.key === 'Escape' && q) { setQ(''); setParams({ q: '' }); } }} />
        {q && <button type="button" className="icon-btn dt-search-clear" aria-label="Clear search" onClick={() => { setQ(''); setParams({ q: '' }); }}><Icon name="close" size={14} /></button>}
      </div>
      <CategoryFilter categories={categories} value={filters.category} onChange={category => setParams({ category })} label={filters.category ? catLabel(filters.category) : null} />
      <FilterMenu label="Status" value={filters.status === 'all' ? null : STATUS_FILTERS.find(s => s.value === filters.status)?.label ?? null}
        options={STATUS_FILTERS.map(s => ({ value: s.value, label: s.label }))} selected={filters.status}
        onPick={v => setParams({ status: (v ?? 'all') as ProductFilters['status'] })} />
      {collections.length > 0 && <FilterMenu label="Collection" value={filters.collection ? colLabel(filters.collection) : null}
        options={collections.map(c => ({ value: c.id, label: c.label }))} selected={filters.collection || 'all'}
        onPick={v => setParams({ collection: v ?? '' })} />}
      <FilterMenu label="Availability" value={filters.stock === 'all' ? null : STOCK_FILTERS.find(s => s.value === filters.stock)?.label ?? null}
        options={STOCK_FILTERS.map(s => ({ value: s.value, label: s.label }))} selected={filters.stock}
        onPick={v => setParams({ stock: (v ?? 'all') as ProductFilters['stock'] })} />
      <PriceFilter min={filters.pmin} max={filters.pmax} onApply={(pmin, pmax) => setParams({ pmin, pmax })} />
      {filtered && <button type="button" className="btn quiet sm" onClick={() => { setQ(''); navigate(() => router.replace(path, { scroll: false })); }}>Clear filters</button>}
    </>
  );

  const chips = filtered ? (
    <div className="dt-chips" aria-label="Applied filters" data-product-filters>
      {filters.q && <Chip name="Search" value={`“${filters.q}”`} onRemove={() => { setQ(''); setParams({ q: '' }); }} />}
      {filters.category && <Chip name="Category" value={catLabel(filters.category)} onRemove={() => setParams({ category: '' })} />}
      {filters.status !== 'all' && <Chip name="Status" value={STATUS_FILTERS.find(s => s.value === filters.status)?.label ?? ''} onRemove={() => setParams({ status: 'all' })} />}
      {filters.collection && <Chip name="Collection" value={colLabel(filters.collection)} onRemove={() => setParams({ collection: '' })} />}
      {filters.stock !== 'all' && <Chip name="Availability" value={STOCK_FILTERS.find(s => s.value === filters.stock)?.label ?? ''} onRemove={() => setParams({ stock: 'all' })} />}
      {(filters.pmin || filters.pmax) && <Chip name="Price" value={`${filters.pmin ? `₹${filters.pmin}` : 'any'} – ${filters.pmax ? `₹${filters.pmax}` : 'any'}`} onRemove={() => setParams({ pmin: '', pmax: '' })} />}
    </div>
  ) : null;

  return (
    <>
      <DataTable
        data={shown} columns={columns} getRowId={r => r.id} storageKey="products" exportName="products" busy={pending}
        rowHref={r => `/products/${r.id}`}
        rowAttrs={r => ({ 'data-product-row': r.id })}
        tableAttrs={{ 'data-products-table': '' }}
        selection={canWrite ? { name: 'productIds[]', form: 'bulk-status-form', label: r => r.name, value: selected, onChange: setSelected } : undefined}
        rowMenuLabel={r => `Actions for ${r.name}`}
        rowMenu={p => (
          <>
            <Dropdown.Item asChild className="menu-item"><Link href={`/products/${p.id}`}><Icon name="edit" />{canWrite ? 'Edit product' : 'View product'}</Link></Dropdown.Item>
            {p.storeUrl && p.status === 'active' && (
              <Dropdown.Item asChild className="menu-item"><a href={p.storeUrl} target="_blank" rel="noreferrer"><Icon name="external" />View in store</a></Dropdown.Item>
            )}
            <Dropdown.Item className="menu-item" onSelect={() => { navigator.clipboard?.writeText(p.id).then(() => toast.success(`Copied ${p.id}`)).catch(() => {}); }}>
              <Icon name="products" />Copy product ID
            </Dropdown.Item>
            {canWrite && <>
              <Dropdown.Separator className="menu-sep" />
              {p.status === 'archived'
                ? <Dropdown.Item className="menu-item" onSelect={() => setStatus(p, 'draft')}><Icon name="restore" />Move to draft</Dropdown.Item>
                : <Dropdown.Item className="menu-item danger" onSelect={() => setStatus(p, 'archived')}><Icon name="archive" />Archive</Dropdown.Item>}
            </>}
          </>
        )}
        toolbar={toolbar}
        chips={chips}
        empty={
          <TableEmpty kind="products" title={filtered ? 'No matching products' : 'No products yet'}
            actions={filtered ? <button type="button" className="btn ghost sm" onClick={() => { setQ(''); navigate(() => router.replace(path)); }}>Clear filters</button>
              : canWrite ? <Link className="btn sm" href="/products/new"><Icon name="plus" size={15} />New product</Link> : undefined}>
            {filtered ? 'Nothing matches these filters. Try a different search or remove a filter.' : 'Products you create appear here.'}
          </TableEmpty>
        }
      />
      {canWrite && <form id="bulk-status-form" aria-label="Bulk status" onSubmit={e => e.preventDefault()} hidden />}
      {canWrite && selectedCount > 0 && (
        <div className="bulk-float" role="region" aria-label="Bulk actions" data-section="bulk-status">
          <span className="bulk-count">{selectedCount} selected</span>
          <Dropdown.Root>
            <Dropdown.Trigger className="btn quiet sm" disabled={working}><Icon name="updown" size={14} />Set status</Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content className="menu" side="top" sideOffset={8} align="start">
                <Dropdown.Item className="menu-item" onSelect={() => bulkSet('active')}><span className="badge active" />Active (in the store)</Dropdown.Item>
                <Dropdown.Item className="menu-item" onSelect={() => bulkSet('draft')}><span className="badge draft" />Draft (hidden)</Dropdown.Item>
                <Dropdown.Item className="menu-item" onSelect={() => bulkSet('archived')}><span className="badge archived" />Archived (hidden)</Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
          <button type="button" className="btn quiet sm" onClick={() => setSelected({})}>Clear</button>
        </div>
      )}
    </>
  );
}

function Chip({ name, value, onRemove }: { name: string; value: string; onRemove: () => void }) {
  return <span className="chip">{name}: <b>{value}</b><button type="button" onClick={onRemove} aria-label={`Remove ${name} filter`}><Icon name="close" size={12} /></button></span>;
}

function FilterMenu({ label, value, options, selected, onPick }: {
  label: string; value: string | null; options: { value: string; label: string }[]; selected: string; onPick: (v: string | null) => void;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="dt-filter" data-active={value ? true : undefined}>
        <Icon name="filter" size={14} />{label}{value && <span className="dt-filter-value">{value}</span>}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="start" sideOffset={6}>
          <Dropdown.RadioGroup value={selected} onValueChange={onPick}>
            {options.map(o => (
              <Dropdown.RadioItem key={o.value} value={o.value} className="menu-item">{o.label}
                <Dropdown.ItemIndicator className="menu-check"><Icon name="check" size={14} /></Dropdown.ItemIndicator></Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
          {value && <><Dropdown.Separator className="menu-sep" /><Dropdown.Item className="menu-item" onSelect={() => onPick(null)}>Clear filter</Dropdown.Item></>}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function CategoryFilter({ categories, value, label, onChange }: { categories: Category[]; value: string; label: string | null; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const parents = categories.filter(c => !c.parent_id);
  const match = (c: Category) => !find || c.label.toLowerCase().includes(find.toLowerCase());
  const pick = (id: string) => { onChange(id); setOpen(false); setFind(''); };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="dt-filter" data-active={value ? true : undefined}>
        <Icon name="categories" size={14} />Category{label && <span className="dt-filter-value">{label}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="start" sideOffset={6} style={{ width: 260 }}>
          <input className="option-filter" placeholder="Find a category…" value={find} onChange={e => setFind(e.currentTarget.value)} aria-label="Find a category" autoFocus />
          <div className="option-list" role="listbox" aria-label="Category">
            {parents.map(p => {
              const kids = categories.filter(c => c.parent_id === p.id && match(c));
              if (!match(p) && kids.length === 0) return null;
              return [
                <button key={p.id} type="button" role="option" aria-selected={value === p.id} className="option" onClick={() => pick(p.id)}>
                  {p.label}{value === p.id && <span className="menu-check"><Icon name="check" size={14} /></span>}</button>,
                ...kids.map(c => (
                  <button key={c.id} type="button" role="option" aria-selected={value === c.id} className="option child" onClick={() => pick(c.id)}>
                    {c.label}{value === c.id && <span className="menu-check"><Icon name="check" size={14} /></span>}</button>
                )),
              ];
            })}
          </div>
          {value && <div className="popover-foot"><button type="button" className="btn quiet sm" onClick={() => pick('')}>Clear filter</button></div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PriceFilter({ min, max, onApply }: { min: string; max: string; onApply: (min: string, max: string) => void }) {
  const [open, setOpen] = useState(false);
  const [lo, setLo] = useState(min);
  const [hi, setHi] = useState(max);
  useEffect(() => { setLo(min); setHi(max); }, [min, max]);
  const clean = (v: string) => (/^\d{1,7}$/.test(v.trim()) ? v.trim() : '');
  const apply = () => { onApply(clean(lo), clean(hi)); setOpen(false); };
  const active = !!(min || max);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="dt-filter" data-active={active || undefined}>
        <Icon name="value" size={14} />Price{active && <span className="dt-filter-value">{min ? `₹${min}` : 'any'}–{max ? `₹${max}` : 'any'}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="start" sideOffset={6} style={{ width: 250 }}>
          <form onSubmit={e => { e.preventDefault(); apply(); }}>
            <div className="range-fields">
              <label>Minimum (₹)<input inputMode="numeric" value={lo} onChange={e => setLo(e.currentTarget.value)} placeholder="0" autoFocus /></label>
              <label>Maximum (₹)<input inputMode="numeric" value={hi} onChange={e => setHi(e.currentTarget.value)} placeholder="Any" /></label>
            </div>
            <div className="popover-foot">
              <button type="button" className="btn quiet sm" onClick={() => { onApply('', ''); setOpen(false); }}>Clear</button>
              <button type="submit" className="btn sm">Apply</button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
