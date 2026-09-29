'use client';
/* The one data table for every list page (TanStack Table): sortable headers, whole-row click, a "⋯" row menu that
   appears on hover, optional row selection, density and column choices (remembered per browser), CSV export of the
   rows on screen (after filters, in the current sort), pagination with a page-size choice, and empty / loading states.
   Pages keep their own filtering on the server; the table only arranges what it is given. */
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  flexRender, getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type OnChangeFn, type RowData, type RowSelectionState, type SortingState, type VisibilityState,
} from '@tanstack/react-table';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './icons';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Header text for the column menu and the CSV file. */
    label?: string;
    /** Right-aligned numbers. */
    numeric?: boolean;
    /** Stays visible when the table scrolls sideways on small screens. */
    sticky?: boolean;
    /** Value written to the CSV export (omit to leave the column out of the file). */
    csv?: (row: TData) => string | number | null | undefined;
    /** Always shown (not offered in the column menu). */
    required?: boolean;
  }
}

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  getRowId: (row: T) => string;
  rowHref?: (row: T) => string | undefined;
  /** Extra attributes on each <tr> (e.g. data-product-row). */
  rowAttrs?: (row: T) => Record<string, string | undefined>;
  /** Extra attributes on the <table> (e.g. data-products-table). */
  tableAttrs?: Record<string, string>;
  /** Row selection with native checkboxes (named for the bulk form they belong to). */
  selection?: { name: string; form: string; label: (row: T) => string; value: RowSelectionState; onChange: OnChangeFn<RowSelectionState> };
  rowMenu?: (row: T) => ReactNode;
  rowMenuLabel?: (row: T) => string;
  toolbar?: ReactNode;
  chips?: ReactNode;
  empty: ReactNode;
  busy?: boolean;
  exportName?: string;
  storageKey: string;
  defaultPageSize?: number;
}

const PAGE_SIZES = [25, 50, 100];
const INTERACTIVE = 'a,button,input,label,select,textarea,[role=menuitem],[data-no-row-click]';

function readPrefs(key: string): { density?: 'comfortable' | 'compact'; hidden?: VisibilityState; pageSize?: number } {
  try { return JSON.parse(localStorage.getItem(`kitsyuu-table:${key}`) ?? '{}'); } catch { return {}; }
}
function writePrefs(key: string, prefs: object) {
  try { localStorage.setItem(`kitsyuu-table:${key}`, JSON.stringify(prefs)); } catch { /* storage blocked */ }
}

function csvCell(v: unknown) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
}

