# Gate 7 boundary handoff

Status: `IMPLEMENTED_NOT_DEPLOYED`

This module is an additive, runtime-unwired boundary contract. It does not
activate marketplace, online ordering, payout, email, devices, providers, or
network access.

## Closed locally

- `AUTH-02`: tenant, organization, and outlet scope are all checked before an
  outlet-bound operation; wildcard outlet access never crosses tenant or
  organization scope.
- Organization -> brand -> outlet relationships, IANA timezone, weekly hours,
  sales-mode price-book references, receipt template version, and station
  settings are validated and returned as immutable snapshots.
- SagaWork remains workforce authority. The boundary delegates the existing
  Owner session to the existing bridge and rejects payloads that try to persist
  employee, attendance, or payroll aggregates locally.
- Every external capability is disabled by default and exposes explicit
  `REAL DATA - INACTIVE` or synthetic-only labeling.
- Synthetic provider operations demonstrate scoped idempotency, safe retry,
  payload conflict rejection, concurrent duplicate coalescing, and mandatory
  reconciliation when the external side effect is uncertain.

## Partial product / still gated

- `PAY-05` remains partial until a real provider contract, durable operation
  store, callback reconciliation, and target-engine unique constraints pass.
- `REPORT-05` remains partial; payout is deliberately disabled and settlement
  reporting belongs to the authoritative report/ledger gate.
- Outlet settings are not wired into `server.mjs` or persisted by a migration.
  Integration Lead owns those shared changes after schema review.
- Table/room remains `OPERATOR_EVIDENCE_REQUIRED` and disabled. The ESB screen
  alone is not enough evidence to add a runtime feature.
- Printer/device hardware and all real external providers require separate
  authorization and UAT. They remain off.

Rollback is removal of this isolated module and its tests. No schema, data,
credential, provider, runtime, or production state is changed.
