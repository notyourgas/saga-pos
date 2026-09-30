const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const day = (value, code = 'report_date_invalid') => {
  const text = String(value ?? '');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!datePattern.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== text) {
    throw Object.assign(new Error(code), { code, statusCode: 422 });
  }
  return text;
};

const minutes = (value) => Math.max(0, Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);
const money = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
const dateOf = (value) => value instanceof Date ? value.toISOString().slice(0,10) : String(value ?? '').slice(0,10);
const overlap = (startA,endA,startB,endB) => Date.parse(startA) < Date.parse(endB) && Date.parse(endA) > Date.parse(startB);

export function validateNativeStaffReportPeriod(from, to) {
  const periodStart = day(from), periodEnd = day(to);
  const span = Math.floor((Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000) + 1;
  if (span < 1 || span > 62) throw Object.assign(new Error('report_period_invalid'), { code:'report_period_invalid', statusCode:422 });
  return { periodStart, periodEnd };
}
export function buildNativeStaffReport({ periodStart, periodEnd, generatedAt = new Date().toISOString(), staff = [], schedules = [], attendance = [], requests = [], adjustments = [] }) {
  ({ periodStart, periodEnd } = validateNativeStaffReportPeriod(periodStart, periodEnd));
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(now)) throw Object.assign(new Error('report_generated_at_invalid'), { code:'report_generated_at_invalid', statusCode:422 });
  const approvedAbsence = requests.filter((item) => item.state === 'approved' && ['leave','permission','sick'].includes(item.category) && item.starts_at && item.ends_at);
  const reviewState = (item) => String(item.review_status ?? item.reviewStatus ?? 'NOT_REQUIRED').toUpperCase();
  const acceptedAttendance = attendance.filter((item) => !['PENDING','REJECTED'].includes(reviewState(item)));

  const rows = staff.map((person) => {
    const staffSchedules = schedules.filter((item) => item.staff_id === person.id && item.status !== 'cancelled');
    const allStaffLogs = attendance.filter((item) => item.staff_id === person.id), staffLogs = acceptedAttendance.filter((item) => item.staff_id === person.id);
    const logsBySchedule = new Map(staffLogs.filter((item) => item.shift_schedule_id).map((item) => [item.shift_schedule_id,item]));
    const schedulesById = new Map(staffSchedules.map((item) => [item.id,item]));
    const pendingReview = allStaffLogs.filter((item) => reviewState(item)==='PENDING'), rejectedReview = allStaffLogs.filter((item) => reviewState(item)==='REJECTED');
    const due = staffSchedules.filter((item) => Date.parse(item.scheduled_end_at) <= now);
    const excused = due.filter((schedule) => approvedAbsence.some((request) => request.staff_id === person.id && overlap(request.starts_at,request.ends_at,schedule.scheduled_start_at,schedule.scheduled_end_at)));
    const excusedIds = new Set(excused.map((item) => item.id));
    const attendanceDue = due.filter((item) => !excusedIds.has(item.id));
    const attendedDue = attendanceDue.filter((item) => logsBySchedule.has(item.id));
    const absent = attendanceDue.filter((item) => !logsBySchedule.has(item.id));
    const incomplete = staffLogs.filter((item) => item.check_in_at && !item.check_out_at &&
      (!schedulesById.has(item.shift_schedule_id) || Date.parse(schedulesById.get(item.shift_schedule_id).scheduled_end_at) <= now));
    const unscheduled = staffLogs.filter((item) => item.is_unscheduled || !item.shift_schedule_id);
    const lateLogs = staffLogs.filter((item) => minutes(item.late_minutes) > 0);
    const payableSchedules = attendedDue.map((schedule) => ({ schedule, log:logsBySchedule.get(schedule.id) }));
    let estimatedPayRupiah = 0;
    let payPolicyComplete = payableSchedules.length > 0;
    let payPolicyMissing = false;
    for (const { schedule,log } of payableSchedules) {
      const rate = money(schedule.rate_amount_rupiah);
      if (rate <= 0 || !['per_hour','per_shift'].includes(schedule.rate_type)) { payPolicyComplete = false; payPolicyMissing = true; continue; }
      if (!log.check_out_at) { payPolicyComplete = false; continue; }
      // Report worked time as observed, but only estimate the configured base
      // rate inside the scheduled interval. Overtime needs its own agreed policy.
      const scheduledWorkedMinutes = Math.max(0, Math.round((Math.min(Date.parse(log.check_out_at),Date.parse(schedule.scheduled_end_at)) -
        Math.max(Date.parse(log.check_in_at),Date.parse(schedule.scheduled_start_at))) / 60_000));
      estimatedPayRupiah += schedule.rate_type === 'per_hour' ? Math.round(Math.min(minutes(log.worked_minutes),scheduledWorkedMinutes) / 60 * rate) : rate;
    }
    const approvedAdjustments = adjustments.filter((item) => item.staff_id === person.id && item.status === 'approved');
    if (payPolicyComplete) estimatedPayRupiah += approvedAdjustments.reduce((sum,item) => sum + (['deduction','kasbon'].includes(item.type) ? -money(item.amount_rupiah) : money(item.amount_rupiah)),0);
    const reviewReasons = [
      ...(absent.length ? ['absence'] : []),
      ...(incomplete.length ? ['incomplete_attendance'] : []),
      ...(unscheduled.length ? ['unscheduled_attendance'] : []),
      ...(pendingReview.length ? ['attendance_review_pending'] : []),
      ...(rejectedReview.length ? ['attendance_rejected'] : []),
      ...(staffLogs.some((item)=>minutes(item.early_leave_minutes)>30) ? ['early_leave'] : []),
      ...(payPolicyMissing ? ['pay_policy_missing'] : []),
    ];
    return {
      staffId:person.id,
      employeeCode:person.employee_code ?? person.employeeCode,
      name:person.full_name ?? person.name,
      role:person.role,
      scheduledShifts:staffSchedules.length,
      dueShifts:due.length,
      attendedShifts:attendedDue.length,
      excusedShifts:excused.length,
      absentShifts:absent.length,
      lateCount:lateLogs.length,
      lateMinutes:lateLogs.reduce((sum,item) => sum + minutes(item.late_minutes),0),
      incompleteCount:incomplete.length,
      unscheduledCount:unscheduled.length,
      workedMinutes:staffLogs.reduce((sum,item) => sum + minutes(item.worked_minutes),0),
      earlyLeaveMinutes:staffLogs.reduce((sum,item) => sum + minutes(item.early_leave_minutes),0),
      overtimeCandidateMinutes:staffLogs.reduce((sum,item) => sum + minutes(item.overtime_candidate_minutes),0),
      approvedOvertimeMinutes:staffLogs.reduce((sum,item) => sum + Math.min(minutes(item.approved_overtime_minutes),minutes(item.overtime_candidate_minutes)),0),
      attendanceRateBps:attendanceDue.length ? Math.round(attendedDue.length / attendanceDue.length * 10_000) : null,
      payrollStatus:reviewReasons.length ? 'review_required' : payableSchedules.length ? 'quantity_ready' : 'no_activity',
      reviewReasons,
      estimatedPayRupiah:payPolicyComplete ? estimatedPayRupiah : null,
    };
  });
  const included = rows.filter((row) => row.scheduledShifts || row.workedMinutes || row.unscheduledCount || row.excusedShifts);
  const total = (field) => included.reduce((sum,row) => sum + Number(row[field] ?? 0),0);
  return {
    periodStart,
    periodEnd,
    generatedAt:new Date(now).toISOString(),
    performanceEnabled:false,
    payrollMode:'PREVIEW_ONLY',
    rows:included,
    summary:{
      staffCount:included.length,
      scheduledShifts:total('scheduledShifts'),
      attendedShifts:total('attendedShifts'),
      excusedShifts:total('excusedShifts'),
      absentShifts:total('absentShifts'),
      lateCount:total('lateCount'),
      lateMinutes:total('lateMinutes'),
      incompleteCount:total('incompleteCount'),
      unscheduledCount:total('unscheduledCount'),
      workedMinutes:total('workedMinutes'),
      overtimeCandidateMinutes:total('overtimeCandidateMinutes'),
      approvedOvertimeMinutes:total('approvedOvertimeMinutes'),
      reviewRequiredCount:included.filter((row) => row.payrollStatus === 'review_required').length,
      nominalReadyCount:included.filter((row) => row.estimatedPayRupiah !== null).length,
    },
  };
}