export default function DataTable<T>({
  data, columns, getRowId, rowHref, rowAttrs, tableAttrs, selection, rowMenu, rowMenuLabel, toolbar, chips, empty, busy,
  exportName, storageKey, defaultPageSize = 50,
}: DataTableProps<T>) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: defaultPageSize });
  const loaded = useRef(false);
  useEffect(() => {
    const p = readPrefs(storageKey);
    if (p.density) setDensity(p.density);
    if (p.hidden) setVisibility(p.hidden);
    if (p.pageSize && PAGE_SIZES.includes(p.pageSize)) setPagination(s => ({ ...s, pageSize: p.pageSize! }));
    loaded.current = true;
  }, [storageKey]);
  useEffect(() => { if (loaded.current) writePrefs(storageKey, { density, hidden: visibility, pageSize: pagination.pageSize }); }, [storageKey, density, visibility, pagination.pageSize]);
  // A new result set (filters changed) starts on the first page.
  useEffect(() => { setPagination(s => ({ ...s, pageIndex: 0 })); }, [data]);

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    const cols: ColumnDef<T, unknown>[] = [];
    if (selection) cols.push({
      id: '_select', enableSorting: false, enableHiding: false, meta: { required: true },
      header: ({ table }) => <HeaderCheckbox checked={table.getIsAllRowsSelected()} indeterminate={table.getIsSomeRowsSelected()}
        onChange={v => table.toggleAllRowsSelected(v)} />,
      cell: ({ row }) => (
        <input type="checkbox" name={selection.name} value={row.id} form={selection.form} checked={row.getIsSelected()}
          onChange={e => row.toggleSelected(e.currentTarget.checked)} aria-label={`Select ${selection.label(row.original)}`} />
      ),
    });
    cols.push(...columns);
    if (rowMenu) cols.push({
      id: '_menu', enableSorting: false, enableHiding: false, meta: { required: true },
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <Dropdown.Root>
          <Dropdown.Trigger className="icon-btn row-menu-btn" aria-label={rowMenuLabel ? rowMenuLabel(row.original) : 'Row actions'}>
            <Icon name="more" />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="menu" align="end" sideOffset={4}>{rowMenu(row.original)}</Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      ),
    });
    return cols;
  }, [columns, selection, rowMenu, rowMenuLabel]);

  const table = useReactTable({
    data, columns: allColumns, getRowId,
    state: { sorting, columnVisibility: visibility, pagination, rowSelection: selection?.value ?? {} },
    onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, onPaginationChange: setPagination,
    onRowSelectionChange: u => selection?.onChange(u),
    enableRowSelection: !!selection, autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(),
  });

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, href?: string) => {
    if (!href || (e.target as HTMLElement).closest(INTERACTIVE) || window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noopener'); else router.push(href);
  };

  const exportCsv = () => {
    const cols = table.getVisibleLeafColumns().filter(c => c.columnDef.meta?.csv);
    const lines = [cols.map(c => csvCell(c.columnDef.meta?.label ?? c.id)).join(',')];
    for (const r of table.getSortedRowModel().rows) lines.push(cols.map(c => csvCell(c.columnDef.meta!.csv!(r.original))).join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${exportName}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const rows = table.getRowModel().rows;
  const total = data.length;
  const { pageIndex, pageSize } = table.getState().pagination;
  const from = total === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min(total, (pageIndex + 1) * pageSize);
  const hideable = table.getAllLeafColumns().filter(c => c.getCanHide() && !c.columnDef.meta?.required);

  return (
    <div className="dt" data-density={density} aria-busy={busy || undefined}>
      <div className="dt-toolbar">
        {toolbar}
        <span className="dt-spacer" />
        <Dropdown.Root>
          <Dropdown.Trigger className="btn ghost sm" aria-label="Table view options"><Icon name="columns" size={15} />View</Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="menu" align="end" sideOffset={6} style={{ minWidth: 210 }}>
              <Dropdown.Label className="menu-label">Density</Dropdown.Label>
              <Dropdown.RadioGroup value={density} onValueChange={v => setDensity(v as 'comfortable' | 'compact')}>
                {(['comfortable', 'compact'] as const).map(d => (
                  <Dropdown.RadioItem key={d} value={d} className="menu-item">
                    <Icon name="density" />{d === 'comfortable' ? 'Comfortable' : 'Compact'}
                    <Dropdown.ItemIndicator className="menu-check"><Icon name="check" size={14} /></Dropdown.ItemIndicator>
                  </Dropdown.RadioItem>
                ))}
              </Dropdown.RadioGroup>
              {hideable.length > 0 && <><Dropdown.Separator className="menu-sep" /><Dropdown.Label className="menu-label">Columns</Dropdown.Label></>}
              {hideable.map(c => (
                <Dropdown.CheckboxItem key={c.id} className="menu-item" checked={c.getIsVisible()} onCheckedChange={v => c.toggleVisibility(!!v)} onSelect={e => e.preventDefault()}>
                  {c.columnDef.meta?.label ?? c.id}
                  <Dropdown.ItemIndicator className="menu-check"><Icon name="check" size={14} /></Dropdown.ItemIndicator>
                </Dropdown.CheckboxItem>
              ))}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        {exportName && <button type="button" className="btn ghost sm" onClick={exportCsv} disabled={total === 0} data-export-csv>
          <Icon name="download" size={15} />Export</button>}
      </div>
      {chips}
      <div className="table-wrap">
        {total === 0 ? <div className="dt-empty-wrap">{empty}</div> : (
          <table {...tableAttrs}>
            <thead>{table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>{hg.headers.map(h => {
                const meta = h.column.columnDef.meta;
                const sorted = h.column.getIsSorted();
                const cls = [h.column.id === '_select' ? 'select-col' : '', h.column.id === '_menu' ? 'actions-col' : '', meta?.numeric ? 'num' : '', meta?.sticky ? 'sticky-col' : ''].filter(Boolean).join(' ');
                return (
                  <th key={h.id} className={cls || undefined} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
                    {h.isPlaceholder ? null : h.column.getCanSort() ? (
                      <button type="button" className="sort-btn" onClick={h.column.getToggleSortingHandler()}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <Icon name={sorted === 'asc' ? 'sort-asc' : sorted === 'desc' ? 'sort-desc' : 'sort'} size={13} />
                      </button>
                    ) : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                );
              })}</tr>
            ))}</thead>
            <tbody>{rows.map(r => {
              const href = rowHref?.(r.original);
              return (
                <tr key={r.id} {...rowAttrs?.(r.original)} data-href={href} data-selected={r.getIsSelected() || undefined} onClick={e => onRowClick(e, href)}>
                  {r.getVisibleCells().map(c => {
                    const meta = c.column.columnDef.meta;
                    const cls = [c.column.id === '_select' ? 'select-col' : '', c.column.id === '_menu' ? 'actions-col' : '', meta?.numeric ? 'num' : '', meta?.sticky ? 'sticky-col' : ''].filter(Boolean).join(' ');
                    return <td key={c.id} className={cls || undefined}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>;
                  })}
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {total > 0 && (
        <div className="dt-foot">
          <span data-result-count>{from === 1 && to === total ? `${total.toLocaleString('en-IN')} ${total === 1 ? 'result' : 'results'}` : `${from}–${to} of ${total.toLocaleString('en-IN')}`}</span>
          <div className="dt-foot-right">
            <label className="nowrap">Rows per page{' '}
              <select className="dt-size" value={pageSize} onChange={e => table.setPageSize(Number(e.currentTarget.value))}>
                {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <div className="dt-pages">
              <button type="button" className="icon-btn" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page"><Icon name="chevron-left" /></button>
              <button type="button" className="icon-btn" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page"><Icon name="chevron-right" /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderCheckbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={e => onChange(e.currentTarget.checked)} aria-label="Select all rows" />;
}

/** Empty state for a table: a small illustration, what is missing, and what to do next. */
export function TableEmpty({ title, children, actions, kind }: { title: string; children?: ReactNode; actions?: ReactNode; kind?: string }) {
  return (
    <div className="dt-empty" data-empty={kind}>
      <span className="dt-empty-art" aria-hidden="true"><Icon name="inbox" size={24} /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
