# Gate 5 acceptance handoff

Status delivery: `LOCAL_VALIDATED / IMPLEMENTED_NOT_DEPLOYED`.

| Acceptance | Closed local | Product/runtime truth |
|---|---|---|
| `STOCK-01` | Ya | Unit conversion snapshot deterministik; wiring recipe repository belum dilakukan. |
| `STOCK-02` | Ya | COGS incomplete tetap `null`; existing report integration harus tetap memakai contract ini. |
| `STOCK-03` | Ya, contract/simulasi | `FOR UPDATE` terurut dan operation-key tersedia; target PostgreSQL concurrency belum dijalankan. |
| `STOCK-04` | Ya | `UNLIMITED` berbeda dari tracked zero; UI adapter belum dipasang. |
| `STOCK-05` | Ya | Ledger reconstruction idempotent; current inventory ledger tetap authority sampai wiring Lead. |
| `STOCK-06` | Ya | Parent/bundle/modifier digabung per ingredient tanpa duplicate source; checkout wiring belum dipasang. |
| `SHIFT-01` | Ya | Cash sale/refund/in/out/drop direkonsiliasi; persistence adapter belum dipasang. |
| `SHIFT-02` | Ya | Reopen action-bound dan audit-ready; endpoint/runtime belum dipasang. |
| `SHIFT-03` | Ya | Timezone/cutoff dan interval half-open diuji; outlet configuration wiring belum dipasang. |
| `PRINT-01` | Ya, logical | Paid state tidak dapat dimutasi oleh print; hardware tidak diuji. |
| `PRINT-02` | Ya, logical | Retry tetap logical job yang sama; reprint membuat copy beralasan; hardware tidak diuji. |
| `PRINT-03` | Ya, logical | Kitchen/bar/checker/sticker routing tersnapshot; station fisik tidak diuji. |
| `PRINT-04` | Ya, logical | Histori memakai template snapshot; hasil cetak fisik tidak diuji. |
| `OFF-01` | Ya, contract | ID namespaced, collision fail-closed, replay dedupe; dua perangkat runtime belum diuji. |
| `OFF-02` | Ya, contract | Price/recipe drift wajib review operator; UI keputusan belum dipasang. |
| `OFF-03` | Ya, contract | Fact/audit/outbox diwajibkan satu transaksi dan attempt idempotent; crash target runtime belum diinjeksi. |

Migration impact pada branch ini: **tidak ada**. Semua persistence contract masih
memerlukan additive migration dan adapter yang dimiliki Implementation Lead.
Rollback lokal cukup dengan tidak memasang adapter/import module. Setelah schema
expand production, rollback mengikuti compatibility window dan tidak melakukan
drop otomatis.

Residual risk utama: contention PostgreSQL nyata, persistence setelah restart,
UX konflik offline, konfigurasi cutoff per outlet, dan seluruh printer/hardware
masih `PARTIAL_PRODUCT` sampai target-engine/browser/physical UAT selesai.
