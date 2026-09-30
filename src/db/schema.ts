import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const sagaops = pgSchema("sagaops");

export const userRole = sagaops.enum("user_role", ["owner", "manager", "cashier_barista", "hr_admin"]);
export const recordStatus = sagaops.enum("record_status", ["active", "inactive", "archived"]);
export const productStatus = sagaops.enum("product_status", ["draft", "active", "inactive", "archived"]);
export const productType = sagaops.enum("product_type", ["recipe_product", "stock_item_product", "bundle_product"]);
export const baseUnit = sagaops.enum("base_unit", ["gram", "ml", "pcs"]);
export const orderStatus = sagaops.enum("order_status", ["draft", "paid", "voided", "refunded", "partially_refunded"]);
export const orderType = sagaops.enum("order_type", ["dine_in", "takeaway", "delivery_manual"]);
export const paymentMethodType = sagaops.enum("payment_method_type", [
  "cash",
  "qris_manual",
  "transfer",
  "debit_card",
  "e_wallet",
  "other",
]);
export const paymentStatus = sagaops.enum("payment_status", ["paid", "voided", "refunded", "partially_refunded"]);
export const inventoryMovementType = sagaops.enum("inventory_movement_type", [
  "opening_stock",
  "purchase_received",
  "sale_consumption",
  "waste",
  "internal_usage",
  "adjustment_positive",
  "adjustment_negative",
  "stock_opname_correction",
]);
export const purchaseOrderStatus = sagaops.enum("purchase_order_status", [
  "draft",
  "ordered",
  "partially_received",
  "received",
  "cancelled",
]);
export const cashSessionStatus = sagaops.enum("cash_session_status", ["open", "closing", "closed", "approved"]);
export const approvalStatus = sagaops.enum("approval_status", ["pending", "approved", "rejected", "cancelled"]);
export const syncStatus = sagaops.enum("sync_status", ["synced", "pending_sync", "failed"]);
export const expenseSource = sagaops.enum("expense_source", ["cash_drawer", "owner_transfer", "external_petty_cash", "other"]);
export const staffRole = sagaops.enum("staff_role", ["cashier", "barista", "manager", "kitchen", "hr", "other"]);
export const rateType = sagaops.enum("rate_type", ["per_shift", "per_hour", "monthly_allocation"]);
export const attendanceStatus = sagaops.enum("attendance_status", [
  "present",
  "late",
  "absent",
  "sick",
  "leave",
  "incomplete",
  "manually_corrected",
  "unscheduled",
]);
export const payrollAdjustmentType = sagaops.enum("payroll_adjustment_type", ["bonus", "deduction", "kasbon", "correction", "overtime"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const archivedAt = () => timestamp("archived_at", { withTimezone: true });
const rupiah = (name: string) => integer(name).notNull().default(0);
const qty = (name: string) => numeric(name, { precision: 14, scale: 3 }).notNull().default("0");

export const organizations = sagaops.table("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  ownerAuthUserId: uuid("owner_auth_user_id"),
  status: recordStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: archivedAt(),
});

export const outlets = sagaops.table(
  "outlets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    timezone: text("timezone").notNull().default("Asia/Jakarta"),
    address: text("address"),
    phone: text("phone"),
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    serviceRateBps: integer("service_rate_bps").notNull().default(0),
    priceTaxInclusive: boolean("price_tax_inclusive").notNull().default(true),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [unique("sagaops_outlets_org_code_unique").on(table.organizationId, table.code)],
);

export const userProfiles = sagaops.table("user_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  authUserId: uuid("auth_user_id").unique(),
  email: text("email").unique(),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  managerPinHash: text("manager_pin_hash"),
  status: recordStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outletUserRoles = sagaops.table(
  "outlet_user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    userProfileId: uuid("user_profile_id").notNull().references(() => userProfiles.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_outlet_roles_unique").on(table.organizationId, table.outletId, table.userProfileId, table.role)],
);

export const staffProfiles = sagaops.table(
  "staff_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "set null" }),
    userProfileId: uuid("user_profile_id").references(() => userProfiles.id, { onDelete: "set null" }),
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    role: staffRole("role").notNull(),
    pinHash: text("pin_hash"),
    hourlyRateRupiah: rupiah("hourly_rate_rupiah"),
    shiftRateRupiah: rupiah("shift_rate_rupiah"),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index("sagaops_staff_profiles_org_idx").on(table.organizationId),
    index("sagaops_staff_profiles_outlet_idx").on(table.outletId),
  ],
);

