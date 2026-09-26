/* @kitsyuu/core: server-only business logic shared by the KITSYUU apps. Apps call these services; they never query
   the database for business operations themselves. */
if (typeof window !== 'undefined') throw new Error('@kitsyuu/core is server-only and must never be imported by browser code');

export { listStaff, getStaff, inviteStaff, resendInvite, updateStaff, setStaffRoles, setStaffStatus, revokeStaffSessions, type StaffRow, type MutationContext } from './staff.ts';
export { listRoles, getRole, listPermissions, createRole, updateRole, deleteRole, type RoleRow } from './roles.ts';
export { listAudit, recentAudit, auditCount, AUDIT_PAGE_SIZE } from './audit.ts';
export { getDashboard } from './dashboard.ts';
export { listCategories, listProducts, getProduct, updateProduct, setProductStatus, updateProductPrice, type ProductListRow } from './products.ts';
export { listStock, listAdjustmentReasons, adjustStock } from './inventory.ts';
export { listOrders, getOrder, updateOrderStatus, ORDER_PAGE_SIZE } from './orders.ts';
export { assertAdministrationRemains, assertHoldsAll, assertOutranksOrEqual } from './guards.ts';
export { createProduct, setNewArrival, moveNewArrival, NEW_ARRIVALS } from './products.ts';
export { addVariant, updateVariant, moveVariant } from './variants.ts';
export { listCategoryTree, createCategory, updateCategory, setCategoryActive, moveCategory } from './categories.ts';
export { uploadProductImage, setPrimaryImage, updateImageAlt, moveImage, removeImage, processImage, sniffImageType } from './images.ts';
export { supabaseStorage, localStorage, type ObjectStorage } from './storage.ts';
