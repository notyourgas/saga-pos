# ESB Owner Reporting foundation

Status: `LOCAL_RUNTIME_WIRED / IMPLEMENTED_NOT_DEPLOYED`.

Modul ini menghasilkan satu snapshot authoritative untuk dashboard, detail,
exact bill, dan CSV. `runtime-api.mjs` memasang adapter repository PostgreSQL
ke `server.mjs` melalui route Owner-only berikut:

- `GET /api/operator/reports/esb-owner`;
- `GET /api/operator/reports/esb-owner/bills/:billId?fingerprint=...`;
- `GET /api/operator/reports/esb-owner.csv?fingerprint=...`.

`loadAuthorizedReportSource`:

1. melakukan authorization organisasi/outlet di server;
2. menerapkan period `[start,end)`, time basis `ORDERED_AT|PAID_AT|BUSINESS_DATE`, status `PAID`, dan snapshot
   cutoff secara identik;
3. melakukan pre-aggregation bill, payment, refund, cash, settlement, dan line
   pada grain masing-masing sebelum join;
4. mengembalikan `appliedFilter` yang cocok persis dengan query;
5. memakai snapshot nama/kebijakan historis, bukan repricing dari katalog aktif.

Organization, outlet, dan Owner profile selalu berasal dari runtime server.
Parameter authority dari browser ditolak. Snapshot disimpan singkat di memory
dan terikat hash sesi + fingerprint, sehingga detail dan CSV tidak dapat
dibangun ulang dari snapshot berbeda. Restart process atau expiry memaksa Owner
memuat ulang laporan.

Endpoint hanya aktif ketika read guard `SHADOW_V1` dan native PostgreSQL ESB
tersedia. `LEGACY_V1`, schema/source yang tidak tersedia, scope Owner yang
tidak cocok, allocation yang belum lengkap, atau partial refund tanpa original
allocation selalu gagal tertutup; production tidak memakai fixture/fallback.

Jika report berisi refund sukses, adapter hanya boleh mengirim
`refundCogsComplete: true` setelah kontribusi COGS/report reversal dan stock
disposition sudah direkonsiliasi. Tanpa bukti itu, margin otomatis `null` dengan
alasan `REFUND_COGS_INCOMPLETE`.

`toReportShellModel` adalah adapter untuk fondasi
`public/pos-alpha/ui/esb-ui-state-system.js`. Semua angka, denominator, dan
format display sudah berasal dari service ini; frontend tidak menghitung ulang.

Ranking selalu membawa nama snapshot dan stable `item_reference`; keduanya
ditampilkan di chart, tabel, rincian bill, dan CSV sehingga dua produk bernama
sama tetap dapat dibedakan. Detail payment membawa level verifikasi beserta
sumber, status, waktu, dan fingerprint evidence. `CASH` dan
`PROVIDER_VERIFIED` gagal tertutup bila event sukses persisted tidak tersedia.
External event ID dan payload tidak masuk ke report.

`ORDERED_AT` memakai `orders.created_at` sebagai waktu pembuatan order
authoritative. Filter cash pada basis ini mengikuti relasi persisted
cash-movement -> payment-attempt -> order, bukan waktu cash yang dikirim client.

## Batas integrasi katalog

Branch katalog belum berada pada parent slice ini. `REPORT_CATALOG_PORT_V1`
mendokumentasikan port opsional untuk metadata katalog baru, tetapi ranking
historis tetap memakai `itemId` stabil dan `itemNameSnapshot`. Karena itu
`REPORT-02` tertutup sebagai komponen pelaporan lokal, sedangkan integrasi
katalog/runtime tetap `PARTIAL_PRODUCT_INTEGRATION`.

## Batas release

Provider/payment/refund nyata tetap `OFF`. Slice ini tidak menambah database
migration, credential, network call, atau deployment. Sebelum promotion, ikuti
`C:/Users/Windows 11/.codex/skills/sagadevs-deployment/SKILL.md`, uji target
PostgreSQL, authenticated Owner scope, backup/restore, rollback, dan parity
terhadap source runtime. Aktivasi `SHADOW_V1` tetap keputusan release terpisah.
