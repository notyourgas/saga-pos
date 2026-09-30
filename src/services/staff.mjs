const supportedRateTypes = new Set(["per_shift", "per_hour", "monthly_allocation"]);
const negativeAdjustmentTypes = new Set(["deduction", "kasbon"]);
const positiveAdjustmentTypes = new Set(["bonus", "correction", "overtime"]);

export function createShiftTemplate(input) {
  const startMinutes = timeToMinutes(input.startTime);
  const endMinutes = timeToMinutes(input.endTime);
  const durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
  const rateType = input.rateType ?? "per_shift";

  if (!supportedRateTypes.has(rateType)) {
    throw new Error("shift_template_rate_type_invalid");
  }

  return {
    id: input.id,
    organizationId: input.organizationId,
    outletId: input.outletId,
    name: input.name,
    startTime: input.startTime,
    endTime: input.endTime,
    durationMinutes,
    gracePeriodMinutes: normalizeMinutes(input.gracePeriodMinutes ?? 0),
    rateType,
    rateAmountRupiah: normalizeMoney(input.rateAmountRupiah),
    status: input.status ?? "active",
  };
}

export function assignShiftSchedule(input) {
  const shiftTemplate = input.shiftTemplate;
  if (!shiftTemplate || shiftTemplate.status === "inactive") {
    throw new Error("active_shift_template_required");
  }

  const scheduledStartAt = toBusinessDateTime(input.businessDate, shiftTemplate.startTime);
  const scheduledEndAt = addMinutes(scheduledStartAt, shiftTemplate.durationMinutes);
  const nextSchedule = {
    id: input.id,
    organizationId: input.organizationId ?? shiftTemplate.organizationId,
    outletId: input.outletId ?? shiftTemplate.outletId,
    staffId: input.staffId,
    shiftTemplateId: shiftTemplate.id,
    shiftName: shiftTemplate.name,
    businessDate: input.businessDate,
    scheduledStartAt: scheduledStartAt.toISOString(),
    scheduledEndAt: scheduledEndAt.toISOString(),
    gracePeriodMinutes: shiftTemplate.gracePeriodMinutes,
    rateType: shiftTemplate.rateType,
    rateAmountRupiah: shiftTemplate.rateAmountRupiah,
    notes: input.notes,
    status: input.status ?? "scheduled",
  };

  const overlapping = (input.existingSchedules ?? []).find(
    (schedule) =>
      schedule.staffId === nextSchedule.staffId &&
      schedule.status !== "cancelled" &&
      intervalsOverlap(nextSchedule.scheduledStartAt, nextSchedule.scheduledEndAt, schedule.scheduledStartAt, schedule.scheduledEndAt),
  );

  if (overlapping) {
    throw new Error("shift_schedule_overlap");
  }

  return nextSchedule;
}

export function checkInByPin(input) {
  const staffProfile = resolveStaffByPin(input);
  const checkInAt = parseDate(input.checkInAt ?? new Date().toISOString());
  const schedule = findMatchingSchedule({
    staffId: staffProfile.id,
    checkAt: checkInAt.toISOString(),
    schedules: input.schedules,
    windowMinutes: input.windowMinutes,
  });

  if (!schedule) {
    return {
      id: input.id,
      organizationId: staffProfile.organizationId,
      outletId: staffProfile.outletId,
      staffId: staffProfile.id,
      scheduleId: null,
      shiftScheduleId: null,
      checkInAt: checkInAt.toISOString(),
      checkOutAt: null,
      status: "unscheduled",
      isUnscheduled: true,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeCandidateMinutes: 0,
      workedMinutes: 0,
    };
  }

  const lateMinutes = calculateLateMinutes(schedule, checkInAt);

  return {
    id: input.id,
    organizationId: schedule.organizationId ?? staffProfile.organizationId,
    outletId: schedule.outletId ?? staffProfile.outletId,
    staffId: staffProfile.id,
    scheduleId: schedule.id,
    shiftScheduleId: schedule.id,
    checkInAt: checkInAt.toISOString(),
    checkOutAt: null,
    status: lateMinutes > 0 ? "late" : "present",
    isUnscheduled: false,
    lateMinutes,
    earlyLeaveMinutes: 0,
    overtimeCandidateMinutes: 0,
    workedMinutes: 0,
  };
}

