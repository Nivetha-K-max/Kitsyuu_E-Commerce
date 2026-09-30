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
export interface CollectionsTable { id: string; label: string; data_status: string; note: string | null; is_active: Generated<boolean>; sort_order: Generated<number>; }
export interface CollectionProductsTable { collection_id: string; product_id: string; position: number; }
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export interface ReviewsTable {
  id: Generated<string>; product_id: string; customer_id: string; order_item_id: string; rating: number; title: string | null; body: string;
  display_name: string; status: Generated<ReviewStatus>; moderation_note: string | null; moderated_by: string | null; moderated_at: Timestamp | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface ReviewPhotosTable { id: Generated<string>; review_id: string; position: number; content_type: Generated<string>; width: number; height: number; bytes: Buffer; created_at: Generated<Timestamp>; }
export interface VendorsTable { id: Generated<string>; name: string; contact: string | null; email: string | null; phone: string | null; gstin: string | null; address: string | null; notes: string | null; is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; }
export interface MaterialsTable { id: Generated<string>; code: string; name: string; unit: string; stock_qty: Generated<string>; reorder_level: string | null; notes: string | null; is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; }
export type PoStatusDb = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled';
export interface PurchaseOrdersTable { id: Generated<string>; po_number: string; vendor_id: string; status: Generated<PoStatusDb>; expected_on: string | null; notes: string | null; ordered_at: Timestamp | null; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; }
export interface PurchaseOrderLinesTable { id: Generated<string>; purchase_order_id: string; material_id: string; qty_ordered: string; qty_received: Generated<string>; unit_cost_paise: number | null; position: Generated<number>; }
export interface GoodsReceiptsTable { id: Generated<string>; purchase_order_id: string; received_at: Generated<Timestamp>; received_by: string | null; note: string | null; }
export interface GoodsReceiptLinesTable { id: Generated<string>; goods_receipt_id: string; purchase_order_line_id: string; qty: string; }
export interface MaterialMovementsTable { id: Generated<string>; material_id: string; delta: string; balance_after: string; reason: string; goods_receipt_id: string | null; staff_id: string | null; note: string | null; created_at: Generated<Timestamp>; }
export type ProductionStatusDb = 'planned' | 'in_progress' | 'completed' | 'cancelled';
export interface ProductionOrdersTable { id: Generated<string>; number: string; variant_id: string; qty_planned: number; status: Generated<ProductionStatusDb>; due_on: string | null; notes: string | null; started_at: Timestamp | null; completed_at: Timestamp | null; cancel_note: string | null; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; }
export interface ProductionInputsTable { id: Generated<string>; production_order_id: string; material_id: string; qty_planned: string | null; qty_consumed: Generated<string>; }
export interface QcResultsTable { id: Generated<string>; production_order_id: string; qty_passed: number; qty_rejected: number; reject_reason: string | null; note: string | null; inspected_by: string | null; inspected_at: Generated<Timestamp>; }
export type StockCountStatus = 'open' | 'posted' | 'cancelled';
export interface StockCountsTable { id: Generated<string>; number: string; status: Generated<StockCountStatus>; note: string | null; created_by: string | null; created_at: Generated<Timestamp>; posted_by: string | null; posted_at: Timestamp | null; }
export interface StockCountLinesTable { id: Generated<string>; stock_count_id: string; variant_id: string; expected_qty: number; counted_qty: number | null; }
export interface VariantCostsTable { variant_id: string; unit_cost_paise: number; updated_by: string | null; updated_at: Generated<Timestamp>; }
export interface NotificationLogTable { id: Generated<string>; event: string; order_id: string | null; recipient: string; subject: string; status: 'sent' | 'failed'; error: string | null; created_at: Generated<Timestamp>; }
export interface CustomerNotesTable { id: Generated<string>; customer_id: string; body: string; created_by: string | null; created_at: Generated<Timestamp>; }
export interface SiteContentTable { id: Generated<string>; key: string; locale: Generated<string>; status: Generated<'draft' | 'published'>; content: Json; updated_by: string | null; published_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; }
export interface StaffMfaTable { staff_user_id: string; secret_enc: Buffer; enabled_at: Timestamp | null; last_used_step: string | null; created_at: Generated<Timestamp>; }
export interface StaffMfaRecoveryCodesTable { id: Generated<string>; staff_user_id: string; code_hash: Buffer; used_at: Timestamp | null; }
export interface ProductRelationsTable { product_id: string; related_id: string; kind: Generated<string>; position: Generated<number>; }
export interface AttributesTable { id: string; label: string; description: Generated<string>; sort_order: Generated<number>; is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; }
export interface AttributeValuesTable { attribute_id: string; slug: string; label: string; sort_order: Generated<number>; created_at: Generated<Timestamp>; }
export interface ProductAttributeValuesTable { product_id: string; attribute_id: string; value_slug: string; created_at: Generated<Timestamp>; }
export interface ProductsTable {
  id: Generated<string>;                     // database default: 'kts-' + 8 random hex characters
  sku: string;
  slug: string;
  name: string;
  description: string;
  category_id: string;
  subcategory_id: string | null;
  hsn_code: Generated<string | null>;
  seo_title: Generated<string | null>;
  seo_description: Generated<string | null>;
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
// Customers (M2 + M6). id = the Supabase Auth user id for accounts mirrored from Supabase (legacy_auth_user_id set).
export type CustomerStatus = 'active' | 'disabled';
export interface CustomersTable {
  id: Generated<string>; email: string; full_name: string | null; phone: string | null;
  password_hash: string | null;          // argon2id; null for a mirrored Supabase account until its first platform login
  status: Generated<CustomerStatus>; email_verified_at: Timestamp | null; last_login_at: Timestamp | null;
  password_changed_at: Timestamp | null; legacy_auth_user_id: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
/** Same design as staff_sessions: only the SHA-256 of the cookie token is stored. */
export interface CustomerSessionsTable {
  id: Generated<string>; customer_id: string; token_hash: Buffer;
  created_at: Generated<Timestamp>; last_seen_at: Generated<Timestamp>; idle_expires_at: Timestamp; expires_at: Timestamp;
  revoked_at: Timestamp | null; ip: string | null; user_agent: string | null;
}
export interface AddressesTable {
  id: Generated<string>; customer_id: string | null; user_id: string | null;   // user_id: legacy Supabase owner (existing rows)
  full_name: string; phone: string; line1: string; line2: string | null; city: string; state: string; pin: string;
  country: Generated<string>; is_default: Generated<boolean>; created_at: Generated<Timestamp>;
}
// Orders (Phase 4.2 + M2). Amounts are integer paise and are never edited by the admin app.
export type OrderStatus = 'pending_payment' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'payment_failed' | 'refunded';
export type PaymentStatus = 'unpaid' | 'pending' | 'authorized' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
export interface OrdersTable {
  id: Generated<string>; order_number: Generated<string>;
  user_id: string | null;                // legacy Supabase owner (fixtures / pre-M7); platform orders use customer_id (M7)
  customer_id: string | null; cart_id: string | null; idempotency_key: string | null;
  status: Generated<OrderStatus>; payment_status: PaymentStatus | null; currency: Generated<string>;
  // Amounts are fixed when the order is created and never updated.
  subtotal_paise: ColumnType<number, number, never>; discount_paise: ColumnType<number, number | undefined, never>;
  shipping_paise: ColumnType<number, number | undefined, never>; tax_paise: ColumnType<number, number | undefined, never>;
  total_paise: ColumnType<number, number, never>; prices_include_tax: ColumnType<boolean, boolean | undefined, never>;
  pricing: ColumnType<unknown, string | undefined, never>;   // how tax, shipping and discounts were worked out
  contact: ColumnType<unknown, string, never>; shipping_address: ColumnType<unknown, string, never>;
  razorpay_order_id: string | null; razorpay_payment_id: string | null; paid_at: Timestamp | null; payment_expires_at: Timestamp | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
/** Snapshot of what was bought, at the price paid. Read-only to the admin app. */
export interface OrderItemsTable {
  id: Generated<string>; order_id: string; product_id: string | null; variant_id: string | null; sku: string; name: string; size: string;
  image_path: string | null; unit_price_paise: number; qty: number; line_total_paise: number;
}
export interface OrderStatusHistoryTable {
  id: Generated<number>; order_id: string; from_status: OrderStatus | null; to_status: OrderStatus;
  changed_by: string | null; note: string | null; created_at: Generated<Timestamp>;
}
export type PaymentRecordStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
export interface PaymentsTable {
  id: Generated<string>; order_id: string; provider: string; provider_order_id: string | null; provider_payment_id: string | null; amount_paise: number;
  currency: Generated<string>; status: Generated<PaymentRecordStatus>; method: string | null;
  failure_reason: string | null; raw: ColumnType<unknown, string | undefined, string | undefined>; captured_at: Timestamp | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
/** Razorpay webhook events: the event id is the primary key, so each event is stored (and processed) once. */
export interface PaymentEventsTable {
  id: string; provider: Generated<string>; type: string; payload: ColumnType<unknown, string, never>; order_id: string | null;
  outcome: string | null; received_at: Generated<Timestamp>; processed_at: Timestamp | null;
}
// Carts (M2 tables, used from M7). A signed-in customer has at most one active cart.
export type CartStatus = 'active' | 'converted' | 'merged' | 'abandoned';
export interface CartsTable {
  id: Generated<string>; customer_id: string | null; guest_token_hash: Buffer | null; status: Generated<CartStatus>;
  currency: Generated<string>; expires_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface WishlistsTable { id: Generated<string>; customer_id: string; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp> }
export interface WishlistItemsTable {
  id: Generated<string>; wishlist_id: string | null; user_id: string | null; product_id: string; created_at: Generated<Timestamp>;
}
export interface CartItemsTable {
  id: Generated<string>; cart_id: string | null; user_id: string | null; variant_id: string; qty: number;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
/** Tax configuration (M2). Basis points: 1800 = 18 %. is_inclusive: the rate is already inside the listed price. */
export interface TaxRatesTable {
  id: Generated<string>; code: string; label: string; rate_bp: number; is_inclusive: boolean; is_active: boolean;
  valid_from: Date; valid_to: Date | null;
}
/** Refund records. M8 uses a 'requested' row to record (ERP module 3 adds return refunds, provider or manual)
    that money received for an already-cancelled order needs a manual refund (payment exception). */
export interface RefundsTable {
  id: Generated<string>; payment_id: string; order_id: string; amount_paise: number; reason: Generated<string>;
  status: Generated<'requested' | 'pending' | 'processed' | 'failed'>; provider_refund_id: string | null; requested_by: string | null;
  processed_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
// Fulfilment (M8). The order status is the status; a shipment holds the delivery details.
export type PackingState = 'not_started' | 'packing' | 'packed';
export interface ShipmentsTable {
  id: Generated<string>; order_id: string; carrier_code: Generated<string>; tracking_number: string | null;
  packing_state: Generated<PackingState>; shipped_at: Timestamp | null; delivered_at: Timestamp | null;
  created_by: string | null; updated_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface CustomerSummaryView {
  customer_id: string; email: string; full_name: string | null; status: CustomerStatus; created_at: Timestamp; last_login_at: Timestamp | null;
  orders_count: number; paid_orders_count: number; lifetime_value_paise: number; last_order_at: Timestamp | null;
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
  product_relations: ProductRelationsTable;
  reviews: ReviewsTable;
  vendors: VendorsTable;
  materials: MaterialsTable;
  purchase_orders: PurchaseOrdersTable;
  purchase_order_lines: PurchaseOrderLinesTable;
  goods_receipts: GoodsReceiptsTable;
  goods_receipt_lines: GoodsReceiptLinesTable;
  material_movements: MaterialMovementsTable;
  production_orders: ProductionOrdersTable;
  production_inputs: ProductionInputsTable;
  qc_results: QcResultsTable;
  stock_counts: StockCountsTable;
  stock_count_lines: StockCountLinesTable;
  variant_costs: VariantCostsTable;
  notification_log: NotificationLogTable;
  customer_notes: CustomerNotesTable;
  site_content: SiteContentTable;
  staff_mfa: StaffMfaTable;
  staff_mfa_recovery_codes: StaffMfaRecoveryCodesTable;
  review_photos: ReviewPhotosTable;
  attributes: AttributesTable;
  attribute_values: AttributeValuesTable;
  product_attribute_values: ProductAttributeValuesTable;
  products: ProductsTable;
  product_variants: ProductVariantsTable;
  product_images: ProductImagesTable;
  inventory_reasons: InventoryReasonsTable;
  inventory_movements: InventoryMovementsTable;
  v_inventory_status: InventoryStatusView;
  customers: CustomersTable;
  customer_sessions: CustomerSessionsTable;
  addresses: AddressesTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  order_status_history: OrderStatusHistoryTable;
  payments: PaymentsTable;
  payment_events: PaymentEventsTable;
  carts: CartsTable;
  cart_items: CartItemsTable;
  refunds: RefundsTable;
  shipments: ShipmentsTable;
  v_customer_summary: CustomerSummaryView;
  tax_rates: TaxRatesTable;
  wishlists: WishlistsTable;
  wishlist_items: WishlistItemsTable;
  invoices: InvoicesTable;
  v_sales_daily: SalesDailyView;
  v_low_stock: LowStockView;
}

// ============================== ERP modules 1–8 (migrations 20260930002900 … 003600) ==============================
// Declaration merging: the interfaces below add the new columns to existing tables and the new tables to Database.
type TextArray = ColumnType<string[], string[] | undefined, string[]>;

export interface ProductsTable { compare_at_paise: number | null; tax_rate_code: string | null }
export interface ProductVariantsTable { compare_at_paise: number | null }
export interface CartsTable { coupon_code: string | null }
export interface RefundsTable {
  return_id: string | null; method: 'provider' | 'manual' | null; reference: string | null; failure_reason: string | null; processed_by: string | null;
}
export type ShipmentStatus = 'pending' | 'processing' | 'packed' | 'shipped' | 'in_transit' | 'delivered' | 'failed_delivery' | 'cancelled';
export interface ShipmentsTable {
  status: Generated<ShipmentStatus>; tracking_url: string | null; label: JsonWithDefault; courier_response: JsonNullable;
  in_transit_at: Timestamp | null; failed_at: Timestamp | null; failure_reason: string | null; cancelled_at: Timestamp | null;
}
export interface InvoicesTable {
  billing_address: JsonWithDefault; seller_details: JsonWithDefault; notes: string | null; voided_at: Timestamp | null; void_reason: string | null;
  created_by: string | null; currency: Generated<string>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
  shipping_address: JsonWithDefault; discount_paise: Generated<number>; shipping_paise: Generated<number>; place_of_supply: string | null; tax_split: JsonWithDefault;
}
export interface InvoiceItemsTable {
  id: Generated<string>; invoice_id: string; order_item_id: string | null; position: Generated<number>; description: string; sku: string | null;
  hsn_code: string | null; qty: number; unit_price_paise: number; tax_rate_id: string | null; tax_rate_bp: Generated<number>; tax_paise: Generated<number>;
  line_total_paise: number;
}

// 8 — notifications
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export interface StaffNotificationsTable {
  id: Generated<string>; kind: string; severity: Generated<NotificationSeverity>; title: string; body: string | null; entity_type: string | null;
  entity_id: string | null; link: string | null; permission: string; dedupe_key: string | null; created_at: Generated<Timestamp>;
}
export interface StaffNotificationReadsTable { notification_id: string; staff_user_id: string; read_at: Generated<Timestamp> }

// 1 — pricing & discounts
export interface PriceHistoryTable {
  id: Generated<string>; product_id: string; variant_id: string | null; field: 'price' | 'compare_at'; old_paise: number | null; new_paise: number | null;
  source: 'manual' | 'bulk' | 'scheduled'; change_id: string | null; staff_user_id: string | null; created_at: Generated<Timestamp>;
}
export type PriceChangeStatus = 'scheduled' | 'applied' | 'cancelled' | 'failed';
export interface PriceChangesTable {
  id: Generated<string>; product_id: string; variant_id: string | null; new_price_paise: number | null; new_compare_at_paise: number | null;
  clear_compare_at: Generated<boolean>; effective_at: Timestamp; status: Generated<PriceChangeStatus>; note: string | null; failure_reason: string | null;
  created_by: string | null; created_at: Generated<Timestamp>; applied_at: Timestamp | null; cancelled_at: Timestamp | null;
}
export type DiscountKind = 'percent' | 'fixed';
export type DiscountScope = 'order' | 'products' | 'categories' | 'collections';
export interface DiscountsTable {
  id: Generated<string>; name: string; code: string | null; kind: DiscountKind; value: number; scope: Generated<DiscountScope>;
  product_ids: TextArray; category_ids: TextArray; collection_ids: TextArray; min_order_paise: number | null; max_discount_paise: number | null;
  starts_at: Timestamp | null; ends_at: Timestamp | null; is_active: Generated<boolean>; usage_limit: number | null; per_customer_limit: number | null;
  campaign_id: string | null; created_by: string | null; updated_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface DiscountRedemptionsTable {
  id: Generated<string>; discount_id: string; order_id: string; customer_id: string | null; code: string | null; amount_paise: number; created_at: Generated<Timestamp>;
}

// 2 — shipping
export interface ShippingZonesTable {
  id: Generated<string>; name: string; states: TextArray; pin_prefixes: TextArray; is_active: Generated<boolean>; sort_order: Generated<number>;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface ShippingRatesTable {
  id: Generated<string>; zone_id: string; name: string; amount_paise: number; free_from_paise: number | null; min_order_paise: number | null;
  max_order_paise: number | null; cod_allowed: Generated<boolean>; cod_fee_paise: number | null; est_days_min: number | null; est_days_max: number | null;
  is_active: Generated<boolean>; sort_order: Generated<number>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface CouriersTable {
  code: string; name: string; mode: Generated<'manual' | 'api'>; tracking_url_template: string | null; is_active: Generated<boolean>; notes: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface ShipmentEventsTable {
  id: Generated<string>; shipment_id: string; status: string; note: string | null; source: Generated<'staff' | 'courier' | 'system'>;
  staff_user_id: string | null; created_at: Generated<Timestamp>;
}

// 3 — returns & refunds
export type ReturnStatus = 'requested' | 'under_review' | 'info_requested' | 'approved' | 'rejected' | 'pickup_scheduled' | 'picked_up' | 'received'
  | 'inspection' | 'refund_pending' | 'refunded' | 'exchange_pending' | 'exchanged' | 'completed' | 'cancelled';
export interface ReturnReasonsTable { code: string; label: string; sort_order: Generated<number>; is_active: Generated<boolean> }
export interface ReturnRequestsTable {
  id: Generated<string>; number: Generated<string>; order_id: string; customer_id: string | null; status: Generated<ReturnStatus>;
  resolution: 'refund' | 'exchange' | null; reason_code: string; description: string | null; staff_note: string | null; pickup_at: Timestamp | null;
  pickup_ref: string | null; received_at: Timestamp | null; inspection_result: 'ok' | 'damaged' | 'not_returnable' | null; inspection_note: string | null;
  refund_amount_paise: number | null; requested_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; completed_at: Timestamp | null;
}
export interface ReturnItemsTable {
  id: Generated<string>; return_id: string; order_item_id: string; qty: number; restock: Generated<boolean>; restocked_qty: Generated<number>;
  exchange_variant_id: string | null;
}
export interface ReturnEventsTable {
  id: Generated<string>; return_id: string; from_status: string | null; to_status: string; note: string | null;
  actor_type: 'customer' | 'staff' | 'system'; staff_user_id: string | null; created_at: Generated<Timestamp>;
}

// 4 — marketing
export interface CampaignsTable {
  id: Generated<string>; name: string; description: string | null; starts_at: Timestamp | null; ends_at: Timestamp | null; is_active: Generated<boolean>;
  product_ids: TextArray; collection_ids: TextArray; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface BannersTable {
  id: Generated<string>; placement: 'home' | 'shop'; heading: string; body: string | null; cta_label: string | null; link: string | null;
  image_path: string | null; starts_at: Timestamp | null; ends_at: Timestamp | null; is_active: Generated<boolean>; sort_order: Generated<number>;
  campaign_id: string | null; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface CustomerSegmentsTable {
  id: Generated<string>; name: string; description: string | null; rules: JsonWithDefault; created_by: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}

// 5 — support
export type TicketStatus = 'open' | 'assigned' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export interface SupportCategoriesTable { code: string; label: string; sort_order: Generated<number>; is_active: Generated<boolean> }
export interface SupportTicketsTable {
  id: Generated<string>; number: Generated<string>; customer_id: string | null; contact_email: string; contact_name: string | null; order_id: string | null;
  subject: string; category_code: string; priority: Generated<TicketPriority>; status: Generated<TicketStatus>; assigned_to: string | null;
  channel: Generated<'store' | 'staff'>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; resolved_at: Timestamp | null;
  closed_at: Timestamp | null; last_customer_reply_at: Timestamp | null; last_staff_reply_at: Timestamp | null;
}
export interface SupportMessagesTable {
  id: Generated<string>; ticket_id: string; author_type: 'customer' | 'staff' | 'system'; staff_user_id: string | null; customer_id: string | null;
  body: string; is_internal: Generated<boolean>; created_at: Generated<Timestamp>;
}

// 6 — finance
export interface FinanceNotesTable {
  id: Generated<string>; kind: 'credit' | 'debit'; number: string | null; invoice_id: string | null; order_id: string | null; refund_id: string | null;
  reason: string; amount_paise: number; tax_paise: Generated<number>; note_date: Generated<Date>; status: Generated<'draft' | 'issued' | 'void'>;
  created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface ExpenseCategoriesTable { code: string; label: string; sort_order: Generated<number>; is_active: Generated<boolean> }
export interface ExpensesTable {
  id: Generated<string>; category_code: string; amount_paise: number; tax_paise: Generated<number>; vendor_id: string | null; expense_date: Date | string;
  description: string; reference: string | null; voided_at: Timestamp | null; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export type VendorPaymentMethod = 'bank_transfer' | 'upi' | 'cheque' | 'cash' | 'card' | 'other';
export interface VendorPaymentsTable {
  id: Generated<string>; vendor_id: string; purchase_order_id: string | null; amount_paise: number; status: Generated<'scheduled' | 'paid' | 'void'>;
  paid_on: Date | string | null; method: VendorPaymentMethod | null; reference: string | null; notes: string | null; created_by: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}

// 7 — carts
export interface CartRecoveryTable {
  cart_id: string; status: Generated<'open' | 'emailed' | 'recovered' | 'dismissed'>; campaign_id: string | null; emailed_at: Timestamp | null;
  email_count: Generated<number>; note: string | null; updated_by: string | null; updated_at: Generated<Timestamp>;
}

export interface Database {
  invoice_items: InvoiceItemsTable;
  staff_notifications: StaffNotificationsTable; staff_notification_reads: StaffNotificationReadsTable;
  price_history: PriceHistoryTable; price_changes: PriceChangesTable; discounts: DiscountsTable; discount_redemptions: DiscountRedemptionsTable;
  shipping_zones: ShippingZonesTable; shipping_rates: ShippingRatesTable; couriers: CouriersTable; shipment_events: ShipmentEventsTable;
  return_reasons: ReturnReasonsTable; return_requests: ReturnRequestsTable; return_items: ReturnItemsTable; return_events: ReturnEventsTable;
  campaigns: CampaignsTable; banners: BannersTable; customer_segments: CustomerSegmentsTable;
  support_categories: SupportCategoriesTable; support_tickets: SupportTicketsTable; support_messages: SupportMessagesTable;
  finance_notes: FinanceNotesTable; expense_categories: ExpenseCategoriesTable; expenses: ExpensesTable; vendor_payments: VendorPaymentsTable;
  cart_recovery: CartRecoveryTable;
}
