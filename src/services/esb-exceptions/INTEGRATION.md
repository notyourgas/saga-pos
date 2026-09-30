# ESB exception and permission foundation

Status: `IMPLEMENTED_NOT_DEPLOYED / POSTGRES_ADAPTER_AVAILABLE_ROUTE_NOT_WIRED`.

Modul ini menyediakan kontrak terisolasi untuk Gate 3:

- taxonomy terpisah untuk cancel, void, cash/provider refund, payment
  correction, reversal, dan reclassification;
- reason master berversi dan snapshot alasan yang immutable;
- pemeriksaan role, organisasi, dan outlet secara server-side, termasuk audit
  denial yang dapat diteruskan ke append-only audit store;
- authorization sekali pakai yang terikat actor, role, action, resource, dan
  outlet, dengan maker-checker serta compare-and-set contract;
- period-close policy yang fail-closed;
- before/after audit snapshot immutable;
- refund allocation port yang hanya menerima original bill-line allocation.

Modul ini sengaja belum dipasang ke `server.mjs`. Migration
`20260908_zzzzzzz_esb_exception_runtime_v1.sql` dan
`createEsbExceptionPostgresAdapter` menyediakan persistence atomik untuk
operation fingerprint, resource-version CAS, consume authorization, exception,
refund line, audit, stock disposition, cash movement, reclassification, serta
provider reconciliation work item. Satu approval hanya dapat menerbitkan satu
authorization dan authorization hanya dapat dikonsumsi sekali.

Refund memakai `esb_bill_lines` dan `esb_bill_payment_allocations` asli serta
menolak cumulative over-refund. Provider refund hanya menghasilkan state
rekonsiliasi dengan `provider_call_enabled=false`; modul ini tidak memanggil
provider nyata, mengembalikan uang, mengubah settlement, atau mengaktifkan
payment.

Handoff endpoint: route harus memperoleh `actor` dari session server, bukan
payload; membuat domain decision; lalu memanggil `adapter.execute` dengan
`businessDate` dan `expectedResourceVersion`. Route tidak boleh menerima
organization/outlet/role override dari browser. Reason, period, approval, dan
authorization harus dipersist sebelum eksekusi. HTTP `409` digunakan untuk
operation-key drift, authorization CAS, atau resource-version conflict.