export const shiftTemplates = sagaops.table(
  "shift_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    gracePeriodMinutes: integer("grace_period_minutes").notNull().default(0),
    rateType: rateType("rate_type").notNull().default("per_shift"),
    rateAmountRupiah: rupiah("rate_amount_rupiah"),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [
    unique("sagaops_shift_templates_org_outlet_name_unique").on(table.organizationId, table.outletId, table.name),
    index("sagaops_shift_templates_org_outlet_idx").on(table.organizationId, table.outletId),
  ],
);

export const shiftSchedules = sagaops.table(
  "shift_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").notNull().references(() => staffProfiles.id, { onDelete: "cascade" }),
    shiftTemplateId: uuid("shift_template_id").references(() => shiftTemplates.id, { onDelete: "set null" }),
    businessDate: date("business_date").notNull(),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }).notNull(),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }).notNull(),
    shiftName: text("shift_name").notNull(),
    roleLabel: text("role_label"),
    gracePeriodMinutes: integer("grace_period_minutes").notNull().default(0),
    rateType: rateType("rate_type").notNull().default("per_shift"),
    rateAmountRupiah: rupiah("rate_amount_rupiah"),
    notes: text("notes"),
    status: text("status").notNull().default("scheduled"),
    createdByUserId: uuid("created_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("sagaops_shift_schedules_staff_time_idx").on(table.staffId, table.scheduledStartAt),
    index("sagaops_shift_schedules_outlet_time_idx").on(table.outletId, table.scheduledStartAt),
  ],
);

export const attendanceLogs = sagaops.table(
  "attendance_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").notNull().references(() => staffProfiles.id, { onDelete: "cascade" }),
    shiftScheduleId: uuid("shift_schedule_id").references(() => shiftSchedules.id, { onDelete: "set null" }),
    checkInAt: timestamp("check_in_at", { withTimezone: true }),
    checkOutAt: timestamp("check_out_at", { withTimezone: true }),
    status: attendanceStatus("status").notNull(),
    isUnscheduled: boolean("is_unscheduled").notNull().default(false),
    lateMinutes: integer("late_minutes").notNull().default(0),
    earlyLeaveMinutes: integer("early_leave_minutes").notNull().default(0),
    workedMinutes: integer("worked_minutes").notNull().default(0),
    overtimeCandidateMinutes: integer("overtime_candidate_minutes").notNull().default(0),
    approvedOvertimeMinutes: integer("approved_overtime_minutes").notNull().default(0),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("sagaops_attendance_logs_staff_time_idx").on(table.staffId, table.checkInAt),
    index("sagaops_attendance_logs_outlet_time_idx").on(table.outletId, table.checkInAt),
  ],
);

export const attendanceAdjustments = sagaops.table("attendance_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  attendanceLogId: uuid("attendance_log_id").notNull().references(() => attendanceLogs.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  approvedByUserId: uuid("approved_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  oldValues: jsonb("old_values").notNull().default({}),
  newValues: jsonb("new_values").notNull().default({}),
  reason: text("reason").notNull(),
  affectsPayroll: boolean("affects_payroll").notNull().default(false),
  payrollImpactMinutes: integer("payroll_impact_minutes").notNull().default(0),
  payrollImpactRupiah: integer("payroll_impact_rupiah").notNull().default(0),
  status: approvalStatus("status").notNull().default("pending"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});

export const payrollAdjustments = sagaops.table(
  "payroll_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").notNull().references(() => staffProfiles.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    businessDate: date("business_date").notNull(),
    type: payrollAdjustmentType("type").notNull(),
    amountRupiah: integer("amount_rupiah").notNull(),
    notes: text("notes").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    createdByUserId: uuid("created_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (table) => [index("sagaops_payroll_adjustments_staff_period_idx").on(table.staffId, table.periodStart, table.periodEnd)],
);

export const productCategories = sagaops.table(
  "product_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_product_categories_org_name_unique").on(table.organizationId, table.name)],
);