export function checkOutByPin(input) {
  const staffProfile = resolveStaffByPin(input);
  const checkOutAt = parseDate(input.checkOutAt ?? new Date().toISOString());
  const openLog = (input.openAttendanceLogs ?? []).find((log) => log.staffId === staffProfile.id && !log.checkOutAt);

  if (!openLog) {
    throw new Error("open_attendance_log_required");
  }

  const openLogScheduleId = openLog.shiftScheduleId ?? openLog.scheduleId;
  const schedule = (input.schedules ?? []).find((item) => item.id === openLogScheduleId) ?? null;
  const checkInAt = parseDate(openLog.checkInAt);
  const workedMinutes = diffMinutes(checkInAt, checkOutAt);
  const earlyLeaveMinutes = schedule ? Math.max(0, diffMinutes(checkOutAt, parseDate(schedule.scheduledEndAt))) : 0;
  const overtimeCandidateMinutes = schedule ? Math.max(0, diffMinutes(parseDate(schedule.scheduledEndAt), checkOutAt)) : 0;

  return {
    ...openLog,
    checkOutAt: checkOutAt.toISOString(),
    status: openLog.status === "late" ? "late" : openLog.status === "unscheduled" ? "unscheduled" : "present",
    workedMinutes,
    earlyLeaveMinutes,
    overtimeCandidateMinutes,
  };
}

export function findMatchingSchedule({ staffId, checkAt, schedules = [], windowMinutes = 120 }) {
  const checkDate = parseDate(checkAt);
  const windowMs = normalizeMinutes(windowMinutes) * 60 * 1000;

  return schedules
    .filter((schedule) => schedule.staffId === staffId && schedule.status !== "cancelled")
    .filter((schedule) => {
      const startsAt = parseDate(schedule.scheduledStartAt).getTime() - windowMs;
      const endsAt = parseDate(schedule.scheduledEndAt).getTime() + windowMs;
      return checkDate.getTime() >= startsAt && checkDate.getTime() <= endsAt;
    })
    .sort((a, b) => Math.abs(checkDate - parseDate(a.scheduledStartAt)) - Math.abs(checkDate - parseDate(b.scheduledStartAt)))[0] ?? null;
}

export function createAttendanceCorrection({ attendanceLog, correction }) {
  const correctedCheckInAt = correction.correctedCheckInAt ?? attendanceLog.checkInAt;
  const correctedCheckOutAt = correction.correctedCheckOutAt ?? attendanceLog.checkOutAt;
  const originalWorkedMinutes = normalizeMinutes(attendanceLog.workedMinutes ?? inferWorkedMinutes(attendanceLog.checkInAt, attendanceLog.checkOutAt));
  const correctedWorkedMinutes = inferWorkedMinutes(correctedCheckInAt, correctedCheckOutAt);
  const originalLateMinutes = normalizeMinutes(attendanceLog.lateMinutes ?? 0);
  const correctedLateMinutes = normalizeMinutes(correction.correctedLateMinutes ?? 0);
  const workedImpactMinutes = Math.abs(correctedWorkedMinutes - originalWorkedMinutes);
  const lateImpactMinutes = Math.max(0, originalLateMinutes - correctedLateMinutes);
  const payrollImpactMinutes = Math.max(workedImpactMinutes, lateImpactMinutes);
  const approvalRequired = payrollImpactMinutes > 0 || correction.payrollImpactRupiah !== undefined;

  return {
    id: correction.id,
    attendanceLogId: attendanceLog.id,
    staffId: attendanceLog.staffId,
    correctedCheckInAt,
    correctedCheckOutAt,
    correctedLateMinutes,
    correctedWorkedMinutes,
    payrollImpactMinutes,
    payrollImpactRupiah: normalizeMoney(correction.payrollImpactRupiah ?? 0),
    reason: correction.reason,
    status: approvalRequired ? "pending" : "approved",
    approvalRequired,
    requestedByUserId: correction.requestedByUserId,
    requestedAt: correction.requestedAt ?? new Date().toISOString(),
  };
}

