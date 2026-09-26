/* Table types for the columns the apps use (see database/migrations for the full schema).
   Generated<T> = has a database default (optional on insert). Nullable columns are optional on insert.
   jsonb is written as a JSON string (JSON.stringify) and read back as parsed JSON. */
import type { ColumnType, Generated } from 'kysely';

type Timestamp = Date;
type Json = ColumnType<unknown, string, string>;
type JsonWithDefault = ColumnType<unknown, string | undefined, string>;
type JsonNullable = ColumnType<unknown, string | null | undefined, string | null>;

export type StaffStatus = 'invited' | 'active' | 'disabled';
export type AuthTokenPurpose = 'email_verification' | 'password_reset' | 'staff_invitation';
export type AuthRealm = 'customer' | 'staff';
export type AuditActorType = 'staff' | 'customer' | 'system';

export interface StaffUsersTable {
  id: Generated<string>;
  email: string;
  full_name: Generated<string>;
  password_hash: string | null;
  status: Generated<StaffStatus>;
  email_verified_at: Timestamp | null;
  password_changed_at: Timestamp | null;
  last_login_at: Timestamp | null;
  invited_by: string | null;
  disabled_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RolesTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: Generated<string>;
  is_system: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PermissionsTable {
  code: string;
  module: string;
  description: Generated<string>;
  created_at: Generated<Timestamp>;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_code: string;
  granted_at: Generated<Timestamp>;
}

export interface StaffUserRolesTable {
  staff_user_id: string;
  role_id: string;
  granted_by: string | null;
  granted_at: Generated<Timestamp>;
}

export interface StaffSessionsTable {
  id: Generated<string>;
  staff_user_id: string;
  token_hash: Buffer;
  created_at: Generated<Timestamp>;
  last_seen_at: Generated<Timestamp>;
  idle_expires_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
}

export interface AuthTokensTable {
  id: Generated<string>;
  purpose: AuthTokenPurpose;
  customer_id: string | null;
  staff_user_id: string | null;
  token_hash: Buffer;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  created_ip: string | null;
  metadata: JsonWithDefault;
}

export interface AuthAttemptsTable {
  id: Generated<number>;
  realm: AuthRealm;
  email: string;
  ip: string | null;
  succeeded: boolean;
  failure_reason: string | null;
  attempted_at: Generated<Timestamp>;
}

export interface AuditLogsTable {
  id: Generated<number>;
  occurred_at: Generated<Timestamp>;
  actor_type: AuditActorType;
  staff_id: string | null;
  customer_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_data: JsonNullable;
  after_data: JsonNullable;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: JsonWithDefault;
}

export interface SettingsTable {
  key: string;
  value: Json;
  description: Generated<string>;
  is_public: Generated<boolean>;
  updated_by: string | null;
  updated_at: Generated<Timestamp>;
}

export type ProductStatus = 'active' | 'draft' | 'archived';

// Catalogue. Product and category ids are the stable text ids (ky-proto-001, tops.hoodies); never regenerated.
export interface CategoriesTable { id: string; label: string; parent_id: string | null; sort_order: number; is_active: Generated<boolean>; description: Generated<string>; created_at: Generated<Timestamp>; }
export interface CollectionsTable { id: string; label: string; data_status: string; note: string | null; }
export interface CollectionProductsTable { collection_id: string; product_id: string; position: number; }
export interface ProductsTable {
  id: Generated<string>;                     // database default: 'kts-' + 8 random hex characters
  sku: string;
  slug: string;
  name: string;
  description: string;
  category_id: string;
  subcategory_id: string | null;
  price_paise: number;                       // integer paise; never a float
  colour_label: string | null;
  colour_swatch: string | null;
  catalogue_ref: string | null;
  features: Generated<string[]>;
  is_featured: Generated<boolean>;
  status: Generated<ProductStatus>;
  data_status: Generated<string>;
  material: string | null;
  care: string | null;
  origin: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
/** stock_qty is read-only to the apps: it changes only through public.adjust_stock() (database-enforced). */
export interface ProductVariantsTable {
  id: Generated<string>; product_id: string; sku: string; size: string; sort_order: number; price_paise: number | null;
  stock_qty: ColumnType<number, never, never>;               // defaults to 0 on insert; never written by the apps
  stock_source: Generated<string>; is_active: Generated<boolean>; reorder_level: number | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface ProductImagesTable {
  id: Generated<string>; product_id: string; storage_path: string; width: number | null; height: number | null; alt: Generated<string>;
  is_primary: Generated<boolean>; sort_order: Generated<number>; created_at: Generated<Timestamp>;
}
export interface InventoryReasonsTable { code: string; label: string; direction: 'in' | 'out' | 'any'; is_system: boolean; is_active: boolean; sort_order: number; }
/** Ledger rows are written only by adjust_stock() (and the original seed). */
export interface InventoryMovementsTable {
  id: ColumnType<number, never, never>; variant_id: string; delta: number; reason: string; order_id: string | null;
  created_by: string | null; staff_id: string | null; note: string | null; balance_after: number | null; created_at: Timestamp;
}
export interface InventoryStatusView {
  variant_id: string; variant_sku: string; size: string; product_id: string; product_sku: string; product_name: string;
  product_status: ProductStatus; category_id: string; is_active: boolean; stock_qty: number; reorder_level: number;
  stock_status: 'out_of_stock' | 'low_stock' | 'in_stock'; last_movement_at: Date | null;
}
export interface CustomersTable { id: string; email: string; status: 'active' | 'disabled'; created_at: Timestamp; }
// Orders (Phase 4.2 + M2). Amounts are integer paise and are never edited by the admin app.
export type OrderStatus = 'pending_payment' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'payment_failed' | 'refunded';
export type PaymentStatus = 'unpaid' | 'pending' | 'authorized' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
export interface OrdersTable {
  id: string; order_number: string; user_id: string; customer_id: string | null;
  status: OrderStatus; payment_status: PaymentStatus | null; currency: string;
  subtotal_paise: ColumnType<number, number, never>; total_paise: ColumnType<number, number, never>;   // never updated
  contact: ColumnType<unknown, string, never>; shipping_address: ColumnType<unknown, string, never>;
  razorpay_order_id: string | null; razorpay_payment_id: string | null; paid_at: Timestamp | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
/** Snapshot of what was bought, at the price paid. Read-only to the admin app. */
export interface OrderItemsTable {
  id: string; order_id: string; product_id: string | null; variant_id: string | null; sku: string; name: string; size: string;
  image_path: string | null; unit_price_paise: number; qty: number; line_total_paise: number;
}
export interface OrderStatusHistoryTable {
  id: ColumnType<number, never, never>; order_id: string; from_status: OrderStatus | null; to_status: OrderStatus;
  changed_by: string | null; note: string | null; created_at: Generated<Timestamp>;
}
export interface PaymentsTable {
  id: string; order_id: string; provider: string; provider_order_id: string | null; provider_payment_id: string | null; amount_paise: number;
  currency: string; status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded'; method: string | null;
  failure_reason: string | null; captured_at: Timestamp | null; created_at: Timestamp;
}
export interface RefundsTable {
  id: string; payment_id: string; order_id: string; amount_paise: number; reason: string; status: 'requested' | 'pending' | 'processed' | 'failed';
  provider_refund_id: string | null; processed_at: Timestamp | null; created_at: Timestamp;
}
export interface InvoicesTable {
  id: string; invoice_number: string | null; status: 'draft' | 'issued' | 'void'; order_id: string | null; customer_id: string | null;
  financial_year: string | null; issued_at: Timestamp | null; subtotal_paise: number; tax_paise: number; total_paise: number; prices_include_tax: boolean;
}

export interface SalesDailyView { sales_date: Date; orders_count: number; units_sold: number; subtotal_paise: number; revenue_paise: number; }
export interface LowStockView {
  variant_id: string; variant_sku: string; size: string; product_id: string; product_sku: string; product_name: string;
  stock_qty: number; reorder_level: number; stock_status: 'out_of_stock' | 'low_stock' | 'in_stock';
}

export interface Database {
  staff_users: StaffUsersTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  staff_user_roles: StaffUserRolesTable;
  staff_sessions: StaffSessionsTable;
  auth_tokens: AuthTokensTable;
  auth_attempts: AuthAttemptsTable;
  audit_logs: AuditLogsTable;
  settings: SettingsTable;
  categories: CategoriesTable;
  collections: CollectionsTable;
  collection_products: CollectionProductsTable;
  products: ProductsTable;
  product_variants: ProductVariantsTable;
  product_images: ProductImagesTable;
  inventory_reasons: InventoryReasonsTable;
  inventory_movements: InventoryMovementsTable;
  v_inventory_status: InventoryStatusView;
  customers: CustomersTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  order_status_history: OrderStatusHistoryTable;
  payments: PaymentsTable;
  refunds: RefundsTable;
  invoices: InvoicesTable;
  v_sales_daily: SalesDailyView;
  v_low_stock: LowStockView;
}
