import { getStockWarnings } from "./inventory.mjs";

export function getLiveDashboard(input) {
  return getLiveOwnerDashboard(input);
}

export function getLiveOwnerDashboard({
  orders = [],
  payments = [],
  orderItems = [],
  balances = [],
  ingredients = [],
  inventoryMovements = [],
  dailyClosing = null,
  now = new Date().toISOString(),
}) {
  const paidOrders = getPaidOrders(orders);
  const netSalesRupiah = sumMoney(paidOrders, "totalRupiah");
  const totalHppRupiah = sumMoney(paidOrders, "totalHppRupiah");
  const totalOrders = paidOrders.length;
  const paymentMethod = getPaymentBreakdown({ payments });
  const paymentMethodTotals = Object.fromEntries(
    Object.entries(paymentMethod).map(([key, row]) => [key, row.amountRupiah]),
  );
  const topProducts = getTopProducts({ orderItems });
  const purchaseTodayRupiah = getMovementTotal(inventoryMovements, "purchase_received");
  const wasteTodayRupiah = Math.abs(getMovementTotal(inventoryMovements, "waste"));

  return {
    generatedAt: now,
    status: dailyClosing?.status === "locked" ? "locked" : "live",
    netSalesRupiah,
    totalOrders,
    aovRupiah: totalOrders > 0 ? Math.round(netSalesRupiah / totalOrders) : 0,
    totalHppRupiah,
    grossProfitRupiah: netSalesRupiah - totalHppRupiah,
    grossMarginPct: percentage(netSalesRupiah - totalHppRupiah, netSalesRupiah),
    paymentMethod,
    paymentMethodTotals,
    hourlySales: getHourlySales({ orders: paidOrders }),
    topProducts,
    stockWarnings: getStockWarnings(balances, ingredients),
    purchaseTodayRupiah,
    wasteTodayRupiah,
    recentOrders: getRecentOrders({ orders: paidOrders, orderItems, payments }),
    issueFlags: dailyClosing?.issueFlags ?? [],
    source: dailyClosing?.status === "locked" ? "daily_closing_snapshot" : "live_transactions",
  };
}

export function getDailyReport({
  businessDate,
  orders = [],
  payments = [],
  orderItems = [],
  expenses = [],
  cashSessions = [],
  inventoryMovements = [],
  dailyClosing = null,
}) {
  const sourceOrders = filterByBusinessDate(orders, businessDate);
  const paidOrders = getPaidOrders(sourceOrders);
  const netSalesRupiah = sumMoney(paidOrders, "totalRupiah");
  const totalHppRupiah = sumMoney(paidOrders, "totalHppRupiah");
  const totalExpenseRupiah = sumMoney(filterByBusinessDate(expenses, businessDate), "amountRupiah");
  const relatedOrderIds = new Set(paidOrders.map((order) => order.id));

  return {
    businessDate,
    status: dailyClosing?.status ?? "live",
    netSalesRupiah,
    totalOrders: paidOrders.length,
    aovRupiah: paidOrders.length > 0 ? Math.round(netSalesRupiah / paidOrders.length) : 0,
    totalHppRupiah,
    grossProfitRupiah: netSalesRupiah - totalHppRupiah,
    grossMarginPct: percentage(netSalesRupiah - totalHppRupiah, netSalesRupiah),
    totalExpenseRupiah,
    paymentBreakdown: getPaymentBreakdown({ payments: payments.filter((payment) => relatedOrderIds.has(payment.orderId)) }),
    topProducts: getTopProducts({ orderItems: orderItems.filter((item) => relatedOrderIds.has(item.orderId)) }),
    hourlySales: getHourlySales({ orders: paidOrders }),
    cash: summarizeCashSessions(filterByBusinessDate(cashSessions, businessDate)),
    purchaseReceivedRupiah: getMovementTotal(filterByBusinessDate(inventoryMovements, businessDate), "purchase_received"),
    wasteRupiah: Math.abs(getMovementTotal(filterByBusinessDate(inventoryMovements, businessDate), "waste")),
    voidedOrders: sourceOrders.filter((order) => order.status === "voided").length,
    issueFlags: dailyClosing?.issueFlags ?? [],
    snapshot: dailyClosing?.snapshotJson ?? null,
  };
}

