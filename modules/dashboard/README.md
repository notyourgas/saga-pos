# Dashboard Module

Owns:

- live dashboard query model
- recent orders
- payment breakdown
- top products
- stock warnings
- purchase today summary

First services:

- `getLiveDashboard`
- `getLiveOwnerDashboard`
- `getDailyReport`
- `getWeeklyReport`
- `getMonthlyReport`
- `getPaymentSettlementReport`
- `getMenuProfitabilityReport`
- `getRecentOrders`
- `getPaymentBreakdown`
- `getTopProducts`

Sprint 5 locked:

- live owner dashboard can show live or locked source
- payment breakdown includes count and unchecked non-cash count
- recent orders include item and payment detail
- daily report excludes voided orders
- weekly report rolls up daily closings and live fallback orders
- monthly report separates theoretical COGS and actual COGS placeholder
- settlement report separates unchecked, settled, and issue payments
- menu profitability ranks product by qty and margin
