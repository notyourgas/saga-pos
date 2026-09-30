-- Native staff payroll preview v4. Rates are snapshot-only inputs for reports;
-- this schema does not authorize payroll finalization, deductions, or payouts.
alter table sagaops.staff_profiles
  add column payroll_rate_type text,
  add column payroll_rate_amount_rupiah integer not null default 0;

alter table sagaops.staff_profiles
  add constraint native_staff_payroll_rate_type_valid check (payroll_rate_type is null or payroll_rate_type in ('per_hour','per_shift')),
  add constraint native_staff_payroll_rate_amount_valid check (payroll_rate_amount_rupiah between 0 and 100000000),
  add constraint native_staff_payroll_rate_pair_valid check ((payroll_rate_type is null) = (payroll_rate_amount_rupiah = 0));

alter table sagaops.shift_schedules
  add column payroll_rate_type text,
  add column payroll_rate_amount_rupiah integer not null default 0;

alter table sagaops.shift_schedules
  add constraint native_shift_payroll_rate_type_valid check (payroll_rate_type is null or payroll_rate_type in ('per_hour','per_shift')),
  add constraint native_shift_payroll_rate_amount_valid check (payroll_rate_amount_rupiah between 0 and 100000000),
  add constraint native_shift_payroll_rate_pair_valid check ((payroll_rate_type is null) = (payroll_rate_amount_rupiah = 0));
