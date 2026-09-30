# SagaOPS Staff Module

Status: Sprint 6 backend service foundation completed.

## Scope

Modul ini memegang:

- Staff profile operasional.
- Shift template seperti Pagi, Sore, Fulltime, Part-time.
- Jadwal staff berbasis template shift.
- PIN check-in dan check-out.
- Deteksi telat, pulang cepat, overtime candidate, dan unscheduled attendance.
- Koreksi attendance dengan approval ketika berdampak payroll.
- Payroll-ready estimate untuk owner/HR.

## Service Contract

Service utama:

- `createShiftTemplate`
- `assignShiftSchedule`
- `checkInByPin`
- `checkOutByPin`
- `findMatchingSchedule`
- `createAttendanceCorrection`
- `generatePayrollReadyReport`

## MVP Rules

- PIN staff harus disimpan sebagai hash di database. Service test memakai format dummy `pin:1234` dan bisa diganti `verifyPin`.
- Shift schedule tidak boleh overlap untuk staff yang sama.
- Grace period menentukan apakah check-in dianggap telat.
- Menit telat tetap dihitung dari jam mulai shift, bukan dari akhir grace period.
- Attendance tanpa schedule tetap boleh dicatat, tetapi statusnya `unscheduled`.
- Forgot checkout dihitung sebagai `incomplete` di payroll-ready report.
- Overtime belum otomatis dibayar. Sistem hanya menandai `overtimeCandidateMinutes`; pembayaran butuh approval/adjustment.
- Payroll di Sprint 6 adalah estimasi siap export, bukan payroll official.

## Database Tables

Migration Sprint 6 menambahkan:

- `staff_profiles`
- `shift_templates`
- `shift_schedules`
- `attendance_logs`
- `attendance_adjustments`
- `payroll_adjustments`

## Next API Draft

```text
POST /api/staff
PATCH /api/staff/:id
POST /api/shift-templates
POST /api/shift-schedules
POST /api/attendance/check-in
POST /api/attendance/check-out
POST /api/attendance/:id/correction
GET /api/reports/payroll-ready?outletId=:id&from=:date&to=:date
```
