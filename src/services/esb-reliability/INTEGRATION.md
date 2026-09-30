# SagaPOS ESB reliability integration handoff

Status: `LOCAL_MODULE_ONLY / ADAPTER_REQUIRED / IMPLEMENTED_NOT_DEPLOYED`

Module ini membekukan perilaku Gate 5 tanpa memasangnya ke shared runtime.
`server.mjs`, schema/migration manifest, package files, UI bersama, dan ops tidak
diubah oleh worker ini.

Implementation Lead perlu:

1. memasang persistence adapter dalam satu transaksi PostgreSQL;
2. memakai ordered `SELECT ... FOR UPDATE` dari `contract.mjs` dan unique
   operation key sebelum mengaktifkan reservasi stok;
3. memilih event runtime konsumsi stok (`PLACED`, produksi, atau finalisasi)
   bersama operator sebelum wiring;
4. memasang cash movement, shift reopen, print job, dan offline outbox secara
   additive serta tetap kompatibel dengan release lama;
5. menjalankan migration expand-only, target-engine concurrency, browser/UI,
   recovery, dan authenticated Owner UAT sebelum production activation.

Printer dan hardware tetap `OFF_REQUIRES_PHYSICAL_UAT`. Queue/route/template
yang diuji hanya kontrak logis sintetis; bukan bukti cetak fisik. Offline replay
yang diuji juga belum menjadi bukti dua perangkat produksi sampai adapter,
storage durable, dan konflik operator terpasang di runtime.

Pedoman rilis wajib dibaca ulang oleh penerima:
`C:/Users/Windows 11/.codex/skills/sagadevs-deployment/SKILL.md`.