export const products = sagaops.table(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => productCategories.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    sku: text("sku"),
    productType: productType("product_type").notNull().default("recipe_product"),
    status: productStatus("status").notNull().default("draft"),
    priceRupiah: rupiah("price_rupiah"),
    isPinned: boolean("is_pinned").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [unique("sagaops_products_org_name_unique").on(table.organizationId, table.name)],
);

export const ingredients = sagaops.table(
  "ingredients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseUnit: baseUnit("base_unit").notNull(),
    costPerUnitRupiah: rupiah("cost_per_unit_rupiah"),
    lowThresholdQty: qty("low_threshold_qty"),
    criticalThresholdQty: qty("critical_threshold_qty"),
    parLevelQty: qty("par_level_qty"),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [unique("sagaops_ingredients_org_name_unique").on(table.organizationId, table.name)],
);

export const recipes = sagaops.table(
  "recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default Recipe"),
    status: recordStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_recipes_product_name_unique").on(table.productId, table.name)],
);

export const recipeItems = sagaops.table(
  "recipe_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
    ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
    qty: numeric("qty", { precision: 14, scale: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique("sagaops_recipe_items_unique").on(table.recipeId, table.ingredientId)],
);

export const paymentMethods = sagaops.table("payment_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  methodType: paymentMethodType("method_type").notNull(),
  status: recordStatus("status").notNull().default("active"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cashSessions = sagaops.table("cash_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  openedByUserId: uuid("opened_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  closedByUserId: uuid("closed_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  businessDate: date("business_date").notNull(),
  shiftName: text("shift_name").notNull(),
  status: cashSessionStatus("status").notNull().default("open"),
  openingCashRupiah: rupiah("opening_cash_rupiah"),
  expectedOpeningCashRupiah: rupiah("expected_opening_cash_rupiah"),
  openingVarianceRupiah: integer("opening_variance_rupiah").notNull().default(0),
  previousCashSessionId: uuid("previous_cash_session_id"),
  handoverStatus: text("handover_status").notNull().default("not_required"),
  expectedCashRupiah: integer("expected_cash_rupiah").notNull().default(0),
  actualCashRupiah: integer("actual_cash_rupiah"),
  cashToLeaveRupiah: rupiah("cash_to_leave_rupiah"),
  depositCashRupiah: integer("deposit_cash_rupiah"),
  varianceRupiah: integer("variance_rupiah"),
  varianceStatus: text("variance_status").notNull().default("info"),
  closingNote: text("closing_note"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const orders = sagaops.table("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  cashSessionId: uuid("cash_session_id").references(() => cashSessions.id, { onDelete: "set null" }),
  orderNumber: text("order_number").notNull(),
  orderType: orderType("order_type").notNull().default("dine_in"),
  status: orderStatus("status").notNull().default("draft"),
  subtotalRupiah: rupiah("subtotal_rupiah"),
  discountRupiah: rupiah("discount_rupiah"),
  taxRupiah: rupiah("tax_rupiah"),
  serviceRupiah: rupiah("service_rupiah"),
  totalRupiah: rupiah("total_rupiah"),
  totalHppRupiah: rupiah("total_hpp_rupiah"),
  hppSnapshotStatus: text("hpp_snapshot_status").notNull().default("unverified"),
  idempotencyKey: text("idempotency_key"),
  syncStatus: syncStatus("sync_status").notNull().default("synced"),
  sourceDeviceId: text("source_device_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  businessDate: date("business_date").notNull(),
  cashierUserId: uuid("cashier_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
}, (table) => [unique("sagaops_orders_outlet_business_date_number_unique").on(table.outletId, table.businessDate, table.orderNumber)]);

export const orderItems = sagaops.table("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  productNameSnapshot: text("product_name_snapshot").notNull(),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  unitPriceRupiah: integer("unit_price_rupiah").notNull(),
  lineTotalRupiah: integer("line_total_rupiah").notNull(),
  recipeCostSnapshotRupiah: rupiah("recipe_cost_snapshot_rupiah"),
  hppSnapshotStatus: text("hpp_snapshot_status").notNull().default("unverified"),
  recipeVersionSnapshot: integer("recipe_version_snapshot"),
  recipeSnapshotJson: jsonb("recipe_snapshot_json").notNull().default({}),
  note: text("note"),
  createdAt: createdAt(),
});

export const payments = sagaops.table("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
  methodNameSnapshot: text("method_name_snapshot").notNull(),
  methodType: paymentMethodType("method_type").notNull(),
  status: paymentStatus("status").notNull().default("paid"),
  amountRupiah: integer("amount_rupiah").notNull(),
  receivedRupiah: rupiah("received_rupiah"),
  changeRupiah: rupiah("change_rupiah"),
  settlementStatus: text("settlement_status").notNull().default("unchecked"),
  paymentFeeRupiah: rupiah("payment_fee_rupiah"),
  referenceNumber: text("reference_number"),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const inventoryBalances = sagaops.table("inventory_balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "cascade" }),
  qtyOnHand: qty("qty_on_hand"),
  stockValueRupiah: rupiah("stock_value_rupiah"),
  updatedAt: updatedAt(),
});

export const inventoryMovements = sagaops.table("inventory_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
  movementType: inventoryMovementType("movement_type").notNull(),
  qtyDelta: numeric("qty_delta", { precision: 14, scale: 3 }).notNull(),
  unit: baseUnit("unit").notNull(),
  unitCostRupiah: rupiah("unit_cost_rupiah"),
  valueDeltaRupiah: integer("value_delta_rupiah").notNull().default(0),
  balanceAfterQty: numeric("balance_after_qty", { precision: 14, scale: 3 }),
  referenceType: text("reference_type"),
  referenceId: uuid("reference_id"),
  referenceCode: text("reference_code"),
  note: text("note"),
  businessDate: date("business_date").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const suppliers = sagaops.table("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  phone: text("phone"),
  status: recordStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const purchaseOrders = sagaops.table("purchase_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
  poNumber: text("po_number").notNull(),
  status: purchaseOrderStatus("status").notNull().default("draft"),
  totalEstimatedRupiah: rupiah("total_estimated_rupiah"),
  orderedAt: timestamp("ordered_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const purchaseOrderItems = sagaops.table("purchase_order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseOrderId: uuid("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
  orderedQty: numeric("ordered_qty", { precision: 14, scale: 3 }).notNull(),
  receivedQty: qty("received_qty"),
  unit: baseUnit("unit").notNull(),
  unitCostRupiah: rupiah("unit_cost_rupiah"),
  estimatedTotalRupiah: rupiah("estimated_total_rupiah"),
  createdAt: createdAt(),
});

export const expenses = sagaops.table("expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  cashSessionId: uuid("cash_session_id").references(() => cashSessions.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  amountRupiah: integer("amount_rupiah").notNull(),
  reason: text("reason").notNull(),
  source: expenseSource("source").notNull().default("cash_drawer"),
  status: text("status").notNull().default("recorded"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  correctedExpenseId: uuid("corrected_expense_id"),
  createdByUserId: uuid("created_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const cashHandoverConfirmations = sagaops.table(
  "cash_handover_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
    previousCashSessionId: uuid("previous_cash_session_id").notNull().references(() => cashSessions.id, { onDelete: "cascade" }),
    nextCashSessionId: uuid("next_cash_session_id").notNull().references(() => cashSessions.id, { onDelete: "cascade" }),
    expectedOpeningCashRupiah: rupiah("expected_opening_cash_rupiah"),
    confirmedOpeningCashRupiah: rupiah("confirmed_opening_cash_rupiah"),
    varianceRupiah: integer("variance_rupiah").notNull().default(0),
    varianceStatus: text("variance_status").notNull().default("info"),
    note: text("note"),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [unique("sagaops_cash_handover_unique").on(table.previousCashSessionId, table.nextCashSessionId)],
);

export const dailyClosings = sagaops.table("daily_closings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  businessDate: date("business_date").notNull(),
  status: text("status").notNull().default("draft"),
  netSalesRupiah: rupiah("net_sales_rupiah"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalHppRupiah: rupiah("total_hpp_rupiah"),
  grossProfitRupiah: rupiah("gross_profit_rupiah"),
  totalExpenseRupiah: rupiah("total_expense_rupiah"),
  totalCashDrawerExpenseRupiah: rupiah("total_cash_drawer_expense_rupiah"),
  totalPurchaseReceivedRupiah: rupiah("total_purchase_received_rupiah"),
  totalWasteRupiah: rupiah("total_waste_rupiah"),
  cashVarianceRupiah: integer("cash_variance_rupiah").notNull().default(0),
  totalOpeningCashRupiah: rupiah("total_opening_cash_rupiah"),
  totalExpectedCashRupiah: rupiah("total_expected_cash_rupiah"),
  totalActualCashRupiah: rupiah("total_actual_cash_rupiah"),
  totalDepositCashRupiah: rupiah("total_deposit_cash_rupiah"),
  totalCashLeftRupiah: rupiah("total_cash_left_rupiah"),
  issueFlags: jsonb("issue_flags").notNull().default([]),
  snapshotJson: jsonb("snapshot_json").notNull().default({}),
  submittedByUserId: uuid("submitted_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  lockedByUserId: uuid("locked_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const approvals = sagaops.table("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
  actionType: text("action_type").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  status: approvalStatus("status").notNull().default("pending"),
  reason: text("reason"),
  metadata: jsonb("metadata").notNull().default({}),
  decisionNote: text("decision_note"),
  requestedByUserId: uuid("requested_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  approvedByUserId: uuid("approved_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const auditLogs = sagaops.table("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
  staffId: uuid("staff_id").references(() => staffProfiles.id, { onDelete: "set null" }),
  roleSnapshot: text("role_snapshot"),
  sourceDeviceId: text("source_device_id"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  detail: text("detail"),
  oldValues: jsonb("old_values").notNull().default({}),
  newValues: jsonb("new_values").notNull().default({}),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: createdAt(),
});

export const posCheckoutSubmissions = sagaops.table(
  "pos_checkout_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    status: syncStatus("status").notNull().default("synced"),
    requestHash: text("request_hash"),
    responseSnapshot: jsonb("response_snapshot").notNull().default({}),
    createdByUserId: uuid("created_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [unique("sagaops_pos_checkout_submissions_unique").on(table.outletId, table.idempotencyKey)],
);

export const posHppCatalogState = sagaops.table("pos_hpp_catalog_state", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").primaryKey().references(() => outlets.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  snapshot: jsonb("snapshot").notNull().default({}),
  updatedAt: updatedAt(),
});

export const setupWizardStates = sagaops.table(
  "setup_wizard_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("in_progress"),
    scorePct: integer("score_pct").notNull().default(0),
    checklistJson: jsonb("checklist_json").notNull().default({}),
    completedByUserId: uuid("completed_by_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_setup_wizard_states_unique").on(table.organizationId, table.outletId)],
);

export const posDevices = sagaops.table(
  "pos_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
    deviceCode: text("device_code").notNull(),
    name: text("name").notNull(),
    status: recordStatus("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    mode: text("mode"),
    operationalStatus: text("operational_status").notNull().default("pending"),
    appVersion: text("app_version"),
    credentialHash: text("credential_hash"),
    credentialRotatedAt: timestamp("credential_rotated_at", { withTimezone: true }),
    custodian: text("custodian"),
    capabilityManifest: jsonb("capability_manifest").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_pos_devices_outlet_code_unique").on(table.outletId, table.deviceCode)],
);

export const syncErrorLogs = sagaops.table(
  "sync_error_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    posDeviceId: uuid("pos_device_id").references(() => posDevices.id, { onDelete: "set null" }),
    sourceDeviceId: text("source_device_id"),
    severity: text("severity").notNull(),
    statusColor: text("status_color").notNull(),
    message: text("message").notNull(),
    technicalDetail: text("technical_detail"),
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("sagaops_sync_error_logs_outlet_time_idx").on(table.outletId, table.createdAt),
    index("sagaops_sync_error_logs_unresolved_idx").on(table.resolvedAt),
  ],
);

export const approvalPinAttempts = sagaops.table(
  "approval_pin_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    approverUserId: uuid("approver_user_id").references(() => userProfiles.id, { onDelete: "set null" }),
    sourceDeviceId: text("source_device_id"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("sagaops_approval_pin_attempts_user_idx").on(table.approverUserId, table.lastAttemptAt)],
);

export const productVariants = sagaops.table(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    priceDeltaRupiah: integer("price_delta_rupiah").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_product_variants_product_code_unique").on(table.productId, table.code)],
);

export const modifierGroups = sagaops.table("modifier_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  minimumSelections: integer("minimum_selections").notNull().default(0),
  maximumSelections: integer("maximum_selections").notNull().default(1),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const modifierOptions = sagaops.table(
  "modifier_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    modifierGroupId: uuid("modifier_group_id").notNull().references(() => modifierGroups.id, { onDelete: "cascade" }),
    code: text("code").notNull(), name: text("name").notNull(),
    priceDeltaRupiah: integer("price_delta_rupiah").notNull().default(0),
    stationRoute: text("station_route"), status: text("status").notNull().default("active"),
    createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_modifier_options_group_code_unique").on(table.modifierGroupId, table.code)],
);

export const productChannelAvailability = sagaops.table(
  "product_channel_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), available: boolean("available").notNull().default(true),
    pauseReason: text("pause_reason"), startsAt: timestamp("starts_at", { withTimezone: true }), endsAt: timestamp("ends_at", { withTimezone: true }),
    version: integer("version").notNull().default(1), updatedByUserId: uuid("updated_by_user_id").references(() => userProfiles.id), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_channel_availability_unique").on(table.outletId, table.productId, table.channel)],
);

export const deviceHeartbeats = sagaops.table("device_heartbeats", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  connectivity: text("connectivity").notNull(), printerStatus: text("printer_status"), nfcStatus: text("nfc_status"), kdsStatus: text("kds_status"),
  capabilityManifest: jsonb("capability_manifest").notNull().default({}), observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const promotionRules = sagaops.table(
  "promotion_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }),
    code: text("code").notNull(), name: text("name").notNull(), ruleType: text("rule_type").notNull(), rulePayload: jsonb("rule_payload").notNull(),
    priority: integer("priority").notNull().default(100), stackPolicy: text("stack_policy").notNull().default("exclusive"),
    startsAt: timestamp("starts_at", { withTimezone: true }), endsAt: timestamp("ends_at", { withTimezone: true }), status: text("status").notNull().default("draft"),
    createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_promotion_rules_org_code_unique").on(table.organizationId, table.code)],
);

export const paymentIntents = sagaops.table(
  "payment_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), providerReference: text("provider_reference"), amountRupiah: integer("amount_rupiah").notNull(), status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), paidAt: timestamp("paid_at", { withTimezone: true }),
    lastProviderSequence: integer("last_provider_sequence"), createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_payment_intents_org_key_unique").on(table.organizationId, table.idempotencyKey)],
);

export const fulfillmentTickets = sagaops.table(
  "fulfillment_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    station: text("station").notNull(), status: text("status").notNull().default("new"), payloadSnapshot: jsonb("payload_snapshot").notNull(), priority: integer("priority").notNull().default(100),
    prepStartedAt: timestamp("prep_started_at", { withTimezone: true }), readyAt: timestamp("ready_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_fulfillment_order_station_unique").on(table.orderId, table.station)],
);

export const printJobs = sagaops.table(
  "print_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    destination: text("destination").notNull(), payloadVersion: integer("payload_version").notNull().default(1), payloadSnapshot: jsonb("payload_snapshot").notNull(),
    status: text("status").notNull(), copyNumber: integer("copy_number").notNull().default(0), label: text("label").notNull().default("ORIGINAL"), attempts: integer("attempts").notNull().default(0),
    requestedByUserId: uuid("requested_by_user_id").references(() => userProfiles.id), reason: text("reason"), createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_print_jobs_order_destination_copy_unique").on(table.orderId, table.destination, table.copyNumber)],
);

export const rewardReservations = sagaops.table(
  "reward_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "cascade" }), orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    externalReservationId: text("external_reservation_id"), memberCodeHash: text("member_code_hash").notNull(), rewardId: text("reward_id").notNull(), status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [unique("sagaops_reward_reservations_org_key_unique").on(table.organizationId, table.idempotencyKey)],
);

export const operationalIncidents = sagaops.table("operational_incidents", {
  id: uuid("id").primaryKey().defaultRandom(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "cascade" }), severity: text("severity").notNull(), source: text("source").notNull(), summary: text("summary").notNull(),
  status: text("status").notNull().default("open"), correlationId: text("correlation_id"), restrictedDetail: jsonb("restricted_detail"), openedByUserId: uuid("opened_by_user_id").references(() => userProfiles.id),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});