export function getWeeklyReport({ businessDates = [], dailyClosings = [], orders = [] }) {
  const dailyByDate = new Map(dailyClosings.map((closing) => [closing.businessDate, closing]));
  const days = businessDates.map((businessDate) => {
    const closing = dailyByDate.get(businessDate);
    const fallbackOrders = filterByBusinessDate(orders, businessDate);
    const paidOrders = getPaidOrders(fallbackOrders);
    const netSalesRupiah = closing?.netSalesRupiah ?? sumMoney(paidOrders, "totalRupiah");
    const totalOrders = closing?.totalOrders ?? paidOrders.length;

    return {
      businessDate,
      status: closing?.status ?? "live",
      netSalesRupiah,
      totalOrders,
      totalHppRupiah: closing?.totalHppRupiah ?? sumMoney(paidOrders, "totalHppRupiah"),
      cashVarianceRupiah: closing?.cashVarianceRupiah ?? 0,
      issueCount: closing?.issueFlags?.length ?? 0,
    };
  });

  const netSalesRupiah = sumMoney(days, "netSalesRupiah");
  const totalOrders = sumMoney(days, "totalOrders");
  const totalHppRupiah = sumMoney(days, "totalHppRupiah");

  return {
    fromDate: businessDates[0],
    toDate: businessDates[businessDates.length - 1],
    days,
    netSalesRupiah,
    totalOrders,
    aovRupiah: totalOrders > 0 ? Math.round(netSalesRupiah / totalOrders) : 0,
    totalHppRupiah,
    grossProfitRupiah: netSalesRupiah - totalHppRupiah,
    grossMarginPct: percentage(netSalesRupiah - totalHppRupiah, netSalesRupiah),
    bestDay: [...days].sort((a, b) => b.netSalesRupiah - a.netSalesRupiah)[0] ?? null,
    issueCount: days.reduce((sum, day) => sum + day.issueCount, 0),
  };
}

export function getMonthlyReport({ month, dailyClosings = [], inventoryMovements = [], orderItems = [] }) {
  const monthClosings = dailyClosings.filter((closing) => closing.businessDate?.startsWith(month));
  const monthMovements = inventoryMovements.filter((movement) => movement.businessDate?.startsWith(month));
  const netSalesRupiah = sumMoney(monthClosings, "netSalesRupiah");
  const totalOrders = sumMoney(monthClosings, "totalOrders");
  const totalHppRupiah = sumMoney(monthClosings, "totalHppRupiah");
  const actualWasteRupiah = Math.abs(getMovementTotal(monthMovements, "waste"));

  return {
    month,
    daysClosed: monthClosings.filter((closing) => closing.status === "locked").length,
    daysReported: monthClosings.length,
    netSalesRupiah,
    totalOrders,
    aovRupiah: totalOrders > 0 ? Math.round(netSalesRupiah / totalOrders) : 0,
    theoreticalCogsRupiah: totalHppRupiah,
    actualWasteRupiah,
    actualCogsPlaceholderRupiah: totalHppRupiah + actualWasteRupiah,
    grossProfitRupiah: netSalesRupiah - totalHppRupiah,
    grossMarginPct: percentage(netSalesRupiah - totalHppRupiah, netSalesRupiah),
    topProducts: getTopProducts({ orderItems }),
    note: "Actual COGS final needs stock opname snapshot.",
  };
}

export function getPaymentSettlementReport({ payments = [] }) {
  const rows = Object.values(
    payments.reduce((acc, payment) => {
      const key = payment.methodNameSnapshot ?? payment.methodType;
      acc[key] ??= {
        methodName: key,
        methodType: payment.methodType,
        totalRupiah: 0,
        count: 0,
        uncheckedRupiah: 0,
        uncheckedCount: 0,
        issueRupiah: 0,
        issueCount: 0,
        settledRupiah: 0,
        settledCount: 0,
      };

      const amountRupiah = normalizeMoney(payment.amountRupiah);
      acc[key].totalRupiah += amountRupiah;
      acc[key].count += 1;

      if (payment.settlementStatus === "settled" || payment.methodType === "cash") {
        acc[key].settledRupiah += amountRupiah;
        acc[key].settledCount += 1;
      } else if (payment.settlementStatus === "issue") {
        acc[key].issueRupiah += amountRupiah;
        acc[key].issueCount += 1;
      } else {
        acc[key].uncheckedRupiah += amountRupiah;
        acc[key].uncheckedCount += 1;
      }

      return acc;
    }, {}),
  );

  return {
    rows,
    uncheckedCount: rows.reduce((sum, row) => sum + row.uncheckedCount, 0),
    uncheckedRupiah: rows.reduce((sum, row) => sum + row.uncheckedRupiah, 0),
    issueCount: rows.reduce((sum, row) => sum + row.issueCount, 0),
    issueRupiah: rows.reduce((sum, row) => sum + row.issueRupiah, 0),
  };
}

export function getMenuProfitabilityReport({ orderItems = [] }) {
  return getTopProducts({ orderItems }).map((item, index) => ({
    rank: index + 1,
    productId: item.productId,
    name: item.name,
    qty: item.qty,
    salesRupiah: item.salesRupiah,
    hppRupiah: item.hppRupiah,
    grossProfitRupiah: item.salesRupiah - item.hppRupiah,
    grossMarginPct: percentage(item.salesRupiah - item.hppRupiah, item.salesRupiah),
  }));
}