export function generatePayrollReadyReport(input) {
  const periodStart = input.periodStart;
  const periodEnd = input.periodEnd;
  const staffProfiles = (input.staffProfiles ?? []).filter((profile) => profile.status !== "inactive");
  const schedules = (input.schedules ?? []).filter((schedule) => isDateInPeriod(schedule.businessDate, periodStart, periodEnd));
  const attendanceLogs = (input.attendanceLogs ?? []).filter((log) => isIsoInPeriod(log.checkInAt, periodStart, periodEnd));
  const payrollAdjustments = (input.payrollAdjustments ?? []).filter(
    (adjustment) => adjustment.status !== "rejected" && isDateInPeriod(adjustment.businessDate, periodStart, periodEnd),
  );
  const lateDeductionPerMinuteRupiah = normalizeMoney(input.lateDeductionPerMinuteRupiah ?? 0);

  const rows = staffProfiles
    .map((staffProfile) => buildPayrollRow({
      staffProfile,
      schedules,
      attendanceLogs,
      payrollAdjustments,
      lateDeductionPerMinuteRupiah,
    }))
    .filter(
      (row) =>
        row.totalScheduledShifts > 0 ||
        row.totalPresent > 0 ||
        row.totalIncomplete > 0 ||
        row.totalUnscheduled > 0 ||
        row.manualAdjustmentRupiah !== 0,
    );

  return {
    periodStart,
    periodEnd,
    rows,
    summary: {
      staffCount: rows.length,
      totalScheduledShifts: sumRows(rows, "totalScheduledShifts"),
      totalPresent: sumRows(rows, "totalPresent"),
      totalLate: sumRows(rows, "totalLate"),
      totalIncomplete: sumRows(rows, "totalIncomplete"),
      totalUnscheduled: sumRows(rows, "totalUnscheduled"),
      totalWorkedMinutes: sumRows(rows, "totalWorkedMinutes"),
      totalOvertimeCandidateMinutes: sumRows(rows, "totalOvertimeCandidateMinutes"),
      basePayRupiah: sumRows(rows, "basePayRupiah"),
      lateDeductionRupiah: sumRows(rows, "lateDeductionRupiah"),
      manualAdjustmentRupiah: sumRows(rows, "manualAdjustmentRupiah"),
      estimatedPayableRupiah: sumRows(rows, "estimatedPayableRupiah"),
    },
  };
}

function buildPayrollRow({ staffProfile, schedules, attendanceLogs, payrollAdjustments, lateDeductionPerMinuteRupiah }) {
  const staffSchedules = schedules.filter((schedule) => schedule.staffId === staffProfile.id);
  const staffLogs = attendanceLogs.filter((log) => log.staffId === staffProfile.id);
  const logsBySchedule = new Map(
    staffLogs
      .filter((log) => log.shiftScheduleId ?? log.scheduleId)
      .map((log) => [log.shiftScheduleId ?? log.scheduleId, log]),
  );
  const scheduledLogs = staffSchedules.map((schedule) => ({
    schedule,
    log: logsBySchedule.get(schedule.id) ?? null,
  }));
  const unscheduledLogs = staffLogs.filter((log) => log.isUnscheduled || !(log.shiftScheduleId ?? log.scheduleId));
  const totalLateMinutes = staffLogs.reduce((sum, log) => sum + normalizeMinutes(log.lateMinutes ?? 0), 0);
  const lateDeductionRupiah = totalLateMinutes * lateDeductionPerMinuteRupiah;
  const basePayRupiah = scheduledLogs.reduce((sum, entry) => sum + calculateBasePay(entry.schedule, entry.log), 0);
  const manualAdjustmentRupiah = payrollAdjustments
    .filter((adjustment) => adjustment.staffId === staffProfile.id)
    .reduce((sum, adjustment) => sum + signedAdjustmentAmount(adjustment), 0);

  return {
    staffId: staffProfile.id,
    fullName: staffProfile.fullName,
    role: staffProfile.role,
    totalScheduledShifts: staffSchedules.length,
    totalPresent: scheduledLogs.filter((entry) => entry.log && ["present", "late", "manually_corrected"].includes(entry.log.status)).length,
    totalAbsent: scheduledLogs.filter((entry) => !entry.log).length,
    totalLate: staffLogs.filter((log) => normalizeMinutes(log.lateMinutes ?? 0) > 0).length,
    totalEarlyLeave: staffLogs.filter((log) => normalizeMinutes(log.earlyLeaveMinutes ?? 0) > 0).length,
    totalIncomplete: scheduledLogs.filter((entry) => entry.log && !entry.log.checkOutAt).length,
    totalUnscheduled: unscheduledLogs.length,
    totalWorkedMinutes: staffLogs.reduce((sum, log) => sum + normalizeMinutes(log.workedMinutes ?? 0), 0),
    totalLateMinutes,
    totalEarlyLeaveMinutes: staffLogs.reduce((sum, log) => sum + normalizeMinutes(log.earlyLeaveMinutes ?? 0), 0),
    totalOvertimeCandidateMinutes: staffLogs.reduce((sum, log) => sum + normalizeMinutes(log.overtimeCandidateMinutes ?? 0), 0),
    approvedOvertimeMinutes: staffLogs.reduce((sum, log) => sum + normalizeMinutes(log.approvedOvertimeMinutes ?? 0), 0),
    basePayRupiah,
    lateDeductionRupiah,
    manualAdjustmentRupiah,
    estimatedPayableRupiah: basePayRupiah + manualAdjustmentRupiah - lateDeductionRupiah,
  };
}

