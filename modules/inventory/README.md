# Inventory Module

Owns:

- inventory_movements
- inventory_balances
- stock warning calculation
- stock guard calculation

First services:

- `createInventoryMovement`
- `applySaleConsumption`
- `getInventoryBalance`
- `getStockWarnings`
- `calculateStockShortages`

Rules:

- No direct balance edits.
- Every stock change must be movement-backed.