export function getRecentOrders({ orders = [], orderItems = [], payments = [], limit = 10 }) {
  const itemsByOrderId = groupBy(orderItems, "orderId");
  const paymentsByOrderId = groupBy(payments, "orderId");

  return [...orders]
    .sort((a, b) => String(b.paidAt ?? b.createdAt ?? "").localeCompare(String(a.paidAt ?? a.createdAt ?? "")))
    .slice(0, limit)
    .map((order) => ({
      ...order,
      items: itemsByOrderId[order.id] ?? [],
      payments: paymentsByOrderId[order.id] ?? [],
    }));
}

export function getPaymentBreakdown({ payments = [] }) {
  return payments.reduce((acc, payment) => {
    const key = payment.methodNameSnapshot ?? payment.methodType;
    acc[key] ??= {
      methodName: key,
      methodType: payment.methodType,
      amountRupiah: 0,
      count: 0,
      uncheckedCount: 0,
    };
    acc[key].amountRupiah += normalizeMoney(payment.amountRupiah);
    acc[key].count += 1;
    if (payment.methodType !== "cash" && ["unchecked", undefined, null].includes(payment.settlementStatus)) {
      acc[key].uncheckedCount += 1;
    }
    return acc;
  }, {});
}

export function getTopProducts({ orderItems = [] }) {
  return Object.values(
    orderItems.reduce((acc, item) => {
      const key = item.productId ?? item.productNameSnapshot;
      acc[key] ??= {
        productId: item.productId,
        name: item.productNameSnapshot,
        qty: 0,
        salesRupiah: 0,
        hppRupiah: 0,
      };
      acc[key].qty += Number(item.qty ?? 0);
      acc[key].salesRupiah += normalizeMoney(item.lineTotalRupiah);
      acc[key].hppRupiah += normalizeMoney(item.recipeCostSnapshotRupiah) * Number(item.qty ?? 1);
      return acc;
    }, {}),
  ).sort((a, b) => b.qty - a.qty || b.salesRupiah - a.salesRupiah);
}

export function getHourlySales({ orders = [] }) {
  const rows = orders.reduce((acc, order) => {
    const hour = getHourLabel(order.paidAt ?? order.createdAt);
    acc[hour] ??= { hour, netSalesRupiah: 0, totalOrders: 0 };
    acc[hour].netSalesRupiah += normalizeMoney(order.totalRupiah);
    acc[hour].totalOrders += 1;
    return acc;
  }, {});

  return Object.values(rows).sort((a, b) => a.hour.localeCompare(b.hour));
}

function getPaidOrders(orders) {
  return orders.filter((order) => order.status === "paid" || order.status === "pending_sync");
}

function summarizeCashSessions(cashSessions = []) {
  return {
    totalOpeningCashRupiah: sumMoney(cashSessions, "openingCashRupiah"),
    totalExpectedCashRupiah: sumMoney(cashSessions, "expectedCashRupiah"),
    totalActualCashRupiah: sumMoney(cashSessions, "actualCashRupiah"),
    totalDepositCashRupiah: sumMoney(cashSessions, "depositCashRupiah"),
    totalCashLeftRupiah: sumMoney(cashSessions, "cashToLeaveRupiah"),
    totalCashVarianceRupiah: sumMoney(cashSessions, "varianceRupiah"),
  };
}

function filterByBusinessDate(rows = [], businessDate) {
  if (!businessDate) return rows;
  return rows.filter((row) => row.businessDate === businessDate);
}

function getMovementTotal(movements = [], movementType) {
  return movements
    .filter((movement) => movement.movementType === movementType)
    .reduce((sum, movement) => sum + normalizeMoney(movement.valueDeltaRupiah), 0);
}

function groupBy(rows = [], field) {
  return rows.reduce((acc, row) => {
    const key = row[field];
    acc[key] ??= [];
    acc[key].push(row);
    return acc;
  }, {});
}

function getHourLabel(value) {
  const date = value ? new Date(value) : new Date(0);
  if (Number.isNaN(date.getTime())) return "00:00";
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

function percentage(part, total) {
  const totalNumber = normalizeMoney(total);
  if (totalNumber <= 0) return 0;
  return Math.round((normalizeMoney(part) / totalNumber) * 10000) / 100;
}

function sumMoney(rows = [], field) {
  return rows.reduce((sum, row) => sum + normalizeMoney(row[field]), 0);
}

function normalizeMoney(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) {
    throw new Error("money_amount_invalid");
  }
  return Math.round(amount);
}