function calculateBasePay(schedule, log) {
  if (!log || !log.checkInAt) {
    return 0;
  }

  if (schedule.rateType === "per_hour") {
    return Math.round((normalizeMinutes(log.workedMinutes ?? 0) / 60) * normalizeMoney(schedule.rateAmountRupiah));
  }

  if (schedule.rateType === "monthly_allocation") {
    return 0;
  }

  return normalizeMoney(schedule.rateAmountRupiah);
}

function resolveStaffByPin({ pin, staffProfiles = [], verifyPin }) {
  const profile = staffProfiles.find((item) => {
    if (item.status !== "active") {
      return false;
    }

    if (verifyPin) {
      return verifyPin(item, pin);
    }

    return item.pinHash === `pin:${pin}`;
  });

  if (!profile) {
    throw new Error("staff_pin_invalid");
  }

  return profile;
}

function signedAdjustmentAmount(adjustment) {
  const amount = normalizeMoney(adjustment.amountRupiah);
  if (negativeAdjustmentTypes.has(adjustment.type)) {
    return -amount;
  }

  if (positiveAdjustmentTypes.has(adjustment.type)) {
    return amount;
  }

  return amount;
}

function calculateLateMinutes(schedule, checkInAt) {
  const scheduledStartAt = parseDate(schedule.scheduledStartAt);
  const graceEndsAt = addMinutes(scheduledStartAt, schedule.gracePeriodMinutes ?? 0);

  if (checkInAt.getTime() <= graceEndsAt.getTime()) {
    return 0;
  }

  return Math.max(0, diffMinutes(scheduledStartAt, checkInAt));
}

function inferWorkedMinutes(checkInAt, checkOutAt) {
  if (!checkInAt || !checkOutAt) {
    return 0;
  }

  return diffMinutes(parseDate(checkInAt), parseDate(checkOutAt));
}

function intervalsOverlap(startA, endA, startB, endB) {
  return parseDate(startA).getTime() < parseDate(endB).getTime() && parseDate(endA).getTime() > parseDate(startB).getTime();
}

function toBusinessDateTime(businessDate, time) {
  const [year, month, day] = businessDate.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function timeToMinutes(time) {
  const parts = String(time ?? "").split(":").map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error("time_format_invalid");
  }

  const [hour, minute] = parts;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("time_format_invalid");
  }

  return hour * 60 + minute;
}

function addMinutes(date, minutes) {
  return new Date(parseDate(date).getTime() + normalizeMinutes(minutes) * 60 * 1000);
}

function diffMinutes(startAt, endAt) {
  return Math.max(0, Math.round((parseDate(endAt).getTime() - parseDate(startAt).getTime()) / 60000));
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("date_invalid");
  }
  return date;
}

function isDateInPeriod(value, periodStart, periodEnd) {
  return value >= periodStart && value <= periodEnd;
}

function isIsoInPeriod(value, periodStart, periodEnd) {
  if (!value) {
    return false;
  }

  return isDateInPeriod(parseDate(value).toISOString().slice(0, 10), periodStart, periodEnd);
}

function normalizeMoney(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) {
    throw new Error("money_amount_invalid");
  }
  return Math.round(amount);
}

function normalizeMinutes(value) {
  const minutes = Number(value ?? 0);
  if (!Number.isFinite(minutes)) {
    throw new Error("minutes_invalid");
  }
  return Math.max(0, Math.round(minutes));
}

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + row[field], 0);
}
