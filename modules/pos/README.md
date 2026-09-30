# POS Module

Owns:

- cash_sessions integration
- orders
- order_items
- payments
- receipt payload
- checkout orchestration

First services:

- `checkoutOrder`
- `submitPosCheckout`
- `buildCashTenderOptions`
- `normalizePaymentPlan`
- `voidOrderRequest`
- `buildReceiptPayload`
- `listShiftOrders`

Sprint 3 locked:

- idempotency key for Pay button double-tap protection
- cash tender options with `Uang pas`
- split payment normalization
- cash expected based on sale amount
- audit event for paid order
