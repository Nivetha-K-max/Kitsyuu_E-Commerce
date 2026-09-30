/* @kitsyuu/core: server-only business logic shared by the KITSYUU apps. Apps call these services; they never query
   the database for business operations themselves. */
if (typeof window !== 'undefined') throw new Error('@kitsyuu/core is server-only and must never be imported by browser code');

export { listStaff, getStaff, inviteStaff, resendInvite, updateStaff, setStaffRoles, setStaffStatus, revokeStaffSessions, type StaffRow, type MutationContext } from './staff.ts';
export { listRoles, getRole, listPermissions, createRole, updateRole, deleteRole, type RoleRow } from './roles.ts';
export { listAudit, recentAudit, auditCount, AUDIT_PAGE_SIZE } from './audit.ts';
export { getDashboard, dashboardTrends, TREND_DAYS, type TrendPoint, type PeriodTotals } from './dashboard.ts';
export { listCategories, listProducts, getProduct, updateProduct, setProductStatus, updateProductPrice, type ProductListRow } from './products.ts';
export { listStock, listAdjustmentReasons, adjustStock } from './inventory.ts';
export { listOrders, getOrder, updateOrderStatus, exportOrders, ORDER_PAGE_SIZE, ORDER_EXPORT_MAX_ROWS } from './orders.ts';
export { assertAdministrationRemains, assertHoldsAll, assertOutranksOrEqual } from './guards.ts';
export { createProduct, setNewArrival, moveNewArrival, NEW_ARRIVALS } from './products.ts';
export { addVariant, updateVariant, moveVariant } from './variants.ts';
export {
  listAttributes, createAttribute, updateAttribute, setAttributeActive, setAttributeValueActive, moveAttribute, addAttributeValue, renameAttributeValue, moveAttributeValue,
  deleteAttributeValue, getProductAttributes, setProductAttributes, type AttributeRow,
} from './attributes.ts';
export { listCategoryTree, createCategory, updateCategory, setCategoryActive, moveCategory } from './categories.ts';
export { uploadProductImage, setPrimaryImage, updateImageAlt, moveImage, removeImage, processImage, sniffImageType } from './images.ts';
export { supabaseStorage, localStorage, type ObjectStorage } from './storage.ts';
export {
  getCustomerProfile, updateCustomerProfile, listCustomerAddresses, getCustomerAddress, saveCustomerAddress, setDefaultCustomerAddress,
  deleteCustomerAddress, listCustomerOrders, getCustomerOrder,
  type CustomerProfile, type CustomerAddress, type CustomerOrderSummary, type CustomerOrderDetail,
} from './customer-account.ts';
// ---------- M7: core commerce ----------
export { applyOrderTransition, lockOrder, releaseOrderStock } from './order-state.ts';
export {
  priceOrder, currentTaxRate, unconfiguredShipping, defaultCommerceConfig,
  type CartTotals, type CommerceConfig, type ShippingProvider, type ShippingQuote, type DiscountRule, type DiscountLine, type TaxRate, type ShipTo, type DeliveryOption,
} from './pricing.ts';
export {
  getCustomerCart, addCartLine, setCartLineQty, removeCartLine, mergeGuestCart, priceCart, lineProblemText,
  type PricedCart, type PricedLine, type LineProblem,
} from './cart.ts';
export { getWishlist, setWishlisted, mergeGuestWishlist } from './wishlist.ts';
export {
  placeOrder, preparePayment, submitPaymentResult, cancelOrderByCustomer, expireUnpaidOrders, handlePaymentWebhook,
  applyPaymentResult, checkoutSettings, customerOrderActions, currentPaymentSession, type PaymentStart, type PaymentOutcome,
} from './checkout.ts';
export { orderConfirmationEmail } from './notifications.ts';
export type { PaymentProvider, ProviderPayment, PaymentSession, PaymentOrderInfo, ProviderPaymentStatus, ProviderRefund } from './payments/provider.ts';
export { testPaymentProvider, type TestPaymentProvider } from './payments/test-provider.ts';
export { razorpayProvider, type RazorpayConfig } from './payments/razorpay.ts';
// ---------- M8: operations ----------
export { listCustomers, getCustomer, setCustomerStatus, updateCustomerContact, CUSTOMER_PAGE_SIZE } from './customers.ts';
export {
  listPayments, listPaymentEvents, listPaymentExceptions, getPaymentExceptions, recordManualRefund, cancelledOrderPaymentState, reconcileOrderPayments,
  PAYMENT_PAGE_SIZE, type PaymentException, type ReconciliationRow,
} from './payments-admin.ts';
export { listSettings, updateSetting, companyDetails, SETTINGS_REGISTRY, POLICY_NOTES, type SettingDef, type SettingRow, type SettingType, type CompanyDetails } from './settings.ts';
export { getShipment, setPackingState, updateShipmentTracking, type ShipmentView } from './fulfilment.ts';
export { availableCarriers, carrierFor, manualCarrier, resolveCarrier, listActiveCarriers, trackingFromTemplate, type CarrierProvider } from './fulfilment/carrier.ts';
// ---------- M9: operations hardening ----------
export { pingDatabase, checkoutRateLimit, getSystemStatus, listSignIns, SIGNIN_PAGE_SIZE, CHECKOUT_RATE_KEY, type RuntimeInfo } from './system.ts';
export { settingsShipping, readShippingSettings, quoteFromSettings, SHIPPING_KEYS, type ShippingSettings } from './shipping.ts';
// ---------- M11: merchandising ----------
export {
  listCollections, listCollectionGroups, createCollectionGroup, getProductCollections, setProductCollections, getCollection, createCollection, updateCollection, setCollectionActive, moveCollection, setCollectionMember, moveCollectionMember,
  listRelated, setRelated, moveRelated, bulkSetProductStatus, MAX_RELATED,
} from './merchandising.ts';
// ---------- M12: reviews ----------
export {
  reviewEligibility, customerReviewState, submitReview, processReviewPhoto, approvedReviews, ratingSummary, reviewPhoto, listReviews, moderateReview,
  REVIEW_ELIGIBILITY_KEY, REVIEW_MAX_PHOTOS, type ReviewEligibility,
} from './reviews.ts';
// ---------- M13: vendors, materials, purchasing ----------
export {
  listVendors, saveVendor, setVendorActive, listMaterials, saveMaterial, adjustMaterialStock, materialLedger, materialMovements,
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, createPurchaseOrderWithLines, setPoLine, removePoLine, setPurchaseOrderStatus, receiveGoods, PO_TRANSITIONS, type PoStatus,
} from './procurement.ts';
// ---------- M14: production and quality control ----------
export {
  listProductionOrders, getProductionOrder, createProductionOrder, setProductionInput, consumeMaterial, setProductionStatus, recordQualityCheck,
  listProducibleVariants, PRODUCTION_TRANSITIONS, type ProductionStatus,
} from './production.ts';
// ---------- M15: stock counts and stock value ----------
export { listStockCounts, openStockCount, getStockCount, recordCounts, postStockCount, cancelStockCount, setVariantCost, stockValue } from './stock-count.ts';
// ---------- M16: reports ----------
export {
  salesReport, productReport, inventoryReport, customerReport, purchasingReport, productionReport, exportReport, REPORTS, SOLD_STATUSES,
  type ReportKind, type ReportRange,
} from './reports.ts';
// ---------- M17: notifications, store content, customer service ----------
export {
  orderEmailEnabled, orderStatusEmail, notifyOrderStatus, listNotificationLog, getAnnouncementAdmin, saveAnnouncement, unpublishAnnouncement,
  listCustomerNotes, addCustomerNote, customerBasket, ANNOUNCEMENT_KEY, type Announcement, type OrderEmailEvent,
} from './engagement.ts';
// ---------- M18: search, security ----------
export { globalSearch, type SearchGroup, type SearchHit } from './search.ts';
export { securityAlerts } from './system.ts';
export { resetStaffTwoFactor } from './staff.ts';
export { attentionSummary, type AttentionItem } from './attention.ts';
// ---------- ERP module 8: notifications and alerts ----------
export {
  ALERT_KINDS, raiseStaffAlert, raiseAlertSafely, sweepConditionAlerts, sweepConditionAlertsThrottled, listStaffNotifications, unreadNotifications,
  markNotificationsRead, NOTIFICATION_PAGE_SIZE, type AlertKindCode, type AlertSeverity,
} from './alerts.ts';
export { CUSTOMER_EMAILS, customerEmailEnabled, sendCustomerEmail, type CustomerEmailEvent, type EmailResult } from './customer-email.ts';
// ---------- ERP module 1: pricing and discounts ----------
export {
  listProductPrices, getProductPricing, priceHistory, setProductPricing, schedulePriceChange, cancelPriceChange, listScheduledChanges,
  applyDuePriceChanges, bulkUpdatePrices, pricingOverview, PRICING_PAGE_SIZE,
} from './pricing-admin.ts';
export {
  discountSettings, discountAmount, databaseDiscounts, setCartCoupon, recordDiscountRedemptions, listDiscounts, saveDiscount, setDiscountActive,
  discountRedemptions, promotionTargets,
} from './discounts.ts';
export type { DiscountSource, CouponState } from './pricing.ts';
// ---------- ERP module 2: shipping ----------
export { quoteFromZoneRates, quoteFromZones, activeZoneRates, matchZone, type ZoneRate } from './shipping.ts';
export {
  listShippingZones, saveShippingZone, saveShippingRate, deleteShippingRate, checkShippingQuote, listCouriers, saveCourier, listShipments,
  getShipmentDetail, updateShipmentStatus, shippingReport, notifyOrderDelivered, SHIPMENT_MOVES, SHIPMENT_PAGE_SIZE,
} from './shipping-admin.ts';
// ---------- ERP module 3: returns and refunds ----------
export {
  returnSettings, customerReturnOptions, requestReturn, listCustomerReturns, getCustomerReturn, cancelReturnByCustomer, listReturns, getReturn, returnAction,
  updateReturnItem, refundReturn, notifyReturn, returnsReport, actionsFor as returnActionsFor, RETURN_FLOW, RETURN_PAGE_SIZE,
} from './returns.ts';
// ---------- ERP module 4: marketing ----------
export {
  listCampaigns, saveCampaign, setCampaignActive, listBanners, saveBanner, setBannerActive, listSegments, saveSegment, deleteSegment, segmentMembers,
  getSegment, promotionReport,
} from './marketing.ts';
// ---------- ERP module 5: support ----------
export {
  supportCategories, openCustomerTicket, listCustomerTickets, getCustomerTicket, replyAsCustomer, listTickets, getTicket, openStaffTicket, replyToTicket,
  updateTicket, notifyTicketReply, supportReport, TICKET_PAGE_SIZE,
} from './support.ts';
// ---------- ERP module 6: finance ----------
export {
  listTaxRates, saveTaxRate, listProductTax, setProductTax, taxSplit, listInvoices, ordersWithoutInvoice, createInvoiceForOrder, voidInvoice, getInvoice,
  listFinanceNotes, createFinanceNote, setFinanceNoteStatus, expenseCategories, listExpenses, saveExpense, voidExpense, listVendorPayments, saveVendorPayment,
  financeSummary, reconciliation, exportFinance, financeLookups, companyState, FINANCE_EXPORTS, type FinanceExport,
} from './finance.ts';
// ---------- ERP module 7: carts and wishlists ----------
export { abandonAfterHours, listCarts, getCart, setCartRecovery, sendCartReminder, wishlistReport, listWishlists, CART_PAGE_SIZE } from './carts-admin.ts';
// ---------- client change request, first pass ----------
export { effectivePrice, effectivePriceSql, basePriceSql, saleRunningSql, setProductSale, maxSaleDiscountPercent, type SaleInput } from './sale.ts';
export { bulkEditProducts, BULK_MAX_PRODUCTS, type BulkAction } from './bulk-products.ts';
export { setProductCategory } from './products.ts';
export { abandonedCheckoutHours, listAbandonedCheckouts, sendAbandonedCheckoutReminders, ABANDONED_CHECKOUT_DEFAULT_HOURS, type ReminderRun } from './checkout-reminders.ts';
export {
  subscribeNewsletter, unsubscribeByToken, rotateUnsubscribeToken, listSubscribers, unsubscribeSubscriber, exportSubscribers, NEWSLETTER_CONSENT, SUBSCRIBER_PAGE_SIZE,
} from './newsletter.ts';
export { parseSizeChartTable, sizeChartTableText, listSizeCharts, saveSizeChart, sizeChartForProduct, type SizeChart, type SizeChartRow } from './size-charts.ts';
export { productionMaterialNeeds, procurementStatus, type ProcurementStatus, purchaseOrderProduction, raisePurchaseOrderForProduction } from './production-purchasing.ts';
export { BRAND_COPY_KEY, BRAND_COPY_FIELDS, BRAND_COPY_DEFAULTS, mergeBrandCopy, getBrandCopyAdmin, saveBrandCopy, type BrandCopy, type BrandCopyKey } from './site-copy.ts';
export { cartRefreshMinutes, CART_REFRESH_DEFAULT_MINUTES } from './cart.ts';
// ---------- client change request, second pass ----------
export { readCodSettings, codQuote, codQuoteFrom, recordCodCollected, cancelCodOrder, orderCodState, COD_KEYS, type CodQuote, type CodSettings } from './cod.ts';
export {
  readLoyaltySettings, quoteLoyalty, pointsForAmount, loyaltyBalance, adjustLoyaltyPoints, parseLoyaltyImport, importLoyaltyPoints, expireLoyaltyPoints,
  getMyLoyalty, getCustomerLoyalty, listLoyaltyAccounts, LOYALTY_KEYS, LOYALTY_KIND_LABELS, LOYALTY_IMPORT_MAX_LINES, type LoyaltyQuote, type LoyaltySettings,
} from './loyalty.ts';
export { editOrder, orderEditBlocker, orderEditOptions, listOrderEdits, refundOrderEdit } from './order-edit.ts';
export type { PaymentChoice } from './pricing.ts';
