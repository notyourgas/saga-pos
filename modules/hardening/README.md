# SagaOPS Hardening Module

Status: Sprint 7 backend service foundation completed.

## Scope

Modul ini memegang:

- Role permission guard untuk surface sensitif.
- Approval request dan approval decision.
- Manager/Owner PIN approval.
- Failed PIN attempt dan temporary lock rule.
- Audit event payload untuk aksi sensitif.
- Setup wizard readiness score.
- Connection/sync status hijau, kuning, merah.
- Sync error log yang bisa dibaca owner/manager.

## Service Contract

Service utama:

- `requestApproval`
- `verifyApprovalPin`
- `decideApprovalWithPin`
- `buildSetupReadiness`
- `getConnectionSyncStatus`
- `createSyncErrorLog`

Permission helper:

- `can`
- `assertPermission`
- `requiresManagerApproval`
- `buildAuditEvent`

## MVP Rules

- Owner punya full access.
- Manager bisa approval operasional dan melihat margin/HPP.
- Cashier hanya POS, closing shift, attendance, inventory basic; tidak boleh payroll, HPP, margin, audit.
- HR/Admin bisa staff, attendance, payroll-ready; tidak boleh profit/margin.
- Approval sensitif wajib reason.
- Approval decision wajib Manager/Owner PIN.
- PIN salah dicatat sebagai audit event.
- Tiga kali PIN salah membuat temporary lock 5 menit.
- Setup wizard belum boleh selesai tanpa outlet, payment method, menu, ingredient, opening stock, staff, shift template, dan test transaction.
- Sync status merah memblokir payment di MVP.
- Sync status kuning masih boleh payment, tetapi user diberi tahu data belum sepenuhnya sinkron.

## Database Tables

Migration Sprint 7 menambahkan:

- `setup_wizard_states`
- `pos_devices`
- `sync_error_logs`
- `approval_pin_attempts`

Migration juga memperkaya:

- `approvals.metadata`
- `approvals.decision_note`
- `audit_logs.staff_id`
- `audit_logs.role_snapshot`
- `audit_logs.source_device_id`
- `audit_logs.old_values`
- `audit_logs.new_values`

## Next API Draft

```text
POST /api/approvals
POST /api/approvals/:id/decide
POST /api/approvals/verify-pin
GET /api/setup/readiness
PATCH /api/setup/state
GET /api/sync/status
POST /api/sync/error-logs
PATCH /api/sync/error-logs/:id/resolve
```
