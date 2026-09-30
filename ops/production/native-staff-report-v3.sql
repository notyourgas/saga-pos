-- Native staff reporting v3. This migration is additive so the current
-- SagaPOS runtime remains a safe rollback target after it is installed.
alter table sagaops.attendance_logs
  add column if not exists early_leave_minutes integer not null default 0,
  add column if not exists overtime_candidate_minutes integer not null default 0,
  add column if not exists approved_overtime_minutes integer not null default 0;

alter table sagaops.attendance_logs
  add constraint native_attendance_early_leave_nonnegative check (early_leave_minutes >= 0),
  add constraint native_attendance_overtime_candidate_nonnegative check (overtime_candidate_minutes >= 0),
  add constraint native_attendance_approved_overtime_nonnegative check (approved_overtime_minutes >= 0);
