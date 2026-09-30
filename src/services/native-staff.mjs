import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { buildNativeStaffReport, validateNativeStaffReportPeriod } from './native-staff-report.mjs';
import { attendanceEvidenceObjectKey } from './attendance-evidence-storage.mjs';

const derive = promisify(scrypt);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const roles = new Set(['cashier', 'barista', 'manager', 'kitchen', 'hr', 'other']);
const categories = new Set(['schedule_change', 'shift_swap', 'leave', 'permission', 'sick', 'overtime']);
const payRateTypes = new Set(['per_hour', 'per_shift']);
const fail = (code, statusCode = 422) => Object.assign(new Error(code), { code, statusCode });
const iso = (value) => { const date = new Date(value); if (!value || !Number.isFinite(date.getTime())) throw fail('date_invalid'); return date.toISOString(); };
const requireId = (value) => { if (!uuid.test(String(value))) throw fail('id_invalid'); return String(value); };
const clean = (value, max) => { const text = String(value ?? '').trim(); if (!text || text.length > max || /[<>]/.test(text)) throw fail('text_invalid'); return text; };
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const templateColors = new Set(['brand','blue','violet','success']);
const bands = new Set(['morning','day','evening','night']);
const rosterStatuses = new Set(['draft','review']);
const dayOffPolicies = new Set(['none','weekday_rotation_v1','schedule_rules_v1']);
const rosterPatternIds = new Set(['adaptive','balanced_4','balanced_5','weekend_peak','custom']);
const rotationModes = new Set(['balanced_cycle','stable']);
const rotationSets = new Set(['auto','A','B','C','D']);
const defaultRosterRules = Object.freeze({ minimumRestHours: 11, maxConsecutiveDays: 6, maxWeeklyHours: 48, dayOffPolicy:'none', patternId:'adaptive', rotationMode:'stable', rotationBlockDays:2, rotationSet:'auto', scheduleRows:[] });
const manualDayOffNote = '[Roster] Libur manual Owner';
const rosterDate = (value) => {
  const text = String(value ?? '');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!datePattern.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== text) throw fail('roster_date_invalid');
  return text;
};
const rosterTime = (value) => { const text = String(value ?? '').slice(0,5); if (!timePattern.test(text)) throw fail('roster_time_invalid'); return text; };
const rosterDays = (start, end) => {
  const first = rosterDate(start), last = rosterDate(end), output = [];
  for (let time=Date.parse(`${first}T00:00:00Z`), stop=Date.parse(`${last}T00:00:00Z`); time<=stop; time+=86_400_000) output.push(new Date(time).toISOString().slice(0,10));
  if (!output.length || output.length>63) throw fail('roster_period_invalid');
  return output;
};
const rosterMonthBounds = (value) => {
  const date=rosterDate(value), year=Number(date.slice(0,4)), month=Number(date.slice(5,7));
  return { start:`${date.slice(0,7)}-01`, end:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10) };
};
const localShiftRange = (businessDate, startTime, endTime) => {
  const date = rosterDate(businessDate), start = rosterTime(startTime), end = rosterTime(endTime);
  const begins = new Date(`${date}T${start}:00+07:00`);
  const endingDate = end <= start ? new Date(Date.parse(`${date}T00:00:00Z`)+86_400_000).toISOString().slice(0,10) : date;
  const finishes = new Date(`${endingDate}T${end}:00+07:00`);
  return { startAt: begins.toISOString(), endAt: finishes.toISOString() };
};
const parseRoleRequirements = (value) => {
  if (!Array.isArray(value) || value.length>roles.size) throw fail('role_requirements_invalid');
  const seen = new Set();
  return value.map((entry) => {
    const role = String(entry?.role ?? ''), count = Number(entry?.count);
    if (!roles.has(role) || seen.has(role) || !Number.isInteger(count) || count<1 || count>20) throw fail('role_requirements_invalid');
    seen.add(role); return { role, count };
  });
};
const normalizeScheduleRows = (value=[]) => {
  if(!Array.isArray(value)||value.length>7)throw fail('roster_rules_invalid');
  const seenDays=new Set();
  return value.map((row)=>{
    const dayOfWeek=Number(row?.dayOfWeek),dayOffAllowed=row?.dayOffAllowed===true;
    if(!Number.isInteger(dayOfWeek)||dayOfWeek<0||dayOfWeek>6||seenDays.has(dayOfWeek)||!Array.isArray(row?.shifts)||row.shifts.length>20)throw fail('roster_rules_invalid');
    seenDays.add(dayOfWeek);
    const seenTemplates=new Set(),shifts=row.shifts.map((entry)=>{
      const templateId=requireId(entry?.templateId),min=Number(entry?.min),max=Number(entry?.max);
      if(seenTemplates.has(templateId)||!Number.isInteger(min)||!Number.isInteger(max)||min<0||max<min||max>50)throw fail('roster_rules_invalid');
      seenTemplates.add(templateId);return {templateId,min,max};
    });
    return {dayOfWeek,dayOffAllowed,shifts};
  }).sort((a,b)=>a.dayOfWeek-b.dayOfWeek);
};
export const normalizeRosterRules = (value={}) => {
  const rules = { ...defaultRosterRules, ...(value && typeof value==='object' && !Array.isArray(value) ? value : {}) };
  if (!Number.isInteger(rules.minimumRestHours) || rules.minimumRestHours<8 || rules.minimumRestHours>24 ||
      !Number.isInteger(rules.maxConsecutiveDays) || rules.maxConsecutiveDays<1 || rules.maxConsecutiveDays>14 ||
      !Number.isInteger(rules.maxWeeklyHours) || rules.maxWeeklyHours<8 || rules.maxWeeklyHours>96 ||
      !dayOffPolicies.has(String(rules.dayOffPolicy)) || !rosterPatternIds.has(String(rules.patternId)) ||
      !rotationModes.has(String(rules.rotationMode)) || !rotationSets.has(String(rules.rotationSet)) ||
      !Number.isInteger(rules.rotationBlockDays) || rules.rotationBlockDays<1 || rules.rotationBlockDays>7) throw fail('roster_rules_invalid');
  const scheduleRows=normalizeScheduleRows(rules.scheduleRows);
  if(String(rules.dayOffPolicy)==='schedule_rules_v1'&&(scheduleRows.length!==7||!scheduleRows.some((row)=>row.dayOffAllowed)))throw fail('roster_rules_invalid');
  return { minimumRestHours:rules.minimumRestHours, maxConsecutiveDays:rules.maxConsecutiveDays, maxWeeklyHours:rules.maxWeeklyHours, dayOffPolicy:String(rules.dayOffPolicy), patternId:String(rules.patternId), rotationMode:String(rules.rotationMode), rotationBlockDays:rules.rotationBlockDays, rotationSet:String(rules.rotationSet), scheduleRows };
};
const normalizeRules = normalizeRosterRules;
const overlaps = (aStart,aEnd,bStart,bEnd) => Date.parse(aStart)<Date.parse(bEnd) && Date.parse(aEnd)>Date.parse(bStart);
const dbDate = (value) => value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
const jakartaMonthBounds = (value) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Jakarta', year:'numeric', month:'2-digit',
  }).formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type,part.value]));
  const year=Number(parts.year), month=Number(parts.month);
  return { periodStart:`${parts.year}-${parts.month}-01`, periodEnd:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10) };
};
const rosterWeekMonday = (value) => { const day=new Date(`${rosterDate(value)}T00:00:00Z`); day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7)); return day.toISOString().slice(0,10); };
const rosterDateAt = (start, offset) => new Date(Date.parse(`${start}T00:00:00Z`)+offset*86_400_000).toISOString().slice(0,10);
const fourStaffRotationRows = Object.freeze([
  Object.freeze(['L','P','S','P','P','S','S']),
  Object.freeze(['P','L','S','S','P','P','S']),
  Object.freeze(['S','S','L','S','S','P','P']),
  Object.freeze(['S','S','P','L','S','S','P']),
]);
const rotationSetOffset = (value) => ({A:0,B:1,C:2,D:3})[String(value)] ?? 0;
const mondayFirstDayIndex = (businessDate) => (new Date(`${businessDate}T00:00:00Z`).getUTCDay()+6)%7;
const localDayRange = (value) => localShiftRange(value,'00:00','00:00');
const absenceCountsAsDayOff = (absence,date) => { const bounds=localDayRange(date),start=Math.max(Date.parse(absence.startsAt??absence.starts_at),Date.parse(bounds.startAt)),end=Math.min(Date.parse(absence.endsAt??absence.ends_at),Date.parse(bounds.endAt)); return Number.isFinite(start)&&Number.isFinite(end)&&end-start>=6*3_600_000; };

export function planWeekdayDaysOff({ people=[], days=[], approvedAbsences=[], existingAssignments=[], existingDayOffs=[], allowedWeekdays=null, stableWeekdayAssignments=false, stableWeekdayOffset=0 }={}) {
  const staff=[...people].sort((a,b)=>String(a.employee_code??a.employeeCode??'').localeCompare(String(b.employee_code??b.employeeCode??''))||String(a.id).localeCompare(String(b.id)));
  const periodDays=new Set(days.map(rosterDate)), assignments=new Set(existingAssignments.map((item)=>`${item.staff_id??item.staffId}:${dbDate(item.business_date??item.businessDate)}`));
  const manualDaysOff=[...new Map(existingDayOffs.map((item)=>({staffId:item.staff_id??item.staffId,businessDate:dbDate(item.business_date??item.businessDate)})).filter((item)=>item.staffId&&periodDays.has(item.businessDate)).map((item)=>[`${item.staffId}:${item.businessDate}`,item])).values()];
  const fallback=staff.length>=5?[1,2,3,4,5]:[1,2,3,4], allowed=[...new Set((allowedWeekdays??fallback).map(Number))].filter(day=>Number.isInteger(day)&&day>=0&&day<=6).sort(), weeks=[...new Set([...periodDays].map(rosterWeekMonday))].sort();
  if(!allowed.length)throw fail('roster_rules_invalid');
  const dayOffs=[],weekendReplacements=[],conflicts=[];
  for(const monday of weeks){
    const fullWeek=Array.from({length:7},(_,index)=>rosterDateAt(monday,index));
    const weekdayByNumber=new Map(fullWeek.filter(day=>periodDays.has(day)).map(day=>[new Date(`${day}T00:00:00Z`).getUTCDay(),day]));
    const load=new Map([...weekdayByNumber.values()].map(day=>[day,0]));
    const existingForWeek=manualDaysOff.filter((item)=>rosterWeekMonday(item.businessDate)===monday).sort((a,b)=>a.businessDate.localeCompare(b.businessDate)||String(a.staffId).localeCompare(String(b.staffId)));
    const manualStaff=new Set();
    for(const item of existingForWeek){
      manualStaff.add(item.staffId);dayOffs.push({...item,weekStart:monday,source:'manual_owner'});
      const current=load.get(item.businessDate)??0;load.set(item.businessDate,current+1);
      if(current>=1)conflicts.push({staffId:item.staffId,businessDate:item.businessDate,weekStart:monday,code:'day_off_daily_limit_exceeded',severity:'error',blocking:true,message:'Lebih dari satu orang memiliki libur terjadwal pada tanggal yang sama. Maksimal satu orang per hari.'});
    }
    const rotation=stableWeekdayAssignments?0:Math.floor(Date.parse(`${monday}T00:00:00Z`)/604_800_000);
    for(let index=0;index<staff.length;index++){
      const person=staff[index];if(manualStaff.has(person.id))continue;
      const approvedException=fullWeek.filter(day=>!allowed.includes(new Date(`${day}T00:00:00Z`).getUTCDay())).find(day=>approvedAbsences.some(item=>(item.staff_id??item.staffId)===person.id&&absenceCountsAsDayOff(item,day)));
      if(approvedException){weekendReplacements.push({staffId:person.id,businessDate:approvedException,weekStart:monday,source:'approved_exception_request'});continue;}
      const preferred=(index+rotation+stableWeekdayOffset)%allowed.length;
      if(periodDays.size&&fullWeek.some((day)=>!periodDays.has(day))&&!weekdayByNumber.has(allowed[preferred]))continue;
      const candidates=allowed.map((_,offset)=>({day:weekdayByNumber.get(allowed[(preferred+offset)%allowed.length]),priority:offset})).filter(item=>item.day)
        .filter(item=>!assignments.has(`${person.id}:${item.day}`)&&(load.get(item.day)??0)<1).sort((a,b)=>(load.get(a.day)-load.get(b.day))||a.priority-b.priority||a.day.localeCompare(b.day));
      const chosen=candidates[0]?.day;
      if(!chosen){
        if(allowed.some(dayNumber=>weekdayByNumber.has(dayNumber)))conflicts.push({staffId:person.id,weekStart:monday,code:'day_off_daily_limit_unavailable',severity:'error',blocking:true,message:'Libur mingguan belum dapat ditempatkan karena semua tanggal yang diizinkan sudah dipakai satu orang.'});
        continue;
      }
      load.set(chosen,(load.get(chosen)??0)+1);dayOffs.push({staffId:person.id,businessDate:chosen,weekStart:monday,source:'automatic_weekday'});
    }
  }
  return {dayOffs,weekendReplacements,conflicts,allowedWeekdays:allowed};
}

const scheduleRowFor = (rules,businessDate) => rules.scheduleRows.find((row)=>row.dayOfWeek===new Date(`${businessDate}T00:00:00Z`).getUTCDay())??null;
const coverageFor = (rules,businessDate,templateId) => scheduleRowFor(rules,businessDate)?.shifts.find((entry)=>entry.templateId===templateId)??null;

async function passwordHash(password) {
  const salt = randomBytes(24);
  const key = await derive(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:n=16384,r=8,p=1:${salt.toString('base64url')}:${key.toString('base64url')}`;
}
async function passwordMatches(password, encoded) {
  const [algorithm, parameters, saltText, keyText] = String(encoded ?? '').split(':');
  if (algorithm !== 'scrypt' || parameters !== 'n=16384,r=8,p=1') return false;
  const salt = Buffer.from(saltText ?? '', 'base64url');
  const expected = Buffer.from(keyText ?? '', 'base64url');
  if (salt.length < 16 || expected.length !== 32) return false;
  const actual = await derive(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export function createNativeStaffService({ db, ids, clock = () => new Date(), attendanceEvidenceStorage = null }) {
  if (!db?.query || !db?.transaction || !uuid.test(ids?.organizationId) || !uuid.test(ids?.outletId)) throw Error('native_staff_runtime_required');
  const org = ids.organizationId, outlet = ids.outletId;
  // Prototype v1 is deliberately schema-neutral so the established 34-entry
  // production migration ledger and rollback contract remain byte-identical.
  const attendanceChallenges=new Map(),attendanceEvidence=new Map();
  let schemaNeutralPolicy={timezone:'Asia/Jakarta',earlyOpenMinutes:60,lateCheckInMinutes:60,postCloseMinutes:60,minimumWorkedMinutes:30,earlyLeaveReviewMinutes:30,anytimeTestMode:false,gpsRequired:true,selfieRequired:true,maxAccuracyMeters:100,geofenceRadiusMeters:100,
    outletLatitude:null,outletLongitude:null,geofenceAction:'REVIEW',enforcementState:'ACTIVE',version:1,updatedAt:null,updatedBy:null,evidenceRetentionDays:30};
  const own = (staffId, work) => db.transaction(async (tx) => {
    await tx.query("select set_config('app.current_user_id','',true),set_config('app.native_staff_id',$1,true)", [staffId]);
    return work(tx);
  });
  const attendanceAudit=(eventType,aggregateId,actorReference,payload={},executor=db)=>executor.query(`insert into sagaops.native_attendance_audit_log(organization_id,outlet_id,actor_profile_id,actor_reference,event_type,aggregate_id,payload_redacted) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,[org,outlet,ids.ownerProfileId,String(actorReference??'OWNER').slice(0,80),eventType,aggregateId??null,JSON.stringify(payload)]);
  const profile = (row) => {
    const amount=Number(row.payroll_rate_amount_rupiah??0),type=payRateTypes.has(String(row.payroll_rate_type))?String(row.payroll_rate_type):null;
    return { id:row.id,employeeCode:row.employee_code,name:row.full_name,role:row.role,status:row.status,
      payRateType:amount>0?type:null,payRateRupiah:amount>0?amount:0,
      payRateUpdatedAt:dateIso(row.updated_at),profileUpdatedAt:dateIso(row.updated_at) };
  };
  const templateView = (row) => ({ id:row.id,name:row.name,code:row.code,startTime:String(row.start_time).slice(0,5),endTime:String(row.end_time).slice(0,5),breakMinutes:row.break_minutes,lateGraceMinutes:row.late_grace_minutes,color:row.color,band:row.band,roleRequirements:row.role_requirements,state:row.state });
  const periodView = (row) => ({ id:row.id,periodStart:dbDate(row.period_start),periodEnd:dbDate(row.period_end),status:row.status,rules:row.rules,version:row.version,publishedAt:row.published_at });
  const assignmentView = (row) => ({ id:row.id,periodId:row.roster_period_id,staffId:row.staff_id,templateId:row.shift_template_id,businessDate:dbDate(row.business_date),startAt:row.scheduled_start_at,endAt:row.scheduled_end_at,shiftName:row.shift_name_snapshot,graceMinutes:row.grace_minutes_snapshot,role:row.role_snapshot,source:row.source,locked:row.locked,notes:row.notes,explanation:row.explanation,publishedScheduleId:row.published_schedule_id });
  async function listOwner() {
    const staff = await db.query(`select p.id,p.employee_code,p.full_name,p.role,p.status,p.payroll_rate_type,p.payroll_rate_amount_rupiah,p.updated_at,c.state as account_state,c.temporary_expires_at
      from sagaops.staff_profiles p left join sagaops.native_staff_credentials c on c.staff_id=p.id
      where p.organization_id=$1 and p.outlet_id=$2 and p.employee_code is not null order by p.created_at desc limit 100`, [org, outlet]);
    const schedules = await db.query(`select s.id,s.staff_id,s.shift_name,s.scheduled_start_at,s.scheduled_end_at,s.status,s.notes
      from sagaops.shift_schedules s where s.organization_id=$1 and s.outlet_id=$2 and s.scheduled_end_at>now()-interval '7 days'
      order by s.scheduled_start_at asc limit 150`, [org, outlet]);
    const attendance = await db.query(`select a.id,a.staff_id,a.shift_schedule_id,a.check_in_at,a.check_out_at,a.status,a.is_unscheduled,a.late_minutes,a.worked_minutes,a.note
      from sagaops.attendance_logs a join sagaops.staff_profiles p on p.id=a.staff_id
      where a.organization_id=$1 and a.outlet_id=$2 and p.employee_code is not null order by a.check_in_at desc limit 100`, [org, outlet]);
    const reviews=await db.query(`select r.id,r.staff_id,r.schedule_id,r.reason,r.starts_at as proposed_at,r.state as status,r.reviewer_note as review_note,r.created_at,p.full_name as staff_name
      from sagaops.native_staff_requests r join sagaops.staff_profiles p on p.id=r.staff_id where r.organization_id=$1 and p.outlet_id=$2 and r.reason like 'ATTENDANCE_CORRECTION_V1|%' order by (r.state='submitted') desc,r.created_at desc limit 100`,[org,outlet]);
    const requests = await db.query(`select r.id,r.staff_id,r.schedule_id,r.target_staff_id,r.target_schedule_id,r.category,r.reason,r.starts_at,r.ends_at,r.state,r.reviewer_note,r.reviewed_at,r.created_at
      from sagaops.native_staff_requests r join sagaops.staff_profiles p on p.id=r.staff_id and p.organization_id=r.organization_id
      where r.organization_id=$1 and p.outlet_id=$2 and r.reason not like 'ATTENDANCE_CORRECTION_V1|%' order by r.created_at desc limit 100`, [org,outlet]);
    const templates = await db.query(`select id,name,code,start_time,end_time,break_minutes,late_grace_minutes,color,band,role_requirements,state
      from sagaops.native_shift_templates where organization_id=$1 and outlet_id=$2 order by state,name`,[org,outlet]);
    const periods = await db.query(`select id,period_start,period_end,status,rules,version,published_at,updated_at from sagaops.native_roster_periods
      where organization_id=$1 and outlet_id=$2 and period_end>=current_date-31 order by period_start desc limit 12`,[org,outlet]);
    const assignments = await db.query(`select a.* from sagaops.native_roster_assignments a join sagaops.native_roster_periods p on p.id=a.roster_period_id
      where a.organization_id=$1 and a.outlet_id=$2 and p.period_end>=current_date-31 order by a.business_date,a.scheduled_start_at`,[org,outlet]);
    const availability = await db.query(`select id,staff_id,starts_at,ends_at,kind,preferred_template_id,note from sagaops.native_staff_availability
      where organization_id=$1 and outlet_id=$2 and ends_at>now()-interval '31 days' order by starts_at`,[org,outlet]);
    const generationRuns = await db.query(`select distinct on (roster_period_id) id,roster_period_id,algorithm_version,parameters,summary,conflicts,created_at
      from sagaops.native_roster_generation_runs where organization_id=$1 and outlet_id=$2
      order by roster_period_id,created_at desc`,[org,outlet]);
    const activePeriod=periods.rows.find((row)=>row.status==='draft'||row.status==='review')??null;
    const activeValidation=activePeriod?await rosterValidation(db,activePeriod):null;
    const liveConflictsByPeriod=new Map(activePeriod?[[activePeriod.id,activeValidation.conflicts]]:[]);
    const visibleGenerationRuns=generationRuns.rows.map((row)=>({...row,conflicts:liveConflictsByPeriod.get(row.roster_period_id)??row.conflicts}));
    const latestGeneration=[...visibleGenerationRuns].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0]??null;
    const policy=await attendancePolicy(db);
    const attendanceRows=attendance.rows.map((row)=>{const envelope=parseAttendanceEnvelope(row.note);return {...row,staffId:row.staff_id,scheduleId:row.shift_schedule_id,checkInAt:row.check_in_at,checkOutAt:row.check_out_at,
      lateMinutes:row.late_minutes,workedMinutes:row.worked_minutes,reviewStatus:row.review_status,reviewReason:row.review_reason,
      checkInEvidence:row.check_in_evidence??envelope?.checkInEvidence??null,checkOutEvidence:row.check_out_evidence??envelope?.checkOutEvidence??null,
      reviewStatus:row.review_status??envelope?.reviewStatus??'NOT_REQUIRED',reviewReason:row.review_reason??envelope?.reviewReason??null};});
    const reviewRows=reviews.rows.map((row)=>{const detail=parseCorrectionReason(row.reason);return {...row,attendanceId:detail?.attendanceId??null,scheduleId:row.schedule_id,staffId:row.staff_id,type:detail?.type??null,reason:detail?.reason??row.reason,evidence:detail?.evidence??null,proposedAt:row.proposed_at};});
    return { staff: staff.rows.map((row) => ({ ...profile(row), accountState: row.account_state,temporaryExpiresAt:dateIso(row.temporary_expires_at) })), schedules: schedules.rows, attendance: attendanceRows, attendanceReviews:reviewRows, requests: requests.rows,
      shiftTemplates:templates.rows.map(templateView), rosterPeriods:periods.rows.map(periodView), rosterAssignments:assignments.rows.map(assignmentView),
      staffAvailability:availability.rows.map((row)=>({id:row.id,staffId:row.staff_id,startAt:row.starts_at,endAt:row.ends_at,kind:row.kind,templateId:row.preferred_template_id,note:row.note})),
      rosterGenerationRuns:visibleGenerationRuns.map((row)=>({id:row.id,periodId:row.roster_period_id,algorithmVersion:row.algorithm_version,parameters:row.parameters,summary:row.summary,conflicts:row.conflicts,createdAt:row.created_at})),
      rosterConflicts:activeValidation?.conflicts ?? latestGeneration?.conflicts ?? [], attendancePolicy:policy };
  }
  async function report({ from, to } = {}) {
    const { periodStart, periodEnd } = validateNativeStaffReportPeriod(from,to);
    const [staff,schedules,attendance,requests] = await Promise.all([
      db.query(`select id,employee_code,full_name,role,status from sagaops.staff_profiles
        where organization_id=$1 and outlet_id=$2 and employee_code is not null and status<>'inactive' order by full_name`,[org,outlet]),
      db.query(`select id,staff_id,business_date,scheduled_start_at,scheduled_end_at,status,payroll_rate_type as rate_type,payroll_rate_amount_rupiah as rate_amount_rupiah
        from sagaops.shift_schedules where organization_id=$1 and outlet_id=$2 and business_date between $3::date and $4::date
        order by business_date,scheduled_start_at`,[org,outlet,periodStart,periodEnd]),
      db.query(`select a.id,a.staff_id,a.shift_schedule_id,a.check_in_at,a.check_out_at,a.status,a.is_unscheduled,a.late_minutes,a.early_leave_minutes,
          a.worked_minutes,a.overtime_candidate_minutes,a.approved_overtime_minutes,a.note
        from sagaops.attendance_logs a left join sagaops.shift_schedules s on s.id=a.shift_schedule_id
          and s.organization_id=a.organization_id and s.outlet_id=a.outlet_id and s.staff_id=a.staff_id
        where a.organization_id=$1 and a.outlet_id=$2
          and coalesce(s.business_date,(a.check_in_at at time zone 'Asia/Jakarta')::date) between $3::date and $4::date order by a.check_in_at`,[org,outlet,periodStart,periodEnd]),
      db.query(`select r.staff_id,r.category,r.state,r.starts_at,r.ends_at from sagaops.native_staff_requests r
        join sagaops.staff_profiles p on p.id=r.staff_id and p.organization_id=r.organization_id
        where r.organization_id=$1 and p.outlet_id=$2 and r.state='approved' and r.category in ('leave','permission','sick')
          and r.starts_at<($4::date+1)::timestamptz and r.ends_at>$3::date::timestamptz`,[org,outlet,periodStart,periodEnd]),
    ]);
    const attendanceRows=attendance.rows.map((row)=>({...row,review_status:parseAttendanceEnvelope(row.note)?.reviewStatus??'NOT_REQUIRED'}));
    return buildNativeStaffReport({periodStart,periodEnd,generatedAt:clock().toISOString(),staff:staff.rows,schedules:schedules.rows,
      attendance:attendanceRows,requests:requests.rows,adjustments:[]});
  }
  async function createAccount({ name, role }) {
    const fullName = clean(name, 80);
    if (!roles.has(role)) throw fail('role_invalid');
    const temporaryPassword = randomBytes(18).toString('base64url');
    const hash = await passwordHash(temporaryPassword);
    const expiresAt = new Date(clock().getTime() + 24 * 60 * 60_000).toISOString();
    const account = await db.transaction(async (tx) => {
      const codeValue = (await tx.query("select nextval('sagaops.native_staff_code_sequence') as value")).rows[0].value;
      const code = `STF-${String(codeValue).padStart(6, '0')}`;
      const row = (await tx.query(`insert into sagaops.staff_profiles(organization_id,outlet_id,full_name,role,employee_code)
        values($1,$2,$3,$4,$5) returning id,employee_code,full_name,role,status`, [org, outlet, fullName, role, code])).rows[0];
      await tx.query(`insert into sagaops.native_staff_credentials(staff_id,organization_id,password_hash,state,temporary_expires_at)
        values($1,$2,$3,'temporary',$4)`, [row.id, org, hash, expiresAt]);
      return profile(row);
    });
    return { account, temporaryPassword, expiresAt };
  }
  async function resetPassword(staffId) {
    const id = requireId(staffId);
    const temporaryPassword = randomBytes(18).toString('base64url');
    const hash = await passwordHash(temporaryPassword);
    const expiresAt = new Date(clock().getTime() + 24 * 60 * 60_000).toISOString();
    const row = (await db.query(`update sagaops.native_staff_credentials c set password_hash=$3,state='temporary',temporary_expires_at=$4,
      password_changed_at=null,version=version+1,updated_at=now() from sagaops.staff_profiles p
      where c.staff_id=p.id and p.id=$1 and p.organization_id=$2 and p.outlet_id=$5 and p.status='active'
      returning p.employee_code`, [id, org, hash, expiresAt, outlet])).rows[0];
    if (!row) throw fail('staff_not_found', 404);
    return { employeeCode: row.employee_code, temporaryPassword, expiresAt };
  }
  async function setAccountState(staffId, state) {
    if (!['active','suspended'].includes(state)) throw fail('state_invalid');
    const id = requireId(staffId);
    const result = await db.query(`update sagaops.native_staff_credentials c set state=$3,version=version+1,updated_at=now()
      from sagaops.staff_profiles p where c.staff_id=p.id and p.id=$1 and p.organization_id=$2 and p.outlet_id=$4
      and ($3 <> 'active' or c.password_changed_at is not null)
      returning c.staff_id`, [id, org, state, outlet]);
    if (!result.rows.length) throw fail('staff_not_found_or_reset_required', 409);
    return { staffId: id, state };
  }
  async function updateProfile({ staffId, name, role, expectedUpdatedAt }) {
    const id=requireId(staffId),fullName=clean(name,80),expected=iso(expectedUpdatedAt);
    if(!roles.has(role))throw fail('role_invalid');
    const row=(await db.query(`update sagaops.staff_profiles set
      full_name=$4,role=$5,updated_at=greatest(now(),updated_at+interval '1 millisecond')
      where id=$1 and organization_id=$2 and outlet_id=$3 and employee_code is not null
        and date_trunc('milliseconds',updated_at)=$6::timestamptz
      returning id,employee_code,full_name,role,status,payroll_rate_type,payroll_rate_amount_rupiah,updated_at`,[id,org,outlet,fullName,role,expected])).rows[0];
    if(!row)throw fail('profile_conflict_or_staff_not_found',409);
    return profile(row);
  }
  async function setPayRate({ staffId, rateType, amountRupiah, expectedUpdatedAt }) {
    const id=requireId(staffId),type=String(rateType??''),amount=Number(amountRupiah),expected=iso(expectedUpdatedAt);
    if(!payRateTypes.has(type)||!Number.isSafeInteger(amount)||amount<1||amount>100_000_000)throw fail('pay_rate_invalid');
    const row=(await db.query(`update sagaops.staff_profiles set
      payroll_rate_type=$4,payroll_rate_amount_rupiah=$5,updated_at=now()
      where id=$1 and organization_id=$2 and outlet_id=$3 and employee_code is not null
        and date_trunc('milliseconds',updated_at)=$6::timestamptz
      returning id,employee_code,full_name,role,status,payroll_rate_type,payroll_rate_amount_rupiah,updated_at`,[id,org,outlet,type,amount,expected])).rows[0];
    if(!row)throw fail('pay_rate_conflict_or_staff_not_found',409);
    return profile(row);
  }
  async function assignSchedule({ staffId, name, startAt, endAt, notes }) {
    const id = requireId(staffId), shiftName = clean(name, 80), start = iso(startAt), end = iso(endAt);
    if (Date.parse(end) <= Date.parse(start) || Date.parse(end)-Date.parse(start) > 24 * 60 * 60_000) throw fail('schedule_time_invalid');
    const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start));
    const row = await db.transaction(async(tx)=>{
      await tx.query("select set_config('app.native_roster_publish','authorized',true)");
      return (await tx.query(`insert into sagaops.shift_schedules(organization_id,outlet_id,staff_id,business_date,scheduled_start_at,scheduled_end_at,shift_name,notes,payroll_rate_type,payroll_rate_amount_rupiah)
        select $1,$2,p.id,$3::date,$4::timestamptz,$5::timestamptz,$6,$7,p.payroll_rate_type,p.payroll_rate_amount_rupiah
        from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
        where p.id=$8 and p.organization_id=$1 and p.outlet_id=$2 and p.status='active' and p.employee_code is not null and c.state<>'suspended'
        and not exists(select 1 from sagaops.shift_schedules s where s.staff_id=p.id and s.status='scheduled'
          and s.scheduled_start_at<$5::timestamptz and s.scheduled_end_at>$4::timestamptz)
        returning id,staff_id,shift_name,scheduled_start_at,scheduled_end_at,status,notes`, [org, outlet, businessDate, start, end, shiftName, notes ? clean(notes, 200) : null, id])).rows[0];
    });
    if (!row) throw fail('schedule_overlap_or_staff_not_found', 409);
    return row;
  }
  async function updateSchedule({ scheduleId, name, startAt, endAt, notes, status }) {
    const id = requireId(scheduleId), shiftName = clean(name, 80), start = iso(startAt), end = iso(endAt);
    if (Date.parse(end) <= Date.parse(start) || Date.parse(end)-Date.parse(start) > 24*60*60_000) throw fail('schedule_time_invalid');
    if (!['scheduled','cancelled'].includes(status)) throw fail('schedule_status_invalid');
    const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Jakarta', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(start));
    const row = await db.transaction(async(tx)=>{
      await tx.query("select set_config('app.native_roster_mutation','authorized',true)");
      return (await tx.query(`update sagaops.shift_schedules s set business_date=$4::date,scheduled_start_at=$5,scheduled_end_at=$6,
        shift_name=$7,notes=$8,status=$9,updated_at=now() where s.id=$1 and s.organization_id=$2 and s.outlet_id=$3
        and not exists(select 1 from sagaops.attendance_logs a where a.shift_schedule_id=s.id)
        and not exists(select 1 from sagaops.shift_schedules other where other.staff_id=s.staff_id and other.id<>s.id
          and other.status='scheduled' and other.scheduled_start_at<$6::timestamptz and other.scheduled_end_at>$5::timestamptz)
        returning id,staff_id,shift_name,scheduled_start_at,scheduled_end_at,status,notes`, [id, org, outlet, businessDate, start, end, shiftName, notes ? clean(notes,200) : null, status])).rows[0];
    });
    if (!row) throw fail('schedule_locked_or_missing', 409);
    return row;
  }
  function templateInput(input) {
    const name=clean(input?.name,80), code=String(input?.code??'').trim().toUpperCase();
    const startTime=rosterTime(input?.startTime), endTime=rosterTime(input?.endTime);
    const breakMinutes=Number(input?.breakMinutes??0), lateGraceMinutes=Number(input?.lateGraceMinutes??0);
    const color=String(input?.color??'brand'), roleRequirements=parseRoleRequirements(input?.roleRequirements??[]);
    const band=String(input?.band??(startTime<'10:00'?'morning':startTime<'15:00'?'day':startTime<'20:00'?'evening':'night'));
    const [startHour,startMinute]=startTime.split(':').map(Number), [endHour,endMinute]=endTime.split(':').map(Number);
    const startMinutes=startHour*60+startMinute, endMinutes=endHour*60+endMinute;
    const durationMinutes=(endMinutes-startMinutes+24*60)%(24*60);
    if (!/^[A-Z0-9_-]{1,8}$/.test(code) || !templateColors.has(color) || !bands.has(band) || !Number.isInteger(breakMinutes) || breakMinutes<0 || breakMinutes>240 || !Number.isInteger(lateGraceMinutes) || lateGraceMinutes<0 || lateGraceMinutes>120) throw fail('shift_template_invalid');
    if(durationMinutes<60||durationMinutes>12*60||breakMinutes>=durationMinutes)throw fail('shift_template_invalid');
    return {name,code,startTime,endTime,breakMinutes,lateGraceMinutes,color,roleRequirements,band};
  }
  async function createShiftTemplate(input) {
    const value=templateInput(input);
    try {
      const row=(await db.query(`insert into sagaops.native_shift_templates(organization_id,outlet_id,name,code,start_time,end_time,break_minutes,late_grace_minutes,color,band,role_requirements)
        values($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9,$10,$11::jsonb) returning id,name,code,start_time,end_time,break_minutes,late_grace_minutes,color,band,role_requirements,state`,
        [org,outlet,value.name,value.code,value.startTime,value.endTime,value.breakMinutes,value.lateGraceMinutes,value.color,value.band,JSON.stringify(value.roleRequirements)])).rows[0];
      return templateView(row);
    } catch (error) { if (error?.code==='23505') throw fail('shift_template_code_exists',409); throw error; }
  }
  async function updateShiftTemplate(input) {
    const id=requireId(input?.templateId), value=templateInput(input);
    try {
      const row=(await db.query(`update sagaops.native_shift_templates set name=$4,code=$5,start_time=$6::time,end_time=$7::time,break_minutes=$8,late_grace_minutes=$9,color=$10,band=$11,role_requirements=$12::jsonb,updated_at=now()
        where id=$1 and organization_id=$2 and outlet_id=$3 returning id,name,code,start_time,end_time,break_minutes,late_grace_minutes,color,band,role_requirements,state`,
        [id,org,outlet,value.name,value.code,value.startTime,value.endTime,value.breakMinutes,value.lateGraceMinutes,value.color,value.band,JSON.stringify(value.roleRequirements)])).rows[0];
      if(!row) throw fail('shift_template_not_found',404); return templateView(row);
    } catch (error) { if (error?.code==='23505') throw fail('shift_template_code_exists',409); throw error; }
  }
  async function setShiftTemplateState(templateId,state) {
    const id=requireId(templateId), next=String(state??''); if(!['active','inactive'].includes(next)) throw fail('shift_template_state_invalid');
    const row=(await db.query(`update sagaops.native_shift_templates set state=$4,updated_at=now() where id=$1 and organization_id=$2 and outlet_id=$3
      returning id,name,code,start_time,end_time,break_minutes,late_grace_minutes,color,band,role_requirements,state`,[id,org,outlet,next])).rows[0];
    if(!row) throw fail('shift_template_not_found',404); return templateView(row);
  }
  async function ensurePeriod(tx,input,{lock=false}={}) {
    if(input?.periodId){
      const id=requireId(input.periodId); let row=(await tx.query(`select * from sagaops.native_roster_periods where id=$1 and organization_id=$2 and outlet_id=$3${lock?' for update':''}`,[id,org,outlet])).rows[0];
      if(!row) throw fail('roster_period_not_found',404);
      if(input.expectedVersion!=null&&Number(input.expectedVersion)!==row.version)throw fail('roster_version_conflict',409);
      if(input.rules!=null){
        if(row.status!=='draft')throw fail('roster_period_locked',409);
        row=(await tx.query(`update sagaops.native_roster_periods set rules=$2::jsonb,version=version+1,updated_at=now() where id=$1 returning *`,[id,JSON.stringify(normalizeRules(input.rules))])).rows[0];
      }
      return row;
    }
    let periodStart=input?.periodStart,periodEnd=input?.periodEnd;
    if(!periodStart||!periodEnd){const inferred=rosterMonthBounds(input?.businessDate??input?.dateFrom??input?.sourceStart);periodStart=inferred.start;periodEnd=inferred.end;}
    const days=rosterDays(periodStart,periodEnd), rules=normalizeRules(input?.rules), hasRules=input?.rules!=null;
    let row=(await tx.query(`insert into sagaops.native_roster_periods(organization_id,outlet_id,period_start,period_end,rules)
      values($1,$2,$3::date,$4::date,$5::jsonb) on conflict(organization_id,outlet_id,period_start,period_end)
      do update set rules=case when $6 then excluded.rules else sagaops.native_roster_periods.rules end,
        version=case when $6 then sagaops.native_roster_periods.version+1 else sagaops.native_roster_periods.version end,
        updated_at=case when $6 then now() else sagaops.native_roster_periods.updated_at end
      where not $6 or sagaops.native_roster_periods.status='draft'
      returning *`,[org,outlet,days[0],days.at(-1),JSON.stringify(rules),hasRules])).rows[0];
    if(!row){
      row=(await tx.query(`select * from sagaops.native_roster_periods where organization_id=$1 and outlet_id=$2 and period_start=$3::date and period_end=$4::date${lock?' for update':''}`,[org,outlet,days[0],days.at(-1)])).rows[0];
      if(!row)throw fail('roster_period_not_found',404);
      if(hasRules)throw fail('roster_period_locked',409);
    }
    return lock?(await tx.query(`select * from sagaops.native_roster_periods where id=$1 for update`,[row.id])).rows[0]:row;
  }
  const audit=async(tx,periodId,action,details={})=>tx.query(`insert into sagaops.native_roster_audit_log(roster_period_id,organization_id,outlet_id,action,actor_user_id,details)
    values($1,$2,$3,$4,$5,$6::jsonb)`,[periodId,org,outlet,action,ids.ownerProfileId,JSON.stringify(details)]);
  const bumpPeriod=async(tx,periodId)=>(await tx.query(`update sagaops.native_roster_periods set version=version+1,updated_at=now() where id=$1 returning *`,[periodId])).rows[0];
  async function loadRoster(input={}) {
    return db.transaction(async(tx)=>{
      const period=await ensurePeriod(tx,input);
      const assignments=(await tx.query(`select * from sagaops.native_roster_assignments where roster_period_id=$1 and organization_id=$2 and outlet_id=$3 order by business_date,scheduled_start_at`,[period.id,org,outlet])).rows;
      const generation=(await tx.query(`select id,algorithm_version,parameters,summary,conflicts,created_at from sagaops.native_roster_generation_runs where roster_period_id=$1 order by created_at desc limit 1`,[period.id])).rows[0]??null;
      return {period:periodView(period),assignments:assignments.map(assignmentView),conflicts:generation?.conflicts??[],generation};
    });
  }
  async function assignmentInputs(tx,period,{staffId,templateId,businessDate}) {
    const staff=requireId(staffId), template=requireId(templateId), date=rosterDate(businessDate);
    if(date<dbDate(period.period_start)||date>dbDate(period.period_end)) throw fail('roster_assignment_outside_period');
    const person=(await tx.query(`select p.id,p.role from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
      where p.id=$1 and p.organization_id=$2 and p.outlet_id=$3 and p.status='active' and p.employee_code is not null and c.state<>'suspended'`,[staff,org,outlet])).rows[0];
    const shift=(await tx.query(`select * from sagaops.native_shift_templates where id=$1 and organization_id=$2 and outlet_id=$3 and state='active'`,[template,org,outlet])).rows[0];
    if(!person||!shift) throw fail('roster_staff_or_template_not_found',404);
    const requirements=Array.isArray(shift.role_requirements)?shift.role_requirements:[];
    if(requirements.length&&!requirements.some((entry)=>entry.role===person.role)) throw fail('roster_role_mismatch',409);
    const range=localShiftRange(date,String(shift.start_time).slice(0,5),String(shift.end_time).slice(0,5));
    return {staff,template,date,person,shift,...range};
  }
  async function hardConflicts(tx,period,candidate,{excludeAssignmentId=null,excludeAssignmentIds=[],excludeScheduleIds=[]}={}) {
    const rules=normalizeRules(period.rules), minimumRestMs=rules.minimumRestHours*3_600_000, conflicts=[];
    const assignmentExclusions=[...new Set([excludeAssignmentId,...excludeAssignmentIds].filter(Boolean))];
    const scheduleExclusions=[...new Set(excludeScheduleIds.filter(Boolean))];
    const unavailable=(await tx.query(`select 1 from sagaops.native_staff_availability where organization_id=$1 and outlet_id=$2 and staff_id=$3 and kind='unavailable'
      and starts_at<$5::timestamptz and ends_at>$4::timestamptz limit 1`,[org,outlet,candidate.staff,candidate.startAt,candidate.endAt])).rows.length;
    const approvedLeave=(await tx.query(`select 1 from sagaops.native_staff_requests where organization_id=$1 and staff_id=$2 and state='approved' and category in ('leave','permission','sick')
      and starts_at<$4::timestamptz and ends_at>$3::timestamptz limit 1`,[org,candidate.staff,candidate.startAt,candidate.endAt])).rows.length;
    if(unavailable||approvedLeave) conflicts.push('unavailable');
    const nearby=(await tx.query(`select id,business_date,scheduled_start_at,scheduled_end_at from sagaops.native_roster_assignments where roster_period_id=$1 and staff_id=$2 and not (id=any($3::uuid[]))
      union all select id,business_date,scheduled_start_at,scheduled_end_at from sagaops.shift_schedules where organization_id=$4 and outlet_id=$5 and staff_id=$2 and status='scheduled'
      and not (id=any($6::uuid[]))
      and not exists(select 1 from sagaops.native_roster_assignments a where a.published_schedule_id=shift_schedules.id and a.roster_period_id=$1)`,[period.id,candidate.staff,assignmentExclusions,org,outlet,scheduleExclusions])).rows;
    for(const item of nearby){
      if(overlaps(candidate.startAt,candidate.endAt,item.scheduled_start_at,item.scheduled_end_at)){conflicts.push('overlap');break;}
      const before=Date.parse(candidate.startAt)>=Date.parse(item.scheduled_end_at)?Date.parse(candidate.startAt)-Date.parse(item.scheduled_end_at):Date.parse(item.scheduled_start_at)-Date.parse(candidate.endAt);
      if(before>=0&&before<minimumRestMs){conflicts.push('minimum_rest');break;}
    }
    const candidateDate=candidate.date??dbDate(candidate.startAt);
    const candidateDay=new Date(`${candidateDate}T00:00:00Z`), monday=new Date(candidateDay);
    monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
    const sunday=new Date(monday); sunday.setUTCDate(sunday.getUTCDate()+6);
    const weeklyHours=nearby.filter((item)=>{const day=new Date(`${dbDate(item.business_date)}T00:00:00Z`);return day>=monday&&day<=sunday;})
      .reduce((sum,item)=>sum+(Date.parse(item.scheduled_end_at)-Date.parse(item.scheduled_start_at))/3_600_000,0)
      +(Date.parse(candidate.endAt)-Date.parse(candidate.startAt))/3_600_000;
    if(weeklyHours>rules.maxWeeklyHours)conflicts.push('weekly_hours');
    const workedDates=new Set(nearby.map((item)=>dbDate(item.business_date))); workedDates.add(candidateDate);
    let streak=1, cursor=new Date(candidateDay);
    for(cursor.setUTCDate(cursor.getUTCDate()-1);workedDates.has(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()-1))streak++;
    cursor=new Date(candidateDay);
    for(cursor.setUTCDate(cursor.getUTCDate()+1);workedDates.has(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1))streak++;
    if(streak>rules.maxConsecutiveDays)conflicts.push('consecutive_days');
    return [...new Set(conflicts)];
  }
  async function putAssignment(tx,period,input,{source='manual',explanation={},preserveLocked=false}={}) {
    if(period.status!=='draft') throw fail('roster_period_locked',409);
    const candidate=await assignmentInputs(tx,period,input), existing=(await tx.query(`select id,locked from sagaops.native_roster_assignments where roster_period_id=$1 and staff_id=$2 and business_date=$3::date`,[period.id,candidate.staff,candidate.date])).rows[0];
    if(existing?.locked&&(preserveLocked||input?.locked!==false))throw fail('roster_assignment_locked',409);
    const conflicts=await hardConflicts(tx,period,candidate,{excludeAssignmentId:existing?.id??null});
    if(conflicts.length) throw fail(`roster_${conflicts[0]}`,409);
    const row=(await tx.query(`insert into sagaops.native_roster_assignments(roster_period_id,organization_id,outlet_id,staff_id,shift_template_id,business_date,scheduled_start_at,scheduled_end_at,shift_name_snapshot,grace_minutes_snapshot,role_snapshot,source,locked,notes,explanation)
      values($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      on conflict(roster_period_id,staff_id,business_date) do update set shift_template_id=excluded.shift_template_id,scheduled_start_at=excluded.scheduled_start_at,
      scheduled_end_at=excluded.scheduled_end_at,shift_name_snapshot=excluded.shift_name_snapshot,grace_minutes_snapshot=excluded.grace_minutes_snapshot,
      role_snapshot=excluded.role_snapshot,source=excluded.source,locked=excluded.locked,notes=excluded.notes,explanation=excluded.explanation,updated_at=now()
      returning *`,[period.id,org,outlet,candidate.staff,candidate.template,candidate.date,candidate.startAt,candidate.endAt,candidate.shift.name,candidate.shift.late_grace_minutes,candidate.person.role,source,input.locked===true,input.notes?clean(input.notes,200):null,JSON.stringify(explanation)])).rows[0];
    return assignmentView(row);
  }
  async function saveRosterAssignment(input) {
    return db.transaction(async(tx)=>{
      const period=await ensurePeriod(tx,input,{lock:true});
      if(period.status!=='draft')throw fail('roster_period_locked',409);
      if(!input?.templateId){
        const staff=requireId(input?.staffId),date=rosterDate(input?.businessDate);
        const existing=(await tx.query(`select id,locked from sagaops.native_roster_assignments where roster_period_id=$1 and staff_id=$2 and business_date=$3::date for update`,[period.id,staff,date])).rows[0];
        if(existing?.locked&&input?.locked!==false)throw fail('roster_assignment_locked',409);
        if(input?.plannedDayOff===true){
          const bounds=localDayRange(date);
          const manualTaken=(await tx.query(`select exists(select 1 from sagaops.native_staff_availability a join sagaops.staff_profiles p on p.id=a.staff_id
            where a.organization_id=$1 and a.outlet_id=$2 and a.staff_id<>$3 and p.status='active' and a.kind='unavailable' and a.note=$6
              and a.starts_at<$5::timestamptz and a.ends_at>$4::timestamptz) as taken`,[org,outlet,staff,bounds.startAt,bounds.endAt,manualDayOffNote])).rows[0].taken;
          const generation=(await tx.query(`select parameters from sagaops.native_roster_generation_runs where roster_period_id=$1 order by created_at desc limit 1`,[period.id])).rows[0];
          const automaticStaff=(generation?.parameters?.dayOffs??[]).filter((item)=>item.staffId!==staff&&item.businessDate===date&&item.source!=='manual_owner').map((item)=>item.staffId);
          const automaticAssigned=automaticStaff.length?(await tx.query(`select staff_id from sagaops.native_roster_assignments where roster_period_id=$1 and business_date=$2::date and staff_id=any($3::uuid[])`,[period.id,date,automaticStaff])).rows.map((item)=>item.staff_id):[];
          const automaticStillOff=automaticStaff.some((staffId)=>!automaticAssigned.includes(staffId));
          if(manualTaken||automaticStillOff)throw fail('roster_day_off_daily_limit',409);
          await tx.query(`insert into sagaops.native_staff_availability(organization_id,outlet_id,staff_id,starts_at,ends_at,kind,note)
            select $1,$2,p.id,$4,$5,'unavailable',$6 from sagaops.staff_profiles p
            where p.id=$3 and p.organization_id=$1 and p.outlet_id=$2 and p.status='active'
            and not exists(select 1 from sagaops.native_staff_availability a where a.organization_id=$1 and a.outlet_id=$2 and a.staff_id=$3
              and a.kind='unavailable' and a.note=$6 and a.starts_at=$4::timestamptz and a.ends_at=$5::timestamptz)`,[org,outlet,staff,bounds.startAt,bounds.endAt,manualDayOffNote]);
        }
        const removed=(await tx.query(`delete from sagaops.native_roster_assignments where roster_period_id=$1 and staff_id=$2 and business_date=$3::date and published_schedule_id is null returning id`,[period.id,staff,date])).rows[0];
        const nextPeriod=removed?await bumpPeriod(tx,period.id):period;
        const conflicts=await recordRosterValidation(tx,nextPeriod,'assignment_saved');
        await audit(tx,period.id,'assignment_saved',{removed:removed?.id??null,staffId:staff,businessDate:date,plannedDayOff:input?.plannedDayOff===true}); return {removed:removed?.id??null,period:periodView(nextPeriod),conflicts};
      }
      const staff=requireId(input?.staffId),date=rosterDate(input?.businessDate),bounds=localDayRange(date);
      await tx.query(`delete from sagaops.native_staff_availability where organization_id=$1 and outlet_id=$2 and staff_id=$3 and kind='unavailable' and note=$4
        and starts_at=$5::timestamptz and ends_at=$6::timestamptz`,[org,outlet,staff,manualDayOffNote,bounds.startAt,bounds.endAt]);
      const assignment=await putAssignment(tx,period,input),nextPeriod=await bumpPeriod(tx,period.id),conflicts=await recordRosterValidation(tx,nextPeriod,'assignment_saved'); await audit(tx,period.id,'assignment_saved',{assignmentId:assignment.id}); return {period:periodView(nextPeriod),assignment,conflicts};
    });
  }
  async function bulkAssignRoster(input) {
    const staffIds=Array.isArray(input?.staffIds)?[...new Set(input.staffIds.map(requireId))]:[];
    if(!staffIds.length||staffIds.length>100) throw fail('roster_bulk_invalid');
    const weekdays=input?.weekdays==null?[0,1,2,3,4,5,6]:[...new Set(input.weekdays.map(Number))];
    if(!weekdays.length||weekdays.some((day)=>!Number.isInteger(day)||day<0||day>6)) throw fail('roster_weekdays_invalid');
    const range=rosterDays(input?.dateFrom,input?.dateTo);
    return db.transaction(async(tx)=>{
      const period=await ensurePeriod(tx,input,{lock:true}), assignments=[], conflicts=[];
      for(const businessDate of range){
        if(!weekdays.includes(new Date(`${businessDate}T00:00:00Z`).getUTCDay())) continue;
        for(const staffId of staffIds){
          try{ assignments.push(await putAssignment(tx,period,{...input,staffId,businessDate},{source:'manual',preserveLocked:true})); }
          catch(error){ if(error?.code?.startsWith('roster_')) conflicts.push({staffId,businessDate,code:error.code}); else throw error; }
        }
      }
      const nextPeriod=assignments.length?await bumpPeriod(tx,period.id):period;
      if(assignments.length)await recordRosterValidation(tx,nextPeriod,'bulk_assigned');
      await audit(tx,period.id,'bulk_assigned',{created:assignments.length,conflicts:conflicts.length});
      return {period:periodView(nextPeriod),assignments,conflicts};
    });
  }
  async function copyRosterPattern(input) {
    const sourceDays=rosterDays(input?.sourceStart,input?.sourceEnd), targetDays=rosterDays(input?.targetStart,input?.targetEnd);
    const staffIds=Array.isArray(input?.staffIds)&&input.staffIds.length?[...new Set(input.staffIds.map(requireId))]:null;
    return db.transaction(async(tx)=>{
      const period=await ensurePeriod(tx,input,{lock:true}); if(period.status!=='draft') throw fail('roster_period_locked',409);
      const params=[period.id,sourceDays[0],sourceDays.at(-1)], staffFilter=staffIds?' and staff_id=any($4::uuid[])':''; if(staffIds)params.push(staffIds);
      const source=(await tx.query(`select * from sagaops.native_roster_assignments where roster_period_id=$1 and business_date between $2::date and $3::date${staffFilter} order by business_date,staff_id`,params)).rows;
      const indexed=new Map(source.map((row)=>[`${row.staff_id}:${dbDate(row.business_date)}`,row]));
      const assignments=[],conflicts=[];
      for(let index=0;index<targetDays.length;index++){
        const sourceDate=sourceDays[index%sourceDays.length];
        for(const staffId of (staffIds??[...new Set(source.map((row)=>row.staff_id))])){
          const row=indexed.get(`${staffId}:${sourceDate}`); if(!row)continue;
          try{assignments.push(await putAssignment(tx,period,{staffId,templateId:row.shift_template_id,businessDate:targetDays[index],locked:false,notes:row.notes},{source:'copied',explanation:{copiedFrom:sourceDate},preserveLocked:true}));}
          catch(error){if(error?.code?.startsWith('roster_'))conflicts.push({staffId,businessDate:targetDays[index],code:error.code});else throw error;}
        }
      }
      const nextPeriod=assignments.length?await bumpPeriod(tx,period.id):period;
      if(assignments.length)await recordRosterValidation(tx,nextPeriod,'pattern_copied');
      await audit(tx,period.id,'pattern_copied',{created:assignments.length,conflicts:conflicts.length,sourceStart:sourceDays[0],sourceEnd:sourceDays.at(-1)});
      return {period:periodView(nextPeriod),assignments,conflicts};
    });
  }
  async function saveAvailability(input) {
    const staffId=requireId(input?.staffId);
    if(input?.availabilityId&&input?.remove===true){
      const id=requireId(input.availabilityId),row=(await db.query(`delete from sagaops.native_staff_availability where id=$1 and organization_id=$2 and outlet_id=$3 and staff_id=$4 returning id`,[id,org,outlet,staffId])).rows[0];
      if(!row)throw fail('availability_not_found',404); return {removed:id};
    }
    const startsAt=iso(input?.startAt),endsAt=iso(input?.endAt),kind=String(input?.kind??'');
    if(Date.parse(endsAt)<=Date.parse(startsAt)||Date.parse(endsAt)-Date.parse(startsAt)>93*86_400_000||!['unavailable','preferred'].includes(kind))throw fail('availability_invalid');
    const preferredTemplateId=kind==='preferred'&&input?.templateId?requireId(input.templateId):null;
    const row=(await db.query(`insert into sagaops.native_staff_availability(organization_id,outlet_id,staff_id,starts_at,ends_at,kind,preferred_template_id,note)
      select $1,$2,p.id,$4,$5,$6,t.id,$8 from sagaops.staff_profiles p left join sagaops.native_shift_templates t on t.id=$7 and t.organization_id=$1 and t.outlet_id=$2
      where p.id=$3 and p.organization_id=$1 and p.outlet_id=$2 and p.status='active' and ($7::uuid is null or t.id is not null)
      returning id,staff_id,starts_at,ends_at,kind,preferred_template_id,note`,[org,outlet,staffId,startsAt,endsAt,kind,preferredTemplateId,input?.note?clean(input.note,200):null])).rows[0];
    if(!row)throw fail('roster_staff_or_template_not_found',404); return row;
  }
  async function saveRosterRules(input) {
    return db.transaction(async (tx) => {
      const rules=normalizeRules(input?.rules);
      const period=await ensurePeriod(tx,{...input,rules},{lock:true});
      if(period.status!=='draft')throw fail('roster_period_locked',409);
      await audit(tx,period.id,'status_changed',{change:'rules_saved',patternId:rules.patternId,rotationMode:rules.rotationMode,rotationBlockDays:rules.rotationBlockDays});
      return periodView(period);
    });
  }
  async function generateRoster(input) {
    return db.transaction(async(tx)=>{
      const period=await ensurePeriod(tx,input,{lock:true}); if(period.status!=='draft')throw fail('roster_period_locked',409);
      const rules=normalizeRules(period.rules), days=rosterDays(dbDate(period.period_start),dbDate(period.period_end));
      await tx.query(`delete from sagaops.native_roster_assignments where roster_period_id=$1 and source='generated' and locked=false and published_schedule_id is null`,[period.id]);
      const people=(await tx.query(`select p.id,p.employee_code,p.role from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
        where p.organization_id=$1 and p.outlet_id=$2 and p.status='active' and p.employee_code is not null and c.state<>'suspended' order by p.employee_code,p.id`,[org,outlet])).rows;
      const templates=(await tx.query(`select * from sagaops.native_shift_templates where organization_id=$1 and outlet_id=$2 and state='active' order by start_time,code`,[org,outlet])).rows;
      const existing=(await tx.query(`select a.*,t.band from sagaops.native_roster_assignments a join sagaops.native_shift_templates t on t.id=a.shift_template_id where a.roster_period_id=$1 order by a.scheduled_start_at`,[period.id])).rows;
      const approvedAbsences=(await tx.query(`select staff_id,starts_at,ends_at,category from sagaops.native_staff_requests
        where organization_id=$1 and state='approved' and category in ('leave','permission','sick')
        and starts_at<($3::date+interval '7 days') and ends_at>($2::date-interval '7 days')`,[org,days[0],days.at(-1)])).rows;
      const manualAvailability=(await tx.query(`select staff_id,starts_at,ends_at from sagaops.native_staff_availability
        where organization_id=$1 and outlet_id=$2 and kind='unavailable' and note=$3
          and starts_at<($5::date+interval '1 day') and ends_at>$4::date`,[org,outlet,manualDayOffNote,days[0],days.at(-1)])).rows;
      const existingDayOffs=[];
      for(const item of manualAvailability)for(const businessDate of days)if(absenceCountsAsDayOff(item,businessDate))existingDayOffs.push({staffId:item.staff_id,businessDate});
      const usesAutomaticDaysOff=['weekday_rotation_v1','schedule_rules_v1'].includes(rules.dayOffPolicy);
      const usesFourStaffSet=rules.patternId==='balanced_4'&&rules.rotationSet!=='auto'&&people.length===4&&templates.length===2;
      const fourStaffSetOffset=usesFourStaffSet?rotationSetOffset(rules.rotationSet):0;
      const allowedWeekdays=rules.dayOffPolicy==='schedule_rules_v1'?rules.scheduleRows.filter((row)=>row.dayOffAllowed).map((row)=>row.dayOfWeek):null;
      const dayOffPlan=usesAutomaticDaysOff
        ? planWeekdayDaysOff({people,days,approvedAbsences,existingAssignments:existing,existingDayOffs,allowedWeekdays,stableWeekdayAssignments:rules.dayOffPolicy==='schedule_rules_v1',stableWeekdayOffset:fourStaffSetOffset})
        : {dayOffs:[],weekendReplacements:[],conflicts:[],allowedWeekdays:[]};
      const dayOffKeys=new Set(dayOffPlan.dayOffs.map(item=>`${item.staffId}:${item.businessDate}`));
      const plannedNoWorkKeys=new Set([...dayOffPlan.dayOffs,...dayOffPlan.weekendReplacements].map(item=>`${item.staffId}:${item.businessDate}`));
      const assignedKeys=new Set(existing.map(item=>`${item.staff_id}:${dbDate(item.business_date)}`));
      const dailyTemplateLoads=new Map();
      for(const item of existing){const key=`${dbDate(item.business_date)}:${item.shift_template_id}`;dailyTemplateLoads.set(key,(dailyTemplateLoads.get(key)??0)+1);}
      const history=new Map(people.map((person)=>[person.id,existing.filter((item)=>item.staff_id===person.id).map((item)=>({startAt:item.scheduled_start_at,endAt:item.scheduled_end_at,businessDate:dbDate(item.business_date),band:item.band,templateId:item.shift_template_id}))]));
      const generated=[],conflicts=[...dayOffPlan.conflicts],bandRank={morning:0,day:1,evening:2,night:3};let unavailableCount=0;
      const staffIndex=new Map(people.map((person,index)=>[person.id,index]));
      const distinctShiftBands=new Set(templates.map((template)=>template.band)).size;
      const plannedDayOffByWeekStaff=new Map([...dayOffPlan.dayOffs,...dayOffPlan.weekendReplacements].map((item)=>[`${item.staffId}:${item.weekStart}`,item.businessDate]));
      const recordSaved=(saved,template)=>{generated.push(saved);assignedKeys.add(`${saved.staffId}:${saved.businessDate}`);history.get(saved.staffId).push({startAt:saved.startAt,endAt:saved.endAt,businessDate:saved.businessDate,band:template.band,templateId:template.id});const key=`${saved.businessDate}:${template.id}`;dailyTemplateLoads.set(key,(dailyTemplateLoads.get(key)??0)+1);};
      const rankedCandidate=async(person,template,businessDate)=>{
        if(assignedKeys.has(`${person.id}:${businessDate}`)||dayOffKeys.has(`${person.id}:${businessDate}`))return {blocked:true};
        const coverage=coverageFor(rules,businessDate,template.id),load=dailyTemplateLoads.get(`${businessDate}:${template.id}`)??0;
        if(coverage&&load>=coverage.max)return {blocked:true,hard:['shift_capacity_max']};
        const requirements=Array.isArray(template.role_requirements)?template.role_requirements:[];
        if(requirements.length&&!requirements.some(entry=>entry.role===person.role))return {blocked:true};
        const candidate=await assignmentInputs(tx,period,{staffId:person.id,templateId:template.id,businessDate}), hard=await hardConflicts(tx,period,candidate);
        if(hard.length)return {blocked:true,unavailable:hard.includes('unavailable'),hard};
        const personal=history.get(person.id)??[],candidateMs=Date.parse(candidate.startAt),rolling=personal.filter(item=>Math.abs(Date.parse(`${item.businessDate}T00:00:00Z`)-Date.parse(`${businessDate}T00:00:00Z`))<=6*86_400_000);
        let recentSameBand=0,expectedDate=rosterDateAt(businessDate,-1);
        for(const item of [...personal].sort((a,b)=>String(b.businessDate).localeCompare(String(a.businessDate)))){
          if(item.businessDate!==expectedDate||item.band!==template.band)break;
          recentSameBand++;
          expectedDate=rosterDateAt(expectedDate,-1);
        }
        const weekStart=rosterWeekMonday(businessDate),weekly=personal.filter((item)=>rosterWeekMonday(item.businessDate)===weekStart);
        const hours=rolling.reduce((sum,item)=>sum+(Date.parse(item.endAt)-Date.parse(item.startAt))/3_600_000,0)+(Date.parse(candidate.endAt)-candidateMs)/3_600_000;
        const consecutive=new Set(rolling.map(item=>item.businessDate));
        if(hours>rules.maxWeeklyHours||consecutive.size>=rules.maxConsecutiveDays)return {blocked:true,hard:['work_limit']};
        const previous=[...personal].filter(item=>Date.parse(item.endAt)<=candidateMs).sort((a,b)=>Date.parse(b.endAt)-Date.parse(a.endAt))[0];
        const dayIndex=Math.max(0,Math.round((Date.parse(`${businessDate}T00:00:00Z`)-Date.parse(`${days[0]}T00:00:00Z`))/86_400_000));
        const cycle=Math.floor(dayIndex/rules.rotationBlockDays);let targetTemplate=templates[templates.length?(staffIndex.get(person.id)+cycle)%templates.length:0];
        if(usesFourStaffSet){
          const row=fourStaffRotationRows[(staffIndex.get(person.id)+fourStaffSetOffset)%fourStaffRotationRows.length];
          const targetCode=row[mondayFirstDayIndex(businessDate)];
          if(targetCode!=='L')targetTemplate=templates[targetCode==='P'?0:1];
        }
        const plannedDayOff=plannedDayOffByWeekStaff.get(`${person.id}:${weekStart}`);
        if(!usesFourStaffSet&&rules.rotationMode==='balanced_cycle'&&templates.length===2&&plannedDayOff){
          const dayInWeek=Math.round((Date.parse(`${businessDate}T00:00:00Z`)-Date.parse(`${weekStart}T00:00:00Z`))/86_400_000);
          const offInWeek=Math.round((Date.parse(`${plannedDayOff}T00:00:00Z`)-Date.parse(`${weekStart}T00:00:00Z`))/86_400_000);
          let targetIndex;
          const beforeOff=weekly.filter((item)=>item.businessDate<plannedDayOff);
          if(dayInWeek>offInWeek&&beforeOff.length){
            targetIndex=beforeOff[0].templateId===templates[0].id?1:0;
          }else if(offInWeek===0||offInWeek===6){
            targetIndex=weekly.length<rules.rotationBlockDays?0:1;
          }else if(offInWeek===1){
            targetIndex=0;
          }else{
            targetIndex=1;
          }
          targetTemplate=templates[targetIndex];
        }
        const sameTemplateCount=personal.filter((item)=>item.templateId===template.id).length,weeklySameTemplateCount=weekly.filter((item)=>item.templateId===template.id).length;
        const transition=previous&&previous.band!==template.band?(bandRank[template.band]>=bandRank[previous.band]?3:16):0;
        const weeklyDiversity=weeklySameTemplateCount*35-(weekly.length>=rules.rotationBlockDays&&weeklySameTemplateCount===0?70:0);
        const streakPenalty=rules.rotationMode==='balanced_cycle'&&distinctShiftBands>1&&recentSameBand>=2?2400+(recentSameBand-2)*400:recentSameBand*8;
        const nextDate=rosterDateAt(businessDate,1),nextDayInPeriod=days.includes(nextDate);
        let restBlockedMinimum=0;
        if(nextDayInPeriod)for(const nextTemplate of templates){
          const nextRequirements=Array.isArray(nextTemplate.role_requirements)?nextTemplate.role_requirements:[];
          if(nextRequirements.length&&!nextRequirements.some((entry)=>entry.role===person.role))continue;
          const roleMinimum=nextRequirements.filter((entry)=>entry.role===person.role).reduce((sum,entry)=>sum+Number(entry.count??0),0);
          const required=Math.max(Number(coverageFor(rules,nextDate,nextTemplate.id)?.min??0),roleMinimum);
          if(required<=0)continue;
          const nextRange=localShiftRange(nextDate,String(nextTemplate.start_time).slice(0,5),String(nextTemplate.end_time).slice(0,5));
          if(Date.parse(nextRange.startAt)-Date.parse(candidate.endAt)<rules.minimumRestHours*3_600_000)restBlockedMinimum+=required;
        }
        const tomorrowOff=plannedNoWorkKeys.has(`${person.id}:${nextDate}`)||approvedAbsences.some((item)=>(item.staff_id??item.staffId)===person.id&&absenceCountsAsDayOff(item,nextDate));
        const restLookahead=!nextDayInPeriod||restBlockedMinimum===0?(tomorrowOff&&nextDayInPeriod?6000:0):tomorrowOff?-6000*restBlockedMinimum:6000*restBlockedMinimum;
        const targetMismatchPenalty=usesFourStaffSet?10_000:240;
        const rotation=(rules.rotationMode==='balanced_cycle'?(targetTemplate?.id===template.id?0:targetMismatchPenalty)+sameTemplateCount*2+streakPenalty+weeklyDiversity+transition:transition)+restLookahead;
        const preference=(await tx.query(`select 1 from sagaops.native_staff_availability where organization_id=$1 and outlet_id=$2 and staff_id=$3 and kind='preferred' and preferred_template_id=$4 and starts_at<$6 and ends_at>$5 limit 1`,[org,outlet,person.id,template.id,candidate.startAt,candidate.endAt])).rows.length;
        const score=usesAutomaticDaysOff
          ? load*30+personal.length*4+hours*2+rotation-(preference?8:0)
          : personal.length*20+hours*2+rotation-(preference?8:0);
        return {person,candidate,score,reason:{score,balancedTemplateLoad:load,rotationMode:rules.rotationMode,rotationSet:rules.rotationSet,rotationTarget:targetTemplate?.code??null,rotationMatched:targetTemplate?.id===template.id,sameTemplateCount,weeklySameTemplateCount,weeklyShiftCount:weekly.length,preferred:preference===1,assignedShiftsBefore:personal.length,nextDayRestProtected:restLookahead!==0}};
      };
      const withShiftFlexibility=async(person,candidate,template,businessDate)=>{
        let flexibility=0;
        for(const option of templates){
          const available=option.id===template.id?candidate:await rankedCandidate(person,option,businessDate);
          if(!available.blocked)flexibility++;
        }
        return {...candidate,flexibility};
      };
      for(const businessDate of days){
        for(const template of templates){
          const requirements=Array.isArray(template.role_requirements)?template.role_requirements:[];
          for(const requirement of requirements){
            const already=(await tx.query(`select count(*)::int as count from sagaops.native_roster_assignments where roster_period_id=$1 and business_date=$2::date and shift_template_id=$3 and role_snapshot=$4`,[period.id,businessDate,template.id,requirement.role])).rows[0].count;
            for(let slot=already;slot<requirement.count;slot++){
              const candidates=[];
              for(const person of people.filter((entry)=>entry.role===requirement.role)){
                const candidate=await rankedCandidate(person,template,businessDate);
                if(!candidate.blocked)candidates.push(await withShiftFlexibility(person,candidate,template,businessDate));
              }
              candidates.sort((a,b)=>a.flexibility-b.flexibility||a.score-b.score||a.person.employee_code.localeCompare(b.person.employee_code)||a.person.id.localeCompare(b.person.id));
              const chosen=candidates[0];
              if(!chosen){conflicts.push({businessDate,templateId:template.id,templateCode:template.code,role:requirement.role,code:'coverage_unfilled',severity:'error',blocking:true,message:`${template.name}: kebutuhan ${requirement.role} belum terpenuhi.`});continue;}
              const saved=await putAssignment(tx,period,{staffId:chosen.person.id,templateId:template.id,businessDate,locked:false},{source:'generated',explanation:chosen.reason});
              recordSaved(saved,template);
            }
          }
        }
        if(rules.dayOffPolicy==='schedule_rules_v1')for(const template of templates){
          const coverage=coverageFor(rules,businessDate,template.id);if(!coverage)continue;
          for(let slot=dailyTemplateLoads.get(`${businessDate}:${template.id}`)??0;slot<coverage.min;slot++){
            const candidates=[];for(const person of people){
              const candidate=await rankedCandidate(person,template,businessDate);if(candidate.blocked)continue;
              candidates.push(await withShiftFlexibility(person,candidate,template,businessDate));
            }
            candidates.sort((a,b)=>a.flexibility-b.flexibility||a.score-b.score||a.person.employee_code.localeCompare(b.person.employee_code)||a.person.id.localeCompare(b.person.id));
            const chosen=candidates[0];
            if(!chosen){conflicts.push({businessDate,templateId:template.id,templateCode:template.code,code:'shift_minimum_unfilled',severity:'error',blocking:true,required:coverage.min,assigned:dailyTemplateLoads.get(`${businessDate}:${template.id}`)??0,message:`${template.name}: minimum ${coverage.min} orang belum terpenuhi.`});break;}
            const saved=await putAssignment(tx,period,{staffId:chosen.person.id,templateId:template.id,businessDate,locked:false},{source:'generated',explanation:{...chosen.reason,coverageMinimum:coverage.min}});recordSaved(saved,template);
          }
        }
        if(usesAutomaticDaysOff){
          const pending=people.filter((person)=>!assignedKeys.has(`${person.id}:${businessDate}`)&&!dayOffKeys.has(`${person.id}:${businessDate}`));
          while(pending.length){
            const choices=[];
            for(const person of pending){
              const candidates=[];let unavailable=false,hardCodes=[];
              for(const template of templates){const candidate=await rankedCandidate(person,template,businessDate);if(candidate.unavailable)unavailable=true;if(candidate.hard)hardCodes.push(...candidate.hard);if(!candidate.blocked)candidates.push({...candidate,template});}
              candidates.sort((a,b)=>a.score-b.score||String(a.template.code).localeCompare(String(b.template.code)));
              choices.push({person,candidates,unavailable,hardCodes});
            }
            choices.sort((a,b)=>a.candidates.length-b.candidates.length||String(a.person.employee_code).localeCompare(String(b.person.employee_code))||String(a.person.id).localeCompare(String(b.person.id)));
            const current=choices[0],index=pending.findIndex((person)=>person.id===current.person.id);pending.splice(index,1);
            const chosen=current.candidates[0];
            if(chosen){const saved=await putAssignment(tx,period,{staffId:current.person.id,templateId:chosen.template.id,businessDate,locked:false},{source:'generated',explanation:{...chosen.reason,dayOffPolicy:rules.dayOffPolicy}});recordSaved(saved,chosen.template);continue;}
            if(current.unavailable){unavailableCount++;continue;}
            conflicts.push({staffId:current.person.id,businessDate,code:'staff_unassigned',severity:'error',blocking:true,message:`${current.person.employee_code}: tidak ada shift yang memenuhi role, jam kerja, kapasitas, atau waktu istirahat.`,details:[...new Set(current.hardCodes)]});
          }
        }
      }
      if(rules.rotationMode==='balanced_cycle'&&distinctShiftBands>1)for(const person of people){
        const assignments=[...(history.get(person.id)??[])].sort((a,b)=>String(a.businessDate).localeCompare(String(b.businessDate)));let run=[];
        const inspectRun=()=>{if(run.length<=2)return;const firstViolation=run[2];conflicts.push({staffId:person.id,businessDate:firstViolation.businessDate,code:'same_shift_streak_exceeded',severity:'error',blocking:true,band:firstViolation.band,streak:run.length,message:`${person.employee_code}: ${run.length} shift ${firstViolation.band} berturut-turut. Maksimal dua; ubah salah satu shift atau kapasitas.`});};
        for(const assignment of assignments){const previous=run.at(-1),isNextDay=previous&&Date.parse(`${assignment.businessDate}T00:00:00Z`)-Date.parse(`${previous.businessDate}T00:00:00Z`)===86_400_000;if(!previous||!isNextDay||previous.band!==assignment.band){inspectRun();run=[assignment];}else run.push(assignment);}inspectRun();
      }
      if(rules.dayOffPolicy==='schedule_rules_v1')for(const businessDate of days)for(const template of templates){
        const coverage=coverageFor(rules,businessDate,template.id);if(!coverage)continue;const assigned=dailyTemplateLoads.get(`${businessDate}:${template.id}`)??0;
        if(assigned<coverage.min&&!conflicts.some((item)=>item.businessDate===businessDate&&item.templateId===template.id&&item.code==='shift_minimum_unfilled'))conflicts.push({businessDate,templateId:template.id,templateCode:template.code,code:'shift_minimum_unfilled',severity:'error',blocking:true,required:coverage.min,assigned,message:`${template.name}: minimum ${coverage.min} orang belum terpenuhi.`});
        if(assigned>coverage.max)conflicts.push({businessDate,templateId:template.id,templateCode:template.code,code:'shift_maximum_exceeded',severity:'error',blocking:true,maximum:coverage.max,assigned,message:`${template.name}: ${assigned} orang melebihi maksimum ${coverage.max}.`});
      }
      const algorithm=usesFourStaffSet?'schedule-rules-set-v7':rules.dayOffPolicy==='schedule_rules_v1'?'schedule-rules-rolling-v6':rules.dayOffPolicy==='weekday_rotation_v1'?'weekday-rotation-roster-v3':'humane-roster-v1';
      const summary={generated:generated.length,conflicts:conflicts.length,preserved:existing.length,dayOffs:dayOffPlan.dayOffs.length,weekendReplacements:dayOffPlan.weekendReplacements.length,approvedOrUnavailable:unavailableCount,algorithm,rotationSet:usesFourStaffSet?rules.rotationSet:'auto'};
      const run=(await tx.query(`insert into sagaops.native_roster_generation_runs(roster_period_id,organization_id,outlet_id,algorithm_version,parameters,summary,conflicts,created_by)
        values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) returning id,created_at`,[period.id,org,outlet,algorithm,JSON.stringify({rules,preserveLocked:true,dayOffs:dayOffPlan.dayOffs,weekendReplacements:dayOffPlan.weekendReplacements,allowedWeekdays:dayOffPlan.allowedWeekdays}),JSON.stringify(summary),JSON.stringify(conflicts),ids.ownerProfileId])).rows[0];
      await audit(tx,period.id,'generated',{runId:run.id,...summary});
      const nextPeriod=await bumpPeriod(tx,period.id);
      return {period:periodView(nextPeriod),assignments:generated,conflicts,summary,generationRunId:run.id};
    });
  }
  async function setRosterStatus(input) {
    const status=String(input?.status??''); if(!rosterStatuses.has(status))throw fail('roster_status_invalid');
    return db.transaction(async(tx)=>{const period=await ensurePeriod(tx,input,{lock:true});if(period.status==='published'||period.status==='archived')throw fail('roster_period_locked',409);
      const row=(await tx.query(`update sagaops.native_roster_periods set status=$2,version=version+1,updated_at=now() where id=$1 returning *`,[period.id,status])).rows[0];
      await audit(tx,period.id,'status_changed',{from:period.status,to:status});return periodView(row);});
  }
  async function rosterValidation(tx,period,{lockAssignments=false}={}) {
    const assignments=(await tx.query(`select * from sagaops.native_roster_assignments where roster_period_id=$1 order by business_date,scheduled_start_at${lockAssignments?' for update':''}`,[period.id])).rows;
    const conflicts=[],rules=normalizeRules(period.rules),days=rosterDays(dbDate(period.period_start),dbDate(period.period_end));
    const assigned=new Set(assignments.map(item=>`${item.staff_id}:${dbDate(item.business_date)}`));
    const people=(await tx.query(`select p.id,p.employee_code from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
      where p.organization_id=$1 and p.outlet_id=$2 and p.status='active' and p.employee_code is not null and c.state<>'suspended'`,[org,outlet])).rows;
    const activeStaffIds=new Set(people.map((person)=>person.id)),plannedEntries=[];
    const manualAvailability=(await tx.query(`select a.staff_id,a.starts_at,a.ends_at from sagaops.native_staff_availability a join sagaops.staff_profiles p on p.id=a.staff_id
      where a.organization_id=$1 and a.outlet_id=$2 and p.status='active' and a.kind='unavailable' and a.note=$3
        and a.starts_at<($5::date+interval '1 day') and a.ends_at>$4::date`,[org,outlet,manualDayOffNote,dbDate(period.period_start),dbDate(period.period_end)])).rows;
    for(const item of manualAvailability)for(const businessDate of days)if(absenceCountsAsDayOff(item,businessDate))plannedEntries.push({staffId:item.staff_id,businessDate,source:'manual_owner'});
    const generation=(await tx.query(`select id,algorithm_version,parameters,summary,conflicts,created_at from sagaops.native_roster_generation_runs where roster_period_id=$1 order by created_at desc limit 1`,[period.id])).rows[0]??null;
    if(['weekday_rotation_v1','schedule_rules_v1'].includes(rules.dayOffPolicy)){
      if(!generation)conflicts.push({code:'roster_policy_generation_missing',message:'Generate ulang jadwal bulanan sebelum publish.'});
      else{
        plannedEntries.push(...(generation.parameters?.dayOffs??[]).filter((item)=>item.source!=='manual_owner'&&activeStaffIds.has(item.staffId)&&!assigned.has(`${item.staffId}:${item.businessDate}`)));
        const plannedDaysOff=new Set(plannedEntries.map((item)=>`${item.staffId}:${item.businessDate}`));
        for(const businessDate of days){
          const bounds=localDayRange(businessDate);
          for(const person of people){
            const key=`${person.id}:${businessDate}`;if(assigned.has(key)||plannedDaysOff.has(key))continue;
            const excused=(await tx.query(`select exists(select 1 from sagaops.native_staff_requests r where r.organization_id=$1 and r.staff_id=$2
                and r.state='approved' and r.category in ('leave','permission','sick') and r.starts_at<$4::timestamptz and r.ends_at>$3::timestamptz
                and least(r.ends_at,$4::timestamptz)-greatest(r.starts_at,$3::timestamptz)>=interval '6 hours')
              or exists(select 1 from sagaops.native_staff_availability a where a.organization_id=$1 and a.outlet_id=$5 and a.staff_id=$2 and a.kind='unavailable'
                and a.starts_at<$4::timestamptz and a.ends_at>$3::timestamptz and (a.note=$6 or least(a.ends_at,$4::timestamptz)-greatest(a.starts_at,$3::timestamptz)>=interval '6 hours')) as allowed`,[org,person.id,bounds.startAt,bounds.endAt,outlet,manualDayOffNote])).rows[0].allowed;
            if(!excused)conflicts.push({staffId:person.id,businessDate,code:'staff_unassigned',message:`${person.employee_code}: hari kerja kosong tanpa libur otomatis atau izin yang disetujui.`});
          }
        }
      }
    }
    const uniquePlanned=new Map(plannedEntries.map((item)=>[`${item.staffId}:${item.businessDate}`,item])),dailyDaysOff=new Map();
    for(const item of uniquePlanned.values()){const peopleOff=dailyDaysOff.get(item.businessDate)??[];peopleOff.push(item.staffId);dailyDaysOff.set(item.businessDate,peopleOff);}
    for(const [businessDate,staffIds] of dailyDaysOff)if(staffIds.length>1)conflicts.push({businessDate,staffIds,code:'day_off_daily_limit_exceeded',severity:'error',blocking:true,count:staffIds.length,message:'Lebih dari satu orang memiliki libur terjadwal pada tanggal yang sama. Maksimal satu orang per hari.'});
    for(const row of assignments){
      const eligibility=(await tx.query(`select p.role,c.state as credential_state,t.state as template_state,t.role_requirements
        from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
        join sagaops.native_shift_templates t on t.id=$2 and t.organization_id=$3 and t.outlet_id=$4
        where p.id=$1 and p.organization_id=$3 and p.outlet_id=$4 and p.status='active'`,[row.staff_id,row.shift_template_id,org,outlet])).rows[0];
      const requirements=Array.isArray(eligibility?.role_requirements)?eligibility.role_requirements:[];
      if(!eligibility||eligibility.credential_state==='suspended'||eligibility.template_state!=='active'||(requirements.length&&!requirements.some((entry)=>entry.role===eligibility.role))){
        conflicts.push({assignmentId:row.id,code:'assignment_no_longer_eligible'});
        continue;
      }
      const candidate={staff:row.staff_id,startAt:row.scheduled_start_at,endAt:row.scheduled_end_at};
      const found=await hardConflicts(tx,period,candidate,{excludeAssignmentId:row.id}); if(found.length)conflicts.push({assignmentId:row.id,codes:found});
    }
    const templates=(await tx.query(`select id,name,code,band,role_requirements from sagaops.native_shift_templates where organization_id=$1 and outlet_id=$2 and state='active'`,[org,outlet])).rows;
    for(const businessDate of days)for(const template of templates)for(const requirement of (Array.isArray(template.role_requirements)?template.role_requirements:[])){
      const count=assignments.filter((row)=>dbDate(row.business_date)===businessDate&&row.shift_template_id===template.id&&row.role_snapshot===requirement.role).length;
      if(count<requirement.count)conflicts.push({businessDate,templateId:template.id,role:requirement.role,code:'coverage_unfilled',required:requirement.count,assigned:count});
    }
    if(rules.dayOffPolicy==='schedule_rules_v1')for(const businessDate of days)for(const template of templates){
      const coverage=coverageFor(rules,businessDate,template.id);if(!coverage)continue;
      const count=assignments.filter((row)=>dbDate(row.business_date)===businessDate&&row.shift_template_id===template.id).length;
      if(count<coverage.min)conflicts.push({businessDate,templateId:template.id,code:'shift_minimum_unfilled',required:coverage.min,assigned:count});
      if(count>coverage.max)conflicts.push({businessDate,templateId:template.id,code:'shift_maximum_exceeded',maximum:coverage.max,assigned:count});
    }
    if(rules.rotationMode==='balanced_cycle'&&new Set(templates.map((template)=>template.band)).size>1){
      const bandByTemplate=new Map(templates.map((template)=>[template.id,template.band]));
      for(const staffId of new Set(assignments.map((row)=>row.staff_id))){
        const staffAssignments=assignments.filter((row)=>row.staff_id===staffId).sort((a,b)=>dbDate(a.business_date).localeCompare(dbDate(b.business_date)));let run=[];
        const inspectRun=()=>{if(run.length<=2)return;const firstViolation=run[2];conflicts.push({staffId,businessDate:dbDate(firstViolation.business_date),code:'same_shift_streak_exceeded',severity:'error',blocking:true,band:bandByTemplate.get(firstViolation.shift_template_id),streak:run.length,message:`Jadwal memiliki ${run.length} shift sejenis berturut-turut. Maksimal dua; ubah salah satu shift sebelum publish.`});};
        for(const assignment of staffAssignments){const businessDate=dbDate(assignment.business_date),band=bandByTemplate.get(assignment.shift_template_id),previous=run.at(-1),isNextDay=previous&&Date.parse(`${businessDate}T00:00:00Z`)-Date.parse(`${dbDate(previous.business_date)}T00:00:00Z`)===86_400_000;if(!previous||!isNextDay||bandByTemplate.get(previous.shift_template_id)!==band){inspectRun();run=[assignment];}else run.push(assignment);}inspectRun();
      }
    }
    return {assignments,conflicts,generation};
  }
  async function recordRosterValidation(tx,period,source){
    const validation=await rosterValidation(tx,period);
    if(!validation.generation)return validation.conflicts;
    const parameters={...(validation.generation.parameters??{}),validation:{source,periodVersion:Number(period.version)}};
    const summary={...(validation.generation.summary??{}),conflicts:validation.conflicts.length,validatedAfterManualEdit:true};
    await tx.query(`insert into sagaops.native_roster_generation_runs(roster_period_id,organization_id,outlet_id,algorithm_version,parameters,summary,conflicts,created_by)
      values($1,$2,$3,'manual-roster-validation-v1',$4::jsonb,$5::jsonb,$6::jsonb,$7)`,[period.id,org,outlet,JSON.stringify(parameters),JSON.stringify(summary),JSON.stringify(validation.conflicts),ids.ownerProfileId]);
    return validation.conflicts;
  }
  async function publishRoster(input) {
    return db.transaction(async(tx)=>{
      const period=await ensurePeriod(tx,input,{lock:true}); if(period.status!=='review')throw fail('roster_review_required',409);
      const {assignments,conflicts}=await rosterValidation(tx,period,{lockAssignments:true});
      if(!assignments.length)throw fail('roster_empty',409);
      if(conflicts.length)throw Object.assign(fail('roster_publish_conflicts',409),{details:conflicts});
      await tx.query("select set_config('app.native_roster_publish','authorized',true)");
      const rateRows=(await tx.query(`select id,payroll_rate_type,payroll_rate_amount_rupiah from sagaops.staff_profiles
        where organization_id=$1 and outlet_id=$2 and id=any($3::uuid[])`,[org,outlet,[...new Set(assignments.map((row)=>row.staff_id))]])).rows;
      const rates=new Map(rateRows.map((person)=>{const amount=Number(person.payroll_rate_amount_rupiah??0);return [person.id,{type:amount>0&&payRateTypes.has(String(person.payroll_rate_type))?String(person.payroll_rate_type):null,amount}];}));
      for(const row of assignments){
        const rate=rates.get(row.staff_id)??{type:null,amount:0};
        const schedule=(await tx.query(`insert into sagaops.shift_schedules(organization_id,outlet_id,staff_id,business_date,scheduled_start_at,scheduled_end_at,shift_name,grace_period_minutes,notes,payroll_rate_type,payroll_rate_amount_rupiah)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,[org,outlet,row.staff_id,row.business_date,row.scheduled_start_at,row.scheduled_end_at,row.shift_name_snapshot,row.grace_minutes_snapshot,row.notes,rate.type,rate.amount])).rows[0];
        await tx.query(`update sagaops.native_roster_assignments set published_schedule_id=$2,locked=true,updated_at=now() where id=$1`,[row.id,schedule.id]);
      }
      const published=(await tx.query(`update sagaops.native_roster_periods set status='published',published_by=$2,published_at=now(),version=version+1,updated_at=now() where id=$1 returning *`,[period.id,ids.ownerProfileId])).rows[0];
      await audit(tx,period.id,'published',{assignmentCount:assignments.length});
      return {period:periodView(published),publishedSchedules:assignments.length};
    });
  }
  async function login({ employeeCode, password }) {
    const code = String(employeeCode ?? '').trim().toUpperCase();
    if (!/^STF-[0-9]{6,12}$/.test(code) || typeof password !== 'string' || password.length > 256) throw fail('identity_invalid', 401);
    const row = (await db.query(`select p.id,p.employee_code,p.full_name,p.role,p.status,c.password_hash,c.state,c.temporary_expires_at,c.version
      from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
      where p.organization_id=$1 and p.outlet_id=$2 and p.employee_code=$3`, [org, outlet, code])).rows[0];
    if (!row || row.status !== 'active' || row.state === 'suspended' || (row.state === 'temporary' && new Date(row.temporary_expires_at) <= clock()) || !await passwordMatches(password, row.password_hash)) throw fail('identity_invalid', 401);
    return { staffId: row.id, employeeCode: row.employee_code, name: row.full_name, role: row.role, passwordChangeRequired: row.state === 'temporary', version: row.version };
  }
  async function validateSession(subject) {
    if (!uuid.test(subject?.staffId) || !Number.isInteger(subject?.version)) throw fail('authentication_required',401);
    const row = (await db.query(`select p.full_name,p.role,p.status,c.state,c.version,c.temporary_expires_at
      from sagaops.native_staff_credentials c join sagaops.staff_profiles p on p.id=c.staff_id
      where p.id=$1 and p.organization_id=$2 and p.outlet_id=$3`, [subject.staffId, org, outlet])).rows[0];
    if (!row || row.status !== 'active' || row.state === 'suspended' || row.version !== subject.version ||
      (row.state === 'temporary' && new Date(row.temporary_expires_at) <= clock())) throw fail('session_expired',401);
    return { ...subject, name:row.full_name,role:row.role,passwordChangeRequired: row.state === 'temporary' };
  }
  async function changePassword(staffId, currentPassword, nextPassword) {
    const id = requireId(staffId);
    if (typeof nextPassword !== 'string' || nextPassword.length < 12 || nextPassword.length > 128 || nextPassword === currentPassword) throw fail('new_password_invalid');
    const row = (await db.query(`select password_hash from sagaops.native_staff_credentials where staff_id=$1 and organization_id=$2`, [id, org])).rows[0];
    if (!row || !await passwordMatches(String(currentPassword ?? ''), row.password_hash)) throw fail('current_password_invalid',401);
    const hash = await passwordHash(nextPassword);
    const updated = (await db.query(`update sagaops.native_staff_credentials set password_hash=$3,state='active',temporary_expires_at=null,
      password_changed_at=now(),version=version+1,updated_at=now() where staff_id=$1 and organization_id=$2 and password_hash=$4 returning version`, [id, org, hash,row.password_hash])).rows[0];
    if (!updated) throw fail('password_changed_concurrently',409);
    return { version: updated.version };
  }
  async function home(staffId) {
    const id = requireId(staffId);
    const data = await own(id, async (tx) => {
      const person = (await tx.query(`select id,employee_code,full_name,role,status,payroll_rate_type,payroll_rate_amount_rupiah,updated_at
        from sagaops.staff_profiles where id=$1`, [id])).rows[0];
      if (!person) throw fail('staff_not_found',404);
      const schedules = (await tx.query(`select id,shift_name,scheduled_start_at,scheduled_end_at,status,notes from sagaops.shift_schedules
        where staff_id=$1 and scheduled_end_at>now()-interval '7 days' order by scheduled_start_at limit 30`, [id])).rows;
      const attendance = (await tx.query(`select a.id,a.shift_schedule_id,a.check_in_at,a.check_out_at,a.status,a.is_unscheduled,a.late_minutes,a.worked_minutes,
          coalesce((to_jsonb(a)->>'overtime_candidate_minutes')::integer,0) as overtime_candidate_minutes,
          coalesce((to_jsonb(a)->>'approved_overtime_minutes')::integer,0) as approved_overtime_minutes
        from sagaops.attendance_logs a where a.staff_id=$1 order by a.check_in_at desc limit 30`, [id])).rows;
      const requests = (await tx.query(`select id,category,reason,starts_at,ends_at,state,schedule_id,target_staff_id,target_schedule_id,reviewer_note,created_at
        from sagaops.native_staff_requests where staff_id=$1 or target_staff_id=$1 order by created_at desc limit 30`, [id])).rows;
      const generatedAt=clock().toISOString(),{periodStart,periodEnd}=jakartaMonthBounds(clock());
      const [payrollSchedules,payrollAttendance,payrollAbsences]=await Promise.all([
        tx.query(`select id,staff_id,business_date,scheduled_start_at,scheduled_end_at,status,
            to_jsonb(s)->>'payroll_rate_type' as rate_type,
            coalesce((to_jsonb(s)->>'payroll_rate_amount_rupiah')::bigint,0) as rate_amount_rupiah
          from sagaops.shift_schedules s where staff_id=$1 and business_date between $2::date and $3::date
          order by business_date,scheduled_start_at`,[id,periodStart,periodEnd]),
        tx.query(`select id,staff_id,shift_schedule_id,check_in_at,check_out_at,status,is_unscheduled,late_minutes,
            coalesce((to_jsonb(a)->>'early_leave_minutes')::integer,0) as early_leave_minutes,worked_minutes,
            coalesce((to_jsonb(a)->>'overtime_candidate_minutes')::integer,0) as overtime_candidate_minutes,
            coalesce((to_jsonb(a)->>'approved_overtime_minutes')::integer,0) as approved_overtime_minutes,note
          from sagaops.attendance_logs a where staff_id=$1
            and coalesce((select s.business_date from sagaops.shift_schedules s where s.id=a.shift_schedule_id
              and s.organization_id=a.organization_id and s.outlet_id=a.outlet_id and s.staff_id=a.staff_id),
              (a.check_in_at at time zone 'Asia/Jakarta')::date) between $2::date and $3::date order by check_in_at`,[id,periodStart,periodEnd]),
        tx.query(`select staff_id,category,state,starts_at,ends_at from sagaops.native_staff_requests
          where staff_id=$1 and state='approved' and category in ('leave','permission','sick')
            and starts_at<($3::date+1)::timestamptz and ends_at>$2::date::timestamptz`,[id,periodStart,periodEnd]),
      ]);
      const payrollReport=buildNativeStaffReport({periodStart,periodEnd,generatedAt,staff:[person],schedules:payrollSchedules.rows,
        attendance:payrollAttendance.rows.map((row)=>({...row,review_status:parseAttendanceEnvelope(row.note)?.reviewStatus??'NOT_REQUIRED'})),requests:payrollAbsences.rows,adjustments:[]});
      return { staff: profile(person), schedules, attendance, requests, serverTime: generatedAt,
        payrollPreview:{periodStart,periodEnd,generatedAt,payrollMode:'PREVIEW_ONLY',performanceEnabled:false,row:payrollReport.rows[0]??null} };
    });
    const targets = (await db.query(`select s.id as schedule_id,s.staff_id,p.full_name as staff_name,s.shift_name,s.scheduled_start_at,s.scheduled_end_at
      from sagaops.shift_schedules s join sagaops.staff_profiles p on p.id=s.staff_id
      where s.organization_id=$1 and s.outlet_id=$2 and s.staff_id<>$3 and s.status='scheduled'
      and s.scheduled_start_at>now() and p.employee_code is not null and p.status='active'
      order by s.scheduled_start_at limit 30`, [org,outlet,id])).rows;
    return { ...data, attendanceEligibility:await attendanceEligibility(id), swapTargets: targets };
  }
  async function listSchedules(staffId,{from,to}={}){
    const id=requireId(staffId),range=staffDateRange(from,to,clock);
    return own(id,async(tx)=>{
      const rows=(await tx.query(`select s.id,s.staff_id,s.business_date,s.shift_name,s.scheduled_start_at,s.scheduled_end_at,s.status,s.notes,
          a.id as attendance_id,a.check_in_at,a.check_out_at,a.status as attendance_status,a.late_minutes,a.early_leave_minutes,a.worked_minutes,a.note as attendance_note
        from sagaops.shift_schedules s left join sagaops.attendance_logs a on a.shift_schedule_id=s.id and a.staff_id=s.staff_id
        where s.staff_id=$1 and s.organization_id=$2 and s.outlet_id=$3 and s.status<>'cancelled'
          and s.business_date between $4::date and $5::date order by s.business_date,s.scheduled_start_at,s.id`,[id,org,outlet,range.from,range.to])).rows;
      return {range,serverTime:clock().toISOString(),schedules:rows.map(staffScheduleView)};
    });
  }
  async function getSchedule(staffId,scheduleIdValue){
    const id=requireId(staffId),scheduleId=requireId(scheduleIdValue);
    return own(id,async(tx)=>{
      const row=(await tx.query(`select s.id,s.staff_id,s.business_date,s.shift_name,s.scheduled_start_at,s.scheduled_end_at,s.status,s.notes,
          a.id as attendance_id,a.check_in_at,a.check_out_at,a.status as attendance_status,a.late_minutes,a.early_leave_minutes,a.worked_minutes,a.note as attendance_note
        from sagaops.shift_schedules s left join sagaops.attendance_logs a on a.shift_schedule_id=s.id and a.staff_id=s.staff_id
        where s.id=$1 and s.staff_id=$2 and s.organization_id=$3 and s.outlet_id=$4 and s.status<>'cancelled'`,[scheduleId,id,org,outlet])).rows[0];
      if(!row)throw fail('schedule_not_found',404);
      return {...staffScheduleView(row),serverTime:clock().toISOString()};
    });
  }
  async function listRequests(staffId,{status,category,limit=50,before}={}){
    const id=requireId(staffId),state=requestStateFilter(status),kind=requestCategoryFilter(category),rowLimit=boundedInt(limit,1,100,'request_limit_invalid'),cursor=before==null?null:iso(before);
    return own(id,async(tx)=>{
      const values=[org,id],clauses=['r.organization_id=$1','(r.staff_id=$2 or r.target_staff_id=$2)'];
      if(state){values.push(state);clauses.push(`r.state=$${values.length}`);}
      if(kind==='attendance_correction')clauses.push("r.reason like 'ATTENDANCE_CORRECTION_V1|%'");
      else if(kind){values.push(kind);clauses.push(`r.category=$${values.length}`);}
      if(cursor){values.push(cursor);clauses.push(`r.created_at<$${values.length}`);}
      values.push(rowLimit);
      const rows=(await tx.query(`select r.* from sagaops.native_staff_requests r where ${clauses.join(' and ')} order by r.created_at desc,r.id desc limit $${values.length}`,values)).rows;
      return {requests:rows.map((row)=>staffRequestView(row,id)),nextCursor:rows.length===rowLimit?dateIso(rows.at(-1).created_at):null,serverTime:clock().toISOString(),attachmentPolicy:{generalRequestAttachments:false,attendanceCorrectionEvidence:true}};
    });
  }
  async function getRequest(staffId,requestIdValue){
    const id=requireId(staffId),requestId=requireId(requestIdValue);
    return own(id,async(tx)=>{
      const row=(await tx.query(`select r.* from sagaops.native_staff_requests r where r.id=$1 and r.organization_id=$2 and (r.staff_id=$3 or r.target_staff_id=$3)`,[requestId,org,id])).rows[0];
      if(!row)throw fail('request_not_found',404);
      return {...staffRequestView(row,id),serverTime:clock().toISOString(),attachmentPolicy:{generalRequestAttachments:false,attendanceCorrectionEvidence:true}};
    });
  }
  async function attendancePolicy(tx=db) {
    const base={timezone:'Asia/Jakarta',earlyOpenMinutes:60,lateCheckInMinutes:60,postCloseMinutes:60,minimumWorkedMinutes:30,earlyLeaveReviewMinutes:30,anytimeTestMode:false,gpsRequired:true,selfieRequired:true,maxAccuracyMeters:100,geofenceRadiusMeters:100,
      outletLatitude:null,outletLongitude:null,geofenceAction:'REVIEW',enforcementState:'ACTIVE',version:1,updatedAt:null,updatedBy:null,evidenceRetentionDays:30};
    const enabled=Boolean(attendanceEvidenceStorage);
    if(enabled&&attendanceEvidenceStorage.loadPolicy&&!schemaNeutralPolicy.loaded){const saved=await attendanceEvidenceStorage.loadPolicy();if(saved)schemaNeutralPolicy={...schemaNeutralPolicy,...saved,loaded:true};else schemaNeutralPolicy={...schemaNeutralPolicy,loaded:true};}
    return {...base,...schemaNeutralPolicy,gpsRequired:enabled&&schemaNeutralPolicy.gpsRequired,selfieRequired:enabled&&schemaNeutralPolicy.selfieRequired,enforcementState:enabled?schemaNeutralPolicy.enforcementState:'DISABLED',outlet:{id:outlet,name:null,latitude:schemaNeutralPolicy.outletLatitude,longitude:schemaNeutralPolicy.outletLongitude}};
  }
  async function eligibilityIn(tx,staffId,{lock=false}={}) {
    const now=clock(), nowIso=now.toISOString(),policy=await attendancePolicy(tx),testMode=policy.anytimeTestMode===true, lockSql=lock?' for update of a':'';
    const open=(await tx.query(`select a.id,a.shift_schedule_id,s.id as schedule_id,a.check_in_at,a.check_out_at,a.status,s.shift_name,s.scheduled_start_at,s.scheduled_end_at
      from sagaops.attendance_logs a join sagaops.shift_schedules s on s.id=a.shift_schedule_id
      where a.staff_id=$1 and a.organization_id=$2 and a.outlet_id=$3 and a.check_in_at is not null and a.check_out_at is null${lockSql}`,[staffId,org,outlet])).rows[0];
    const scheduleRows=(await tx.query(`select id,shift_name,scheduled_start_at,scheduled_end_at,grace_period_minutes,status from sagaops.shift_schedules
      where staff_id=$1 and organization_id=$2 and outlet_id=$3 and status='scheduled'
      and scheduled_start_at<=$4::timestamptz+interval '7 days' and scheduled_end_at>=$4::timestamptz-interval '7 days'
      order by scheduled_start_at`,[staffId,org,outlet,nowIso])).rows;
    const view=(schedule)=>schedule?{id:schedule.schedule_id??schedule.id,shiftName:schedule.shift_name,scheduledStartAt:dateIso(schedule.scheduled_start_at),scheduledEndAt:dateIso(schedule.scheduled_end_at),outlet:policy.outlet}:null;
    const requirements={gps:policy.enforcementState==='ACTIVE'&&policy.gpsRequired,selfie:policy.enforcementState==='ACTIVE'&&policy.selfieRequired,maxAccuracyMeters:policy.maxAccuracyMeters};
    if(open){
      const closesAt=new Date(Date.parse(open.scheduled_end_at)+policy.postCloseMinutes*60_000);
      if(testMode||now<=closesAt)return {serverTime:nowIso,action:'CLOCK_OUT',eligible:true,reasonCode:null,message:testMode?'Mode uji 24 jam aktif. Kamu dapat mencoba foto absen pulang sekarang.':'Kamu dapat absen pulang untuk shift ini.',schedule:view(open),window:testMode?{opensAt:null,closesAt:null}:{opensAt:dateIso(open.scheduled_start_at),closesAt:closesAt.toISOString()},requirements,currentAttendance:attendanceView(open),testMode};
      return {serverTime:nowIso,action:'CORRECTION',eligible:false,reasonCode:'attendance_checkout_window_closed',message:'Batas absen pulang sudah lewat. Ajukan lupa absen agar Owner dapat memeriksa.',schedule:view(open),window:{opensAt:dateIso(open.scheduled_start_at),closesAt:closesAt.toISOString()},requirements,currentAttendance:attendanceView(open)};
    }
    const candidates=scheduleRows.map((schedule)=>({schedule,opensAt:new Date(Date.parse(schedule.scheduled_start_at)-policy.earlyOpenMinutes*60_000),closesAt:new Date(Math.min(Date.parse(schedule.scheduled_end_at),Date.parse(schedule.scheduled_start_at)+policy.lateCheckInMinutes*60_000))}));
    if(testMode&&candidates.length){
      const recorded=(await tx.query(`select shift_schedule_id from sagaops.attendance_logs where staff_id=$1 and shift_schedule_id=any($2::uuid[])`,[staffId,candidates.map((item)=>item.schedule.id)])).rows;
      const recordedIds=new Set(recorded.map((row)=>row.shift_schedule_id)),available=candidates.filter((item)=>!recordedIds.has(item.schedule.id)).sort((left,right)=>Math.abs(Date.parse(left.schedule.scheduled_start_at)-now.getTime())-Math.abs(Date.parse(right.schedule.scheduled_start_at)-now.getTime())),selected=available[0];
      if(selected)return {serverTime:nowIso,action:'CLOCK_IN',eligible:true,reasonCode:null,message:'Mode uji 24 jam aktif. Kamu dapat mencoba GPS dan foto wajah sekarang.',schedule:view(selected.schedule),window:{opensAt:null,closesAt:null},requirements,currentAttendance:null,testMode:true};
    }
    const active=candidates.find((item)=>now>=item.opensAt&&now<=item.closesAt);
    if(active){
      const recorded=(await tx.query(`select id,shift_schedule_id,check_in_at,check_out_at,status from sagaops.attendance_logs where staff_id=$1 and shift_schedule_id=$2 limit 1`,[staffId,active.schedule.id])).rows[0];
      if(recorded)return {serverTime:nowIso,action:'NONE',eligible:false,reasonCode:'attendance_already_recorded',message:'Absensi untuk shift ini sudah tercatat.',schedule:view(active.schedule),window:{opensAt:active.opensAt.toISOString(),closesAt:active.closesAt.toISOString()},requirements,currentAttendance:attendanceView(recorded)};
      return {serverTime:nowIso,action:'CLOCK_IN',eligible:true,reasonCode:null,message:'Kamu dapat absen masuk untuk shift ini.',schedule:view(active.schedule),window:{opensAt:active.opensAt.toISOString(),closesAt:active.closesAt.toISOString()},requirements,currentAttendance:null};
    }
    const upcoming=candidates.find((item)=>now<item.opensAt);
    if(upcoming)return {serverTime:nowIso,action:'NONE',eligible:false,reasonCode:'attendance_not_open',message:'Absensi belum dibuka. Coba lagi satu jam sebelum shift dimulai.',schedule:view(upcoming.schedule),window:{opensAt:upcoming.opensAt.toISOString(),closesAt:upcoming.closesAt.toISOString()},requirements,currentAttendance:null};
    const recent=[...candidates].reverse().find((item)=>now>item.closesAt);
    return {serverTime:nowIso,action:recent?'CORRECTION':'NONE',eligible:false,reasonCode:recent?'attendance_window_closed':'attendance_schedule_required',
      message:recent?'Batas absensi sudah lewat. Ajukan koreksi kehadiran.':'Kamu belum memiliki jadwal aktif untuk absensi.',schedule:view(recent?.schedule),
      window:recent?{opensAt:recent.opensAt.toISOString(),closesAt:recent.closesAt.toISOString()}:null,requirements,currentAttendance:null};
  }
  async function attendanceEligibility(staffId){const id=requireId(staffId);return own(id,(tx)=>eligibilityIn(tx,id));}
  async function attendanceOperationStatus(staffId,idempotencyKeyValue){
    const id=requireId(staffId),operationId=requireId(idempotencyKeyValue);
    return own(id,async(tx)=>{
      const candidates=(await tx.query(`select * from sagaops.attendance_logs where staff_id=$1 and organization_id=$2 and outlet_id=$3 and note like $4 order by updated_at desc limit 10`,[id,org,outlet,`%${operationId}%`])).rows;
      for(const row of candidates){
        const envelope=parseAttendanceEnvelope(row.note);
        const action=envelope?.checkInIdempotencyKey===operationId?'CLOCK_IN':envelope?.checkOutIdempotencyKey===operationId?'CLOCK_OUT':null;
        if(!action)continue;
        return {operationId,status:'succeeded',found:true,action,recordId:row.id,recordedAt:dateIso(action==='CLOCK_IN'?row.check_in_at:row.check_out_at),attendance:attendanceView(row),serverTime:clock().toISOString()};
      }
      const challenge=(await tx.query(`select id,action,shift_schedule_id,expires_at,consumed_at,created_at from sagaops.native_attendance_challenges
        where organization_id=$1 and outlet_id=$2 and staff_id=$3 and idempotency_key=$4 order by created_at desc limit 1`,[org,outlet,id,operationId])).rows[0];
      if(!challenge)return {operationId,status:'not_found',found:false,action:null,recordId:null,recordedAt:null,attendance:null,serverTime:clock().toISOString()};
      if(challenge.consumed_at)return {operationId,status:'failed',found:true,action:challenge.action,recordId:null,recordedAt:null,attendance:null,errorCode:'attendance_result_unresolved',retryable:false,challengeId:challenge.id,scheduleId:challenge.shift_schedule_id,preparedAt:dateIso(challenge.created_at),expiresAt:dateIso(challenge.expires_at),serverTime:clock().toISOString()};
      if(Date.parse(challenge.expires_at)<clock().getTime())return {operationId,status:'failed',found:true,action:challenge.action,recordId:null,recordedAt:null,attendance:null,errorCode:'attendance_challenge_expired',retryable:true,challengeId:challenge.id,scheduleId:challenge.shift_schedule_id,preparedAt:dateIso(challenge.created_at),expiresAt:dateIso(challenge.expires_at),serverTime:clock().toISOString()};
      return {operationId,status:'pending',found:true,action:challenge.action,recordId:null,recordedAt:null,attendance:null,challengeId:challenge.id,scheduleId:challenge.shift_schedule_id,preparedAt:dateIso(challenge.created_at),expiresAt:dateIso(challenge.expires_at),serverTime:clock().toISOString()};
    });
  }
  async function prepareAttendance(staffId,input={}){
    const id=requireId(staffId),action=String(input.action??''),idempotencyKey=requireId(input.idempotencyKey),sessionBinding=sessionBindingValue(input.sessionBinding);
    if(!['CLOCK_IN','CLOCK_OUT','CORRECTION'].includes(action))throw fail('attendance_action_invalid');
    return own(id,async(tx)=>{
      await cleanupAttendanceArtifacts(tx);
      const eligibility=await eligibilityIn(tx,id,{lock:true});
      if(action!=='CORRECTION'&&(!eligibility.eligible||eligibility.action!==action))throw fail(eligibility.reasonCode??'attendance_not_eligible',409);
      const policy=await attendancePolicy(tx),scheduleId=requireId(input.scheduleId??eligibility.schedule?.id),token=randomBytes(32).toString('base64url'),tokenHash=hashToken(token),expiresAt=new Date(clock().getTime()+5*60_000).toISOString(),capturePrompt=`SAGA-${randomBytes(3).toString('hex').toUpperCase()}`;
      const prior=(await tx.query(`select consumed_at from sagaops.native_attendance_challenges where staff_id=$1 and action=$2 and idempotency_key=$3 limit 1`,[id,action,idempotencyKey])).rows[0];
      if(prior)throw fail(prior.consumed_at?'attendance_idempotency_reused':'attendance_prepare_already_created',409);
      const row={id:randomUUID(),organization_id:org,outlet_id:outlet,staff_id:id,shift_schedule_id:scheduleId,action,token_hash:tokenHash,idempotency_key:idempotencyKey,expires_at:expiresAt,consumed_at:null,session_binding_hash:sessionBinding?hashToken(sessionBinding):null,policy_version:policy.version,capture_prompt:capturePrompt};
      await tx.query(`insert into sagaops.native_attendance_challenges(id,organization_id,outlet_id,staff_id,shift_schedule_id,action,token_hash,idempotency_key,policy_version,session_binding_hash,capture_prompt,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[row.id,org,outlet,id,scheduleId,action,tokenHash,idempotencyKey,policy.version,row.session_binding_hash,capturePrompt,expiresAt]);attendanceChallenges.set(row.id,row);
      return {challengeId:row.id,challengeToken:token,action,expiresAt,schedule:eligibility.schedule,requirements:eligibility.requirements,policyVersion:policy.version,capturePrompt};
    });
  }
  async function initializeAttendanceEvidence(staffId,input={}){
    if(!attendanceEvidenceStorage)throw fail('attendance_evidence_storage_unavailable',503);
    const id=requireId(staffId),challengeId=requireId(input.challengeId),challengeToken=String(input.challengeToken??''),contentType=String(input.contentType??'').toLowerCase(),sessionBinding=sessionBindingValue(input.sessionBinding);
    const byteSize=positiveInt(input.byteSize,'attendance_evidence_size_invalid'),width=positiveInt(input.width,'attendance_evidence_dimension_invalid'),height=positiveInt(input.height,'attendance_evidence_dimension_invalid');
    const checksum=String(input.checksum??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(checksum))throw fail('attendance_evidence_checksum_invalid');
    const capturedAt=iso(input.capturedAt),extension=contentType==='image/jpeg'?'jpg':contentType==='image/png'?'png':contentType==='image/webp'?'webp':null;
    if(Math.abs(Date.parse(capturedAt)-clock().getTime())>10*60_000)throw fail('attendance_evidence_capture_stale',409);
    if(!extension||byteSize>10*1024*1024||width>4096||height>4096||width*height>12_000_000)throw fail('attendance_evidence_content_invalid',415);
    return own(id,async(tx)=>{
      const challenge=await requireChallenge(tx,{staffId:id,challengeId,challengeToken,sessionBinding});
      const policy=await attendancePolicy(tx);if(challenge.policy_version!==policy.version)throw fail('attendance_policy_changed_retry',409);
      if(String(input.capturePrompt??'')!==challenge.capture_prompt)throw fail('attendance_capture_challenge_mismatch',409);
      const coordinates=policy.enforcementState==='ACTIVE'&&policy.gpsRequired?coordinatesRecord(input.coordinates):coordinatesRecordOptional(input.coordinates),geo=coordinates?geofenceResult(coordinates,policy):{status:'NOT_REQUIRED',distanceMeters:null};
      if(policy.geofenceAction==='BLOCK'&&policy.enforcementState==='ACTIVE'&&policy.gpsRequired&&geo.status!=='INSIDE')throw fail(geo.status==='OUTSIDE'?'attendance_outside_geofence':geo.status==='POOR_ACCURACY'?'attendance_gps_accuracy_low':'attendance_outlet_location_not_configured',409);
      const evidenceId=randomUUID(),objectKey=attendanceEvidenceObjectKey({organizationId:org,outletId:outlet,staffId:id,evidenceId,extension});
      const row={id:evidenceId,organization_id:org,outlet_id:outlet,staff_id:id,shift_schedule_id:challenge.shift_schedule_id,challenge_id:challenge.id,event_type:challenge.action,object_key:objectKey,status:'INITIALIZED',content_type:contentType,byte_size:byteSize,checksum,width,height,captured_at:capturedAt,latitude:coordinates?.latitude??null,longitude:coordinates?.longitude??null,accuracy_meters:coordinates?.accuracyMeters??null,distance_meters:geo.distanceMeters,geofence_status:geo.status,policy_version:policy.version,session_binding_hash:challenge.session_binding_hash,risk_flags:[],expires_at:new Date(clock().getTime()+15*60_000).toISOString()};
      await tx.query(`insert into sagaops.native_attendance_evidence(id,organization_id,outlet_id,staff_id,shift_schedule_id,challenge_id,event_type,object_key,status,content_type,byte_size,checksum,width,height,captured_at,latitude,longitude,accuracy_meters,distance_meters,geofence_status,policy_version,session_binding_hash,risk_flags,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24)`,[row.id,org,outlet,id,row.shift_schedule_id,row.challenge_id,row.event_type,row.object_key,row.status,row.content_type,row.byte_size,row.checksum,row.width,row.height,row.captured_at,row.latitude,row.longitude,row.accuracy_meters,row.distance_meters,row.geofence_status,row.policy_version,row.session_binding_hash,JSON.stringify(row.risk_flags),row.expires_at]);attendanceEvidence.set(evidenceId,row);
      return {evidenceId,status:row.status,geofenceStatus:row.geofence_status,distanceMeters:row.distance_meters};
    });
  }
  async function uploadAttendanceEvidence(staffId,evidenceIdValue,upload={}){
    if(!attendanceEvidenceStorage)throw fail('attendance_evidence_storage_unavailable',503);
    const id=requireId(staffId),evidenceId=requireId(evidenceIdValue);
    return own(id,async(tx)=>{
      const row=await findEvidence(tx,evidenceId);
      if(!row||row.staff_id!==id||row.organization_id!==org||row.outlet_id!==outlet)throw fail('attendance_evidence_not_found',404);
      if(Date.parse(row.expires_at)<clock().getTime())throw fail('attendance_evidence_expired',409);
      if(row.status==='VERIFIED'||row.status==='LINKED')return {evidenceId,status:row.status,idempotentReplay:true};
      const initializedLength=Number(row.byte_size),providedLength=Number(upload.contentLength),providedType=String(upload.contentType??'').toLowerCase(),providedChecksum=String(upload.checksum??'').toLowerCase();
      if(providedType!==row.content_type||providedChecksum!==row.checksum||Number.isFinite(providedLength)&&providedLength!==initializedLength)throw fail('attendance_evidence_upload_metadata_mismatch',422);
      // Safari/PWA can stream a known Blob without forwarding Content-Length through
      // HTTP/2 and the reverse proxy. The authenticated init record remains the
      // authority; storage still counts every byte and rejects short/oversized bodies.
      const stored=await attendanceEvidenceStorage.put({objectKey:row.object_key,body:upload.body,contentLength:initializedLength,contentType:row.content_type,expectedChecksum:row.checksum,width:row.width,height:row.height});
      const fingerprint=await tx.query(`insert into sagaops.native_attendance_evidence_fingerprints(organization_id,outlet_id,checksum,first_staff_id,first_evidence_id)
        values($1,$2,$3,$4,$5) on conflict(organization_id,outlet_id,checksum) do nothing returning checksum`,[org,outlet,row.checksum,id,row.id]);
      const duplicate=fingerprint.rows.length===0;
      if(duplicate)row.risk_flags.push('DUPLICATE_CHECKSUM');
      row.status='VERIFIED';row.uploaded_at=clock().toISOString();row.verified_at=row.uploaded_at;await tx.query(`update sagaops.native_attendance_evidence set status='VERIFIED',risk_flags=$2::jsonb,uploaded_at=$3,verified_at=$3 where id=$1`,[row.id,JSON.stringify(row.risk_flags),row.uploaded_at]);return {evidenceId,status:row.status,idempotentReplay:stored.idempotentReplay===true,riskFlags:[...row.risk_flags]};
    });
  }
  async function clockIn(staffId,input={}) {
    const id=requireId(staffId);
    return own(id,async(tx)=>{
      const open=(await tx.query(`select id,check_in_at from sagaops.attendance_logs where staff_id=$1 and check_in_at is not null and check_out_at is null for update`,[id])).rows[0];
      if(open)return {...open,alreadyOpen:true};
      const eligibility=await eligibilityIn(tx,id,{lock:true});
      if(!eligibility.eligible||eligibility.action!=='CLOCK_IN')throw fail(eligibility.reasonCode??'attendance_not_eligible',409);
      const schedule=eligibility.schedule,now=clock().toISOString(),late=eligibility.testMode?0:Math.max(0,Math.floor((Date.parse(now)-Date.parse(schedule.scheduledStartAt))/60000)-Number((await tx.query('select grace_period_minutes from sagaops.shift_schedules where id=$1',[schedule.id])).rows[0]?.grace_period_minutes??0));
      let evidence=null,challenge=null,idempotencyKey=null,reviewStatus='NOT_REQUIRED',reviewReason=null,locationEvidence=null;
      if(eligibility.testMode){reviewStatus='PENDING';reviewReason='attendance_prototype_anytime_mode';}
      if(attendanceEvidenceStorage){
        const policy=await attendancePolicy(tx);idempotencyKey=requireId(input.idempotencyKey);challenge=await requireChallenge(tx,{staffId:id,challengeId:input.challengeId,challengeToken:input.challengeToken,action:'CLOCK_IN',scheduleId:schedule.id,sessionBinding:input.sessionBinding});
        if(challenge.policy_version!==policy.version)throw fail('attendance_policy_changed_retry',409);
        evidence=await requireEvidence(tx,{staffId:id,evidenceId:input.evidenceId,challengeId:challenge.id,required:policy.enforcementState==='ACTIVE'&&policy.selfieRequired});
        const location=attendanceLocationProof({input,evidence,policy,clock});locationEvidence=location.view;
        if(location.blocked)throw fail(location.reason,409);
        if(location.reviewReason||evidence?.risk_flags?.length){reviewStatus='PENDING';reviewReason=location.reviewReason??'attendance_duplicate_evidence';}
      }
      const note=JSON.stringify(attendanceEnvelope({checkInEvidence:evidenceView(evidence)??locationEvidence,checkInIdempotencyKey:idempotencyKey,checkInSessionBindingHash:challenge?.session_binding_hash??null,policyVersion:challenge?.policy_version??null,reviewStatus,reviewReason,testMode:eligibility.testMode===true}));
      const row=(await tx.query(`insert into sagaops.attendance_logs(organization_id,outlet_id,staff_id,shift_schedule_id,check_in_at,status,is_unscheduled,late_minutes,note)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,[org,outlet,id,schedule.id,now,late>0?'late':'present',eligibility.testMode===true,late,note])).rows[0];
      if(evidence){evidence.status='LINKED';await tx.query(`update sagaops.native_attendance_evidence set status='LINKED' where id=$1`,[evidence.id]);}if(challenge)await consumeChallenge(tx,challenge.id);
      return attendanceView(row);
    });
  }
  async function clockOut(staffId,input={}) {
    const id=requireId(staffId);
    return own(id,async(tx)=>{
      const eligibility=await eligibilityIn(tx,id,{lock:true});
      if(!eligibility.eligible||eligibility.action!=='CLOCK_OUT')throw fail(eligibility.reasonCode==='attendance_already_recorded'?'no_open_attendance':eligibility.reasonCode??'no_open_attendance',409);
      const open=(await tx.query(`select a.*,s.scheduled_end_at from sagaops.attendance_logs a join sagaops.shift_schedules s on s.id=a.shift_schedule_id
        where a.id=$1 for update of a`,[eligibility.currentAttendance.id])).rows[0];
      const now=clock().toISOString(),worked=Math.max(0,Math.floor((Date.parse(now)-Date.parse(open.check_in_at))/60000)),early=Math.max(0,Math.floor((Date.parse(open.scheduled_end_at)-Date.parse(now))/60000)),overtime=Math.max(0,Math.floor((Date.parse(now)-Date.parse(open.scheduled_end_at))/60000));
      let evidence=null,challenge=null,idempotencyKey=null,reviewStatus=open.review_status??'NOT_REQUIRED',reviewReason=open.review_reason??null,locationEvidence=null;
      const previous=parseAttendanceEnvelope(open.note)??attendanceEnvelope({});if(previous.reviewStatus==='PENDING'){reviewStatus='PENDING';reviewReason=previous.reviewReason;}
      if(attendanceEvidenceStorage){const policy=await attendancePolicy(tx);idempotencyKey=requireId(input.idempotencyKey);challenge=await requireChallenge(tx,{staffId:id,challengeId:input.challengeId,challengeToken:input.challengeToken,action:'CLOCK_OUT',scheduleId:open.shift_schedule_id,sessionBinding:input.sessionBinding});if(challenge.policy_version!==policy.version)throw fail('attendance_policy_changed_retry',409);evidence=await requireEvidence(tx,{staffId:id,evidenceId:input.evidenceId,challengeId:challenge.id,required:policy.enforcementState==='ACTIVE'&&policy.selfieRequired});const location=attendanceLocationProof({input,evidence,policy,clock});locationEvidence=location.view;if(location.blocked)throw fail(location.reason,409);if(location.reviewReason||evidence?.risk_flags?.length){reviewStatus='PENDING';reviewReason=location.reviewReason??'attendance_duplicate_evidence';}if(worked<policy.minimumWorkedMinutes){reviewStatus='PENDING';reviewReason='attendance_duration_too_short';}else if(early>policy.earlyLeaveReviewMinutes){reviewStatus='PENDING';reviewReason='attendance_early_leave';}if(previous.checkInSessionBindingHash&&challenge.session_binding_hash&&previous.checkInSessionBindingHash!==challenge.session_binding_hash){reviewStatus='PENDING';reviewReason='attendance_device_changed';}}
      const note=JSON.stringify({...previous,checkOutEvidence:evidenceView(evidence)??locationEvidence,checkOutIdempotencyKey:idempotencyKey,checkOutSessionBindingHash:challenge?.session_binding_hash??null,reviewStatus,reviewReason});
      const row=(await tx.query(`update sagaops.attendance_logs set check_out_at=$2,worked_minutes=$3,early_leave_minutes=$4,overtime_candidate_minutes=$5,note=$6,updated_at=now()
        where id=$1 returning *`,[open.id,now,worked,early,overtime,note])).rows[0];
      if(evidence){evidence.status='LINKED';await tx.query(`update sagaops.native_attendance_evidence set status='LINKED' where id=$1`,[evidence.id]);}if(challenge)await consumeChallenge(tx,challenge.id);return attendanceView(row);
    });
  }
  async function requireChallenge(tx,{staffId,challengeId,challengeToken,action=null,scheduleId=null,sessionBinding=null}){
    const id=requireId(challengeId),token=String(challengeToken??'');if(token.length<20||token.length>256)throw fail('attendance_challenge_invalid',401);
    const row=await findChallenge(tx,id);
    if(!row||row.token_hash!==hashToken(token)||row.staff_id!==staffId||row.organization_id!==org||row.outlet_id!==outlet)throw fail('attendance_challenge_invalid',401);
    if(row.consumed_at)throw fail('attendance_challenge_consumed',409);
    if(Date.parse(row.expires_at)<clock().getTime())throw fail('attendance_challenge_expired',409);
    if(action&&row.action!==action)throw fail('attendance_challenge_action_mismatch',409);
    if(scheduleId&&row.shift_schedule_id!==scheduleId)throw fail('attendance_challenge_schedule_mismatch',409);
    const binding=sessionBindingValue(sessionBinding);if(row.session_binding_hash&&(!binding||row.session_binding_hash!==hashToken(binding)))throw fail('attendance_challenge_session_mismatch',409);
    return row;
  }
  async function requireEvidence(tx,{staffId,evidenceId,challengeId,required}){
    if(!evidenceId){if(required)throw fail('attendance_selfie_required',409);return null;}
    const id=requireId(evidenceId),row=await findEvidence(tx,id);
    if(row&&(row.staff_id!==staffId||row.challenge_id!==challengeId||row.organization_id!==org||row.outlet_id!==outlet))throw fail('attendance_evidence_not_found',404);
    if(!row)throw fail('attendance_evidence_not_found',404);if(row.status!=='VERIFIED')throw fail('attendance_evidence_incomplete',409);return row;
  }
  async function consumeChallenge(tx,id){
    const row=await findChallenge(tx,id);if(!row||row.consumed_at)throw fail('attendance_challenge_consumed',409);row.consumed_at=clock().toISOString();await tx.query(`update sagaops.native_attendance_challenges set consumed_at=$2 where id=$1 and consumed_at is null`,[id,row.consumed_at]);
  }
  async function findChallenge(tx,id){let row=attendanceChallenges.get(id);if(!row){row=(await tx.query(`select * from sagaops.native_attendance_challenges where id=$1`,[id])).rows[0]??null;if(row){row={...row,expires_at:dateIso(row.expires_at),consumed_at:dateIso(row.consumed_at)};attendanceChallenges.set(id,row);}}return row;}
  async function findEvidence(tx,id){let row=attendanceEvidence.get(id);if(!row){row=(await tx.query(`select * from sagaops.native_attendance_evidence where id=$1`,[id])).rows[0]??null;if(row){row={...row,captured_at:dateIso(row.captured_at),expires_at:dateIso(row.expires_at),uploaded_at:dateIso(row.uploaded_at),verified_at:dateIso(row.verified_at),risk_flags:Array.isArray(row.risk_flags)?row.risk_flags:[]};attendanceEvidence.set(id,row);}}return row;}
  async function cleanupAttendanceArtifacts(tx){
    const now=clock().getTime();
    for(const [key,challenge] of attendanceChallenges)if(Date.parse(challenge.expires_at)<now||challenge.consumed_at&&Date.parse(challenge.consumed_at)<now-15*60_000)attendanceChallenges.delete(key);
    for(const [key,evidence] of attendanceEvidence){
      if(evidence.status==='LINKED'||Date.parse(evidence.expires_at)>=now)continue;
      if(['VERIFIED','INITIALIZED'].includes(evidence.status)&&attendanceEvidenceStorage?.delete)await attendanceEvidenceStorage.delete({objectKey:evidence.object_key}).catch(()=>{});
      attendanceEvidence.delete(key);
    }
    const expired=(await tx.query(`select id,object_key from sagaops.native_attendance_evidence where status in ('INITIALIZED','VERIFIED') and expires_at<$1`,[new Date(now).toISOString()])).rows;
    for(const evidence of expired)if(attendanceEvidenceStorage?.delete)await attendanceEvidenceStorage.delete({objectKey:evidence.object_key}).catch(()=>{});
    await tx.query(`update sagaops.native_attendance_evidence set status='EXPIRED' where status in ('INITIALIZED','VERIFIED') and expires_at<$1`,[new Date(now).toISOString()]);
    await tx.query(`delete from sagaops.native_attendance_challenges c where (c.expires_at<$1 or c.consumed_at<$2) and not exists(select 1 from sagaops.native_attendance_evidence e where e.challenge_id=c.id)`,[new Date(now).toISOString(),new Date(now-15*60_000).toISOString()]);
  }
  async function submitAttendanceCorrection(staffId,input={}){
    const kindMap={check_in:'MISSED_CLOCK_IN',check_out:'MISSED_CLOCK_OUT'},id=requireId(staffId),scheduleId=requireId(input.scheduleId),type=String(input.type??input.correctionType??kindMap[String(input.kind??'')]??''),proposedAt=iso(input.proposedAt??input.clientRequestedAt),reason=clean(input.reason,120);
    if(!['MISSED_CLOCK_IN','MISSED_CLOCK_OUT'].includes(type)||reason.length<10)throw fail('attendance_correction_invalid');
    return own(id,async(tx)=>{
      const schedule=(await tx.query(`select id,scheduled_start_at,scheduled_end_at from sagaops.shift_schedules where id=$1 and staff_id=$2 and organization_id=$3 and outlet_id=$4 and status='scheduled'`,[scheduleId,id,org,outlet])).rows[0];
      if(!schedule)throw fail('schedule_not_found',404);
      if(Date.parse(proposedAt)<Date.parse(schedule.scheduled_start_at)-60*60_000||Date.parse(proposedAt)>Date.parse(schedule.scheduled_end_at)+60*60_000)throw fail('attendance_correction_time_invalid');
      const attendance=(await tx.query(`select id,check_in_at,check_out_at from sagaops.attendance_logs where staff_id=$1 and shift_schedule_id=$2 limit 1`,[id,scheduleId])).rows[0];
      if(type==='MISSED_CLOCK_OUT'&&!attendance?.check_in_at)throw fail('attendance_clock_in_required',409);
      if(type==='MISSED_CLOCK_OUT'&&attendance.check_out_at||type==='MISSED_CLOCK_IN'&&attendance?.check_in_at)throw fail('attendance_already_recorded',409);
      const evidence=input.evidenceId?await findEvidence(tx,requireId(input.evidenceId)):null;if(evidence&&(evidence.staff_id!==id||evidence.shift_schedule_id!==scheduleId||evidence.event_type!=='CORRECTION'||evidence.status!=='VERIFIED'))throw fail('attendance_evidence_not_found',404);
      const duplicates=(await tx.query(`select reason from sagaops.native_staff_requests where staff_id=$1 and schedule_id=$2 and state='submitted' and reason like 'ATTENDANCE_CORRECTION_V1|%'`,[id,scheduleId])).rows;if(duplicates.some((row)=>parseCorrectionReason(row.reason)?.type===type))throw fail('attendance_correction_already_submitted',409);
      const payload=correctionReason({type,reason,attendanceId:attendance?.id??null,evidence:evidenceView(evidence)}),endsAt=new Date(Date.parse(proposedAt)+60_000).toISOString();
      const row=(await tx.query(`insert into sagaops.native_staff_requests(organization_id,staff_id,schedule_id,category,reason,starts_at,ends_at)
        values($1,$2,$3,'permission',$4,$5,$6) returning id,staff_id,schedule_id,reason,starts_at,state,created_at`,[org,id,scheduleId,payload,proposedAt,endsAt])).rows[0];
      if(evidence){evidence.status='LINKED';await tx.query(`update sagaops.native_attendance_evidence set status='LINKED' where id=$1`,[evidence.id]);}return {id:row.id,attendanceId:attendance?.id??null,scheduleId,staffId:id,type,proposedAt,reason,status:row.state,createdAt:dateIso(row.created_at),evidenceRequiredForDecision:evidence==null};
    });
  }
  async function saveAttendancePolicy(input={}){
    const early=boundedInt(input.earlyOpenMinutes??60,0,120,'attendance_policy_invalid'),lateCheckIn=boundedInt(input.lateCheckInMinutes??60,0,180,'attendance_policy_invalid'),post=boundedInt(input.postCloseMinutes??60,0,180,'attendance_policy_invalid'),minimumWorked=boundedInt(input.minimumWorkedMinutes??30,0,240,'attendance_policy_invalid'),earlyLeaveReview=boundedInt(input.earlyLeaveReviewMinutes??30,0,240,'attendance_policy_invalid'),accuracy=boundedInt(input.maxAccuracyMeters??100,10,500,'attendance_policy_invalid'),radius=boundedInt(input.geofenceRadiusMeters??100,10,1000,'attendance_policy_invalid'),retention=boundedInt(input.evidenceRetentionDays??30,7,90,'attendance_policy_invalid');
    const lat=input.outletLatitude==null?null:Number(input.outletLatitude),lng=input.outletLongitude==null?null:Number(input.outletLongitude);if((lat==null)!==(lng==null)||(lat!=null&&(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180)))throw fail('attendance_policy_coordinates_invalid');
    const action=String(input.geofenceAction??'REVIEW'),state=String(input.enforcementState??'ACTIVE');if(!['REVIEW','BLOCK'].includes(action)||!['ACTIVE','DISABLED'].includes(state))throw fail('attendance_policy_invalid');
    const anytimeTestMode=input.anytimeTestMode===true,gpsRequired=input.gpsRequired!==false,selfieRequired=input.selfieRequired!==false;if(state==='ACTIVE'&&gpsRequired&&action==='BLOCK'&&(lat==null||lng==null))throw fail('attendance_outlet_location_required',409);
    const actor=input.actorUserId==null?ids.ownerProfileId:requireId(input.actorUserId),version=Number(schemaNeutralPolicy.version??0)+1,updatedAt=clock().toISOString();
    schemaNeutralPolicy={timezone:'Asia/Jakarta',earlyOpenMinutes:early,lateCheckInMinutes:lateCheckIn,postCloseMinutes:post,minimumWorkedMinutes:minimumWorked,earlyLeaveReviewMinutes:earlyLeaveReview,anytimeTestMode,gpsRequired,selfieRequired,maxAccuracyMeters:accuracy,geofenceRadiusMeters:radius,outletLatitude:lat,outletLongitude:lng,geofenceAction:action,enforcementState:state,version,updatedAt,updatedBy:actor,evidenceRetentionDays:retention,loaded:true};
    if(attendanceEvidenceStorage?.savePolicy)await attendanceEvidenceStorage.savePolicy(schemaNeutralPolicy);
    await attendanceAudit('attendance.policy.updated',outlet,input.actorReference,{version,anytimeTestMode,gpsRequired,selfieRequired,geofenceAction:action,enforcementState:state});
    return {...schemaNeutralPolicy};
  }
  async function reviewAttendance(input={}){
    const decision=String(input.decision??'').toUpperCase(),note=clean(input.note,500),actor=input.actorUserId==null?ids.ownerProfileId:requireId(input.actorUserId),actorReference=input.actorReference?clean(input.actorReference,80):'OWNER',reviewedAt=clock().toISOString();if(!['APPROVED','REJECTED'].includes(decision))throw fail('attendance_review_decision_invalid');
    if(input.correctionId){
      const correctionId=requireId(input.correctionId);
      return db.transaction(async(tx)=>{
        const request=(await tx.query(`select r.*,s.scheduled_start_at,s.scheduled_end_at from sagaops.native_staff_requests r join sagaops.shift_schedules s on s.id=r.schedule_id
          join sagaops.staff_profiles p on p.id=r.staff_id where r.id=$1 and r.organization_id=$2 and p.outlet_id=$3 for update`,[correctionId,org,outlet])).rows[0],detail=parseCorrectionReason(request?.reason);
        if(!request||request.state!=='submitted'||!detail)throw fail('attendance_review_not_actionable',409);
        let attendanceId=detail.attendanceId;
        if(decision==='APPROVED'&&detail.type==='MISSED_CLOCK_IN'){
          const late=Math.max(0,Math.floor((Date.parse(request.starts_at)-Date.parse(request.scheduled_start_at))/60000)),envelope=attendanceEnvelope({reviewStatus:'APPROVED',reviewReason:note,checkInEvidence:detail.evidence??null,correctionId});
          const row=(await tx.query(`insert into sagaops.attendance_logs(organization_id,outlet_id,staff_id,shift_schedule_id,check_in_at,status,is_unscheduled,late_minutes,note)
            values($1,$2,$3,$4,$5,'manually_corrected',false,$6,$7) on conflict(staff_id,shift_schedule_id) where shift_schedule_id is not null do nothing returning id`,[org,outlet,request.staff_id,request.schedule_id,request.starts_at,late,JSON.stringify(envelope)])).rows[0];attendanceId=row?.id??attendanceId;
        }
        if(decision==='APPROVED'&&detail.type==='MISSED_CLOCK_OUT'){
          const open=(await tx.query(`select a.*,s.scheduled_end_at from sagaops.attendance_logs a join sagaops.shift_schedules s on s.id=a.shift_schedule_id where a.id=$1 and a.check_out_at is null for update of a`,[attendanceId])).rows[0];
          if(!open||Date.parse(request.starts_at)<Date.parse(open.check_in_at))throw fail('attendance_review_not_actionable',409);
          const worked=Math.floor((Date.parse(request.starts_at)-Date.parse(open.check_in_at))/60000),early=Math.max(0,Math.floor((Date.parse(open.scheduled_end_at)-Date.parse(request.starts_at))/60000)),overtime=Math.max(0,Math.floor((Date.parse(request.starts_at)-Date.parse(open.scheduled_end_at))/60000)),envelope={...(parseAttendanceEnvelope(open.note)??attendanceEnvelope({})),checkOutEvidence:detail.evidence??null,reviewStatus:'APPROVED',reviewReason:note,correctionId};
          await tx.query(`update sagaops.attendance_logs set check_out_at=$2,worked_minutes=$3,early_leave_minutes=$4,overtime_candidate_minutes=$5,status='manually_corrected',note=$6,updated_at=now() where id=$1`,[attendanceId,request.starts_at,worked,early,overtime,JSON.stringify(envelope)]);
        }
        const state=decision.toLowerCase(),row=(await tx.query(`update sagaops.native_staff_requests set state=$2,reviewer_note=$3,reviewed_by=$4,reviewed_at=$5,updated_at=now() where id=$1 returning id,state,reviewer_note`,[correctionId,state,note,actor,reviewedAt])).rows[0];
        await attendanceAudit('attendance.correction.reviewed',attendanceId??correctionId,actorReference,{decision,correctionId},tx);return {id:row.id,attendanceId,type:detail.type,status:row.state,reviewNote:row.reviewer_note};
      });
    }
    if(input.attendanceId){
      const attendanceId=requireId(input.attendanceId),current=(await db.query(`select * from sagaops.attendance_logs where id=$1 and organization_id=$2 and outlet_id=$3`,[attendanceId,org,outlet])).rows[0],envelope=parseAttendanceEnvelope(current?.note);
      if(!current||!envelope||envelope.reviewStatus!=='PENDING')throw fail('attendance_review_not_actionable',409);
      const updated={...envelope,reviewStatus:decision,reviewReason:note,reviewedBy:actor,reviewedByReference:actorReference,reviewedAt};await db.query(`update sagaops.attendance_logs set note=$4,updated_at=now() where id=$1 and organization_id=$2 and outlet_id=$3`,[attendanceId,org,outlet,JSON.stringify(updated)]);await attendanceAudit('attendance.evidence.reviewed',attendanceId,actorReference,{decision});return {...attendanceView(current),reviewStatus:decision,reviewReason:note,reviewedBy:actor,reviewedByReference:actorReference,reviewedAt};
    }
    throw fail('attendance_review_not_actionable',409);
  }
  async function openAttendanceEvidence(evidenceIdValue,{actorReference='OWNER'}={}){
    if(!attendanceEvidenceStorage)throw fail('attendance_evidence_storage_unavailable',503);const evidenceId=requireId(evidenceIdValue);
    let row=attendanceEvidence.get(evidenceId);
    if(!row){row=(await db.query(`select * from sagaops.native_attendance_evidence where id=$1 and organization_id=$2 and outlet_id=$3`,[evidenceId,org,outlet])).rows[0]??null;if(row)attendanceEvidence.set(evidenceId,row);}
    if(!row){
      const candidates=(await db.query(`select staff_id,note from sagaops.attendance_logs where organization_id=$1 and outlet_id=$2 and note like $3 order by updated_at desc limit 20`,[org,outlet,`%${evidenceId}%`])).rows;
      for(const candidate of candidates){const envelope=parseAttendanceEnvelope(candidate.note),evidence=[envelope?.checkInEvidence,envelope?.checkOutEvidence].find((item)=>item?.evidenceId===evidenceId);if(!evidence)continue;const extension=evidence.contentType==='image/jpeg'?'jpg':evidence.contentType==='image/png'?'png':'webp',objectKey=attendanceEvidenceObjectKey({organizationId:org,outletId:outlet,staffId:candidate.staff_id,evidenceId,extension}),stored=await attendanceEvidenceStorage.stat({objectKey});row={id:evidenceId,organization_id:org,outlet_id:outlet,status:'LINKED',object_key:objectKey,content_type:stored.contentType,byte_size:stored.byteSize,checksum:stored.checksum};break;}
    }
    if(!row){
      const requests=(await db.query(`select r.staff_id,r.reason from sagaops.native_staff_requests r join sagaops.staff_profiles p on p.id=r.staff_id where r.organization_id=$1 and p.outlet_id=$2 and r.reason like $3 order by r.updated_at desc limit 20`,[org,outlet,`%${evidenceId}%`])).rows;
      for(const request of requests){const evidence=parseCorrectionReason(request.reason)?.evidence;if(evidence?.evidenceId!==evidenceId)continue;const extension=evidence.contentType==='image/jpeg'?'jpg':evidence.contentType==='image/png'?'png':'webp',objectKey=attendanceEvidenceObjectKey({organizationId:org,outletId:outlet,staffId:request.staff_id,evidenceId,extension}),stored=await attendanceEvidenceStorage.stat({objectKey});row={id:evidenceId,organization_id:org,outlet_id:outlet,status:'VERIFIED',object_key:objectKey,content_type:stored.contentType,byte_size:stored.byteSize,checksum:stored.checksum};break;}
    }
    if(row&&(row.organization_id!==org||row.outlet_id!==outlet||!['VERIFIED','LINKED'].includes(row.status)))throw fail('attendance_evidence_not_found',404);
    if(!row)throw fail('attendance_evidence_not_found',404);const stream=await attendanceEvidenceStorage.open({objectKey:row.object_key});await attendanceAudit('attendance.evidence.viewed',evidenceId,actorReference,{contentType:row.content_type,byteSize:row.byte_size});return {stream,contentType:row.content_type,byteSize:row.byte_size,checksum:row.checksum,cacheControl:'private, no-store'};
  }
  async function health(){
    if(attendanceEvidenceStorage?.initialize)await attendanceEvidenceStorage.initialize();
    const storage=attendanceEvidenceStorage?.health?await attendanceEvidenceStorage.health():{ready:false,provider:'OFF',writable:false},policy=await attendancePolicy(db),reviewBacklog=Number((await db.query(`select count(*)::int count from sagaops.attendance_logs where organization_id=$1 and outlet_id=$2 and note like '%"reviewStatus":"PENDING"%'`,[org,outlet])).rows[0]?.count??0),coordinatesConfigured=Number.isFinite(policy.outletLatitude)&&Number.isFinite(policy.outletLongitude),durable=(await db.query(`select (select count(*)::int from sagaops.native_attendance_challenges where organization_id=$1 and outlet_id=$2) challenges,(select count(*)::int from sagaops.native_attendance_evidence where organization_id=$1 and outlet_id=$2) evidence`,[org,outlet])).rows[0];
    const operationalReady=storage.ready===true&&policy.enforcementState==='ACTIVE'&&(!policy.gpsRequired||coordinatesConfigured);
    return {ready:storage.ready===true,operationalReady,storage,policy:{version:policy.version,enforcementState:policy.enforcementState,gpsRequired:policy.gpsRequired,selfieRequired:policy.selfieRequired,coordinatesConfigured,geofenceAction:policy.geofenceAction,evidenceRetentionDays:policy.evidenceRetentionDays},reviewBacklog,durable:{challenges:Number(durable?.challenges??0),evidence:Number(durable?.evidence??0)},inMemory:{challenges:attendanceChallenges.size,evidence:attendanceEvidence.size}};
  }
  async function submitRequest(staffId, input) {
    const id = requireId(staffId), category = input?.category, reason = clean(input?.reason,500);
    if (!categories.has(category) || reason.length < 10) throw fail('request_invalid');
    const scheduleId = input.scheduleId ? requireId(input.scheduleId) : null;
    const targetStaffId = category === 'shift_swap' ? requireId(input.targetStaffId) : null;
    const targetScheduleId = category === 'shift_swap' ? requireId(input.targetScheduleId) : null;
    const startsAt = category === 'shift_swap' ? null : iso(input.startAt);
    const endsAt = category === 'shift_swap' ? null : iso(input.endAt);
    if (startsAt && (Date.parse(endsAt)<=Date.parse(startsAt) || Date.parse(endsAt)-Date.parse(startsAt)>31*24*60*60_000)) throw fail('request_range_invalid');
    if (category === 'overtime' && !scheduleId) throw fail('overtime_schedule_required');
    if (category === 'shift_swap' && (!scheduleId || targetStaffId === id || !(await db.query(`select id from sagaops.shift_schedules where id=$1 and staff_id=$2 and organization_id=$3 and outlet_id=$4 and status='scheduled'`,[targetScheduleId,targetStaffId,org,outlet])).rows.length)) throw fail('swap_target_invalid');
    return own(id, async (tx) => {
      if (scheduleId && !(await tx.query(`select id from sagaops.shift_schedules where id=$1 and staff_id=$2 and organization_id=$3 and outlet_id=$4 and status='scheduled'`, [scheduleId,id,org,outlet])).rows.length) throw fail('schedule_not_found',404);
      if (category === 'overtime') {
        const eligible=(await tx.query(`select s.scheduled_end_at,a.check_out_at,a.overtime_candidate_minutes,a.approved_overtime_minutes
          from sagaops.shift_schedules s join sagaops.attendance_logs a on a.shift_schedule_id=s.id and a.staff_id=s.staff_id
          where s.id=$1 and s.staff_id=$2 and s.organization_id=$3 and s.outlet_id=$4 and s.status='scheduled' and a.check_out_at is not null
          for update of a`,[scheduleId,id,org,outlet])).rows[0];
        validateOvertimeRequest(eligible,startsAt,endsAt);
        const duplicate=(await tx.query(`select 1 from sagaops.native_staff_requests where organization_id=$1 and staff_id=$2 and schedule_id=$3 and category='overtime' and state in ('submitted','approved') limit 1`,[org,id,scheduleId])).rows[0];
        if(duplicate)throw fail('overtime_request_exists',409);
      }
      const row = (await tx.query(`insert into sagaops.native_staff_requests(organization_id,staff_id,schedule_id,target_staff_id,target_schedule_id,category,reason,starts_at,ends_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,category,state,created_at`, [org,id,scheduleId,targetStaffId,targetScheduleId,category,reason,startsAt,endsAt])).rows[0];
      return row;
    });
  }
  async function peerDecision(staffId, requestId, accept) {
    const id = requireId(staffId), request = requireId(requestId);
    const row = (await db.query(`update sagaops.native_staff_requests set state=$4,updated_at=now()
      where id=$1 and target_staff_id=$2 and organization_id=$3 and category='shift_swap' and state='submitted'
      returning id,state`, [request,id,org,accept ? 'peer_accepted':'rejected'])).rows[0];
    if (!row) throw fail('request_not_actionable',409);
    return row;
  }
  async function reviewRequest(requestId, decision, note) {
    const id = requireId(requestId);
    if (!['approved','rejected'].includes(decision)) throw fail('decision_invalid');
    const reviewerNote = note ? clean(note,200) : null;
    if (decision === 'rejected' && !reviewerNote) throw fail('review_note_required');
    return db.transaction(async (tx) => {
      const row = (await tx.query(`select r.* from sagaops.native_staff_requests r join sagaops.staff_profiles p on p.id=r.staff_id and p.organization_id=r.organization_id
        where r.id=$1 and r.organization_id=$2 and p.outlet_id=$3 for update of r`, [id,org,outlet])).rows[0];
      if (!row || !['submitted','peer_accepted'].includes(row.state) || (row.category==='shift_swap' && decision==='approved' && row.state!=='peer_accepted')) throw fail('request_not_actionable',409);
      if (row.category==='overtime' && decision==='approved') {
        const eligible=(await tx.query(`select a.id,s.scheduled_end_at,a.check_out_at,a.overtime_candidate_minutes,a.approved_overtime_minutes
          from sagaops.shift_schedules s join sagaops.attendance_logs a on a.shift_schedule_id=s.id and a.staff_id=s.staff_id
          where s.id=$1 and s.staff_id=$2 and s.organization_id=$3 and s.outlet_id=$4 and s.status='scheduled' and a.check_out_at is not null
          for update of a`,[row.schedule_id,row.staff_id,org,outlet])).rows[0];
        const requestedMinutes=validateOvertimeRequest(eligible,row.starts_at,row.ends_at);
        await tx.query(`update sagaops.attendance_logs set approved_overtime_minutes=$2,updated_at=now() where id=$1`,[eligible.id,requestedMinutes]);
      }
      if (row.category==='shift_swap' && decision==='approved') {
        const shifts = (await tx.query(`select id,staff_id,business_date,scheduled_start_at,scheduled_end_at from sagaops.shift_schedules where id=any($1::uuid[]) and organization_id=$2 and outlet_id=$3 and status='scheduled' for update`, [[row.schedule_id,row.target_schedule_id],org,outlet])).rows;
        if (shifts.length!==2 || shifts.some((shift)=>Date.parse(shift.scheduled_start_at)<=clock().getTime()) ||
          shifts.find((shift)=>shift.id===row.schedule_id)?.staff_id!==row.staff_id || shifts.find((shift)=>shift.id===row.target_schedule_id)?.staff_id!==row.target_staff_id) throw fail('swap_schedule_changed',409);
        if ((await tx.query(`select 1 from sagaops.attendance_logs where shift_schedule_id=any($1::uuid[]) limit 1`, [[row.schedule_id,row.target_schedule_id]])).rows.length) throw fail('swap_schedule_locked',409);
        const linked=(await tx.query(`select a.*,t.role_requirements,p.rules as period_rules,p.period_start,p.period_end
          from sagaops.native_roster_assignments a join sagaops.native_shift_templates t on t.id=a.shift_template_id
          join sagaops.native_roster_periods p on p.id=a.roster_period_id
          where a.published_schedule_id=any($1::uuid[]) and a.organization_id=$2 and a.outlet_id=$3 for update`,[[row.schedule_id,row.target_schedule_id],org,outlet])).rows;
        if(linked.length===1)throw fail('swap_roster_mismatch',409);
        const people=(await tx.query(`select p.id,p.role,c.state from sagaops.staff_profiles p join sagaops.native_staff_credentials c on c.staff_id=p.id
          where p.id=any($1::uuid[]) and p.organization_id=$2 and p.outlet_id=$3 and p.status='active'`,[[row.staff_id,row.target_staff_id],org,outlet])).rows;
        const personById=new Map(people.map((person)=>[person.id,person]));
        if(people.length!==2||people.some((person)=>person.state==='suspended'))throw fail('swap_staff_ineligible',409);
        if(linked.length===2){
          const assignmentForOwn=linked.find((item)=>item.published_schedule_id===row.schedule_id), assignmentForTarget=linked.find((item)=>item.published_schedule_id===row.target_schedule_id);
          const targetPerson=personById.get(row.target_staff_id), ownPerson=personById.get(row.staff_id);
          const roleAllowed=(assignment,person)=>person&&person.state!=='suspended'&&(!Array.isArray(assignment.role_requirements)||!assignment.role_requirements.length||assignment.role_requirements.some((entry)=>entry.role===person.role));
          if(!assignmentForOwn||!assignmentForTarget||!roleAllowed(assignmentForOwn,targetPerson)||!roleAllowed(assignmentForTarget,ownPerson))throw fail('swap_role_mismatch',409);
          const assignmentIds=linked.map((item)=>item.id), scheduleIds=[row.schedule_id,row.target_schedule_id];
          const ownConflicts=await hardConflicts(tx,{id:assignmentForOwn.roster_period_id,rules:assignmentForOwn.period_rules},{staff:row.target_staff_id,date:dbDate(assignmentForOwn.business_date),startAt:assignmentForOwn.scheduled_start_at,endAt:assignmentForOwn.scheduled_end_at},{excludeAssignmentIds:assignmentIds,excludeScheduleIds:scheduleIds});
          const targetConflicts=await hardConflicts(tx,{id:assignmentForTarget.roster_period_id,rules:assignmentForTarget.period_rules},{staff:row.staff_id,date:dbDate(assignmentForTarget.business_date),startAt:assignmentForTarget.scheduled_start_at,endAt:assignmentForTarget.scheduled_end_at},{excludeAssignmentIds:assignmentIds,excludeScheduleIds:scheduleIds});
          if(ownConflicts.length||targetConflicts.length)throw Object.assign(fail('swap_schedule_conflict',409),{details:{requester:targetConflicts,target:ownConflicts}});
        }else{
          const ownShift=shifts.find((shift)=>shift.id===row.schedule_id), targetShift=shifts.find((shift)=>shift.id===row.target_schedule_id);
          const exclusions=[row.schedule_id,row.target_schedule_id], fallbackPeriod={id:null,rules:normalizeRules({})};
          const ownConflicts=await hardConflicts(tx,fallbackPeriod,{staff:row.target_staff_id,date:dbDate(ownShift.business_date),startAt:ownShift.scheduled_start_at,endAt:ownShift.scheduled_end_at},{excludeScheduleIds:exclusions});
          const targetConflicts=await hardConflicts(tx,fallbackPeriod,{staff:row.staff_id,date:dbDate(targetShift.business_date),startAt:targetShift.scheduled_start_at,endAt:targetShift.scheduled_end_at},{excludeScheduleIds:exclusions});
          if(ownConflicts.length||targetConflicts.length)throw Object.assign(fail('swap_schedule_conflict',409),{details:{requester:targetConflicts,target:ownConflicts}});
        }
        await tx.query("select set_config('app.native_roster_mutation','authorized',true)");
        await tx.query(`update sagaops.shift_schedules set staff_id=case when id=$1 then $3::uuid else $4::uuid end,updated_at=now()
          where id=any($5::uuid[]) and organization_id=$2`, [row.schedule_id,org,row.target_staff_id,row.staff_id,[row.schedule_id,row.target_schedule_id]]);
        if(linked.length===2){
          const roleById=new Map(people.map((person)=>[person.id,person.role]));
          const removed=(await tx.query(`delete from sagaops.native_roster_assignments where published_schedule_id=any($1::uuid[]) and organization_id=$2 and outlet_id=$3 returning *`,[[row.schedule_id,row.target_schedule_id],org,outlet])).rows;
          if(removed.length!==2)throw fail('swap_roster_mismatch',409);
          for(const item of removed){
            const movedToTarget=item.published_schedule_id===row.schedule_id, nextStaff=movedToTarget?row.target_staff_id:row.staff_id;
            await tx.query(`insert into sagaops.native_roster_assignments(id,roster_period_id,organization_id,outlet_id,staff_id,shift_template_id,business_date,scheduled_start_at,scheduled_end_at,shift_name_snapshot,grace_minutes_snapshot,role_snapshot,source,locked,notes,explanation,published_schedule_id,created_at,updated_at)
              values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,now())`,[item.id,item.roster_period_id,item.organization_id,item.outlet_id,nextStaff,item.shift_template_id,item.business_date,item.scheduled_start_at,item.scheduled_end_at,item.shift_name_snapshot,item.grace_minutes_snapshot,roleById.get(nextStaff),item.source,item.locked,item.notes,JSON.stringify(item.explanation??{}),item.published_schedule_id,item.created_at]);
          }
          for(const periodId of [...new Set(linked.map((item)=>item.roster_period_id))]){
            await bumpPeriod(tx,periodId);
            await audit(tx,periodId,'swap_approved',{requestId:id,scheduleIds:[row.schedule_id,row.target_schedule_id]});
          }
        }
      }
      return (await tx.query(`update sagaops.native_staff_requests set state=$3,reviewer_note=$4,reviewed_by=$5,reviewed_at=now(),updated_at=now()
        where id=$1 and organization_id=$2 returning id,state,reviewer_note`, [id,org,decision,reviewerNote,ids.ownerProfileId])).rows[0];
    });
  }
  return { listOwner,report,createAccount,resetPassword,setAccountState,updateProfile,setPayRate,assignSchedule,updateSchedule,
    createShiftTemplate,updateShiftTemplate,setShiftTemplateState,loadRoster,saveRosterAssignment,bulkAssignRoster,copyRosterPattern,
    saveRosterRules,generateRoster,publishRoster,setRosterStatus,saveAvailability,
    login,validateSession,changePassword,home,listSchedules,getSchedule,listRequests,getRequest,attendanceEligibility,attendanceOperationStatus,prepareAttendance,initializeAttendanceEvidence,uploadAttendanceEvidence,health,
    clockIn,clockOut,submitAttendanceCorrection,saveAttendancePolicy,reviewAttendance,openAttendanceEvidence,submitRequest,peerDecision,reviewRequest };
}

function staffDateRange(from,to,clock){
  const today=clock().toISOString().slice(0,10),fallbackFrom=`${today.slice(0,7)}-01`,fallbackTo=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10);
  const first=rosterDate(from??fallbackFrom),last=rosterDate(to??fallbackTo),days=Math.floor((Date.parse(`${last}T00:00:00Z`)-Date.parse(`${first}T00:00:00Z`))/86_400_000)+1;
  if(days<1||days>93)throw fail('schedule_range_invalid');
  return {from:first,to:last};
}
function staffScheduleView(row){
  const attendance=row.attendance_id?attendanceView({id:row.attendance_id,staff_id:row.staff_id,shift_schedule_id:row.id,check_in_at:row.check_in_at,check_out_at:row.check_out_at,status:row.attendance_status,late_minutes:row.late_minutes,early_leave_minutes:row.early_leave_minutes,worked_minutes:row.worked_minutes,note:row.attendance_note}):null;
  return {id:row.id,businessDate:dbDate(row.business_date),shiftName:row.shift_name,scheduledStartAt:dateIso(row.scheduled_start_at),scheduledEndAt:dateIso(row.scheduled_end_at),status:row.status,notes:row.notes??null,attendance};
}
function requestStateFilter(value){if(value==null||value==='')return null;const state=String(value);if(!['submitted','peer_accepted','approved','rejected','withdrawn'].includes(state))throw fail('request_status_invalid');return state;}
function requestCategoryFilter(value){if(value==null||value==='')return null;const category=String(value);if(category!=='attendance_correction'&&!categories.has(category))throw fail('request_category_invalid');return category;}
function staffRequestView(row,viewerStaffId){
  const correction=parseCorrectionReason(row.reason),createdAt=dateIso(row.created_at),updatedAt=dateIso(row.updated_at),reviewedAt=dateIso(row.reviewed_at),timeline=[{state:'submitted',at:createdAt,actor:'STAFF'}];
  if(row.category==='shift_swap'&&['peer_accepted','approved'].includes(row.state))timeline.push({state:'peer_accepted',at:row.state==='peer_accepted'?updatedAt:null,actor:'TARGET_STAFF',timeUnavailable:row.state==='approved'});
  if(['approved','rejected'].includes(row.state))timeline.push({state:row.state,at:reviewedAt??updatedAt,actor:reviewedAt?'OWNER':row.category==='shift_swap'?'TARGET_STAFF':'OWNER'});
  if(row.state==='withdrawn')timeline.push({state:'withdrawn',at:updatedAt,actor:'STAFF'});
  return {id:row.id,category:correction?'attendance_correction':row.category,status:row.state,relationship:row.staff_id===viewerStaffId?'REQUESTER':'TARGET',requesterStaffId:row.staff_id,targetStaffId:row.target_staff_id??null,scheduleId:row.schedule_id??null,targetScheduleId:row.target_schedule_id??null,reason:correction?.reason??row.reason,startAt:dateIso(row.starts_at),endAt:dateIso(row.ends_at),reviewerNote:row.reviewer_note??null,createdAt,updatedAt,reviewedAt,correction:correction?{attendanceId:correction.attendanceId,type:correction.type,proposedAt:dateIso(row.starts_at),evidence:correction.evidence}:null,attachments:correction?.evidence?[correction.evidence]:[],timeline,timelineCompleteness:row.category==='shift_swap'&&row.state==='approved'?'DERIVED':'COMPLETE'};
}

function coordinatesValue(value) {
  if (!value || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) ||
      Math.abs(value.latitude)>90 || Math.abs(value.longitude)>180) throw fail('coordinates_invalid');
  return `${value.latitude.toFixed(5)},${value.longitude.toFixed(5)}`;
}

function coordinatesRecord(value){
  if(!value||!Number.isFinite(Number(value.latitude))||!Number.isFinite(Number(value.longitude))||Math.abs(Number(value.latitude))>90||Math.abs(Number(value.longitude))>180||!Number.isFinite(Number(value.accuracyMeters))||Number(value.accuracyMeters)<=0||Number(value.accuracyMeters)>50000)throw fail('coordinates_invalid');
  return {latitude:Number(value.latitude),longitude:Number(value.longitude),accuracyMeters:Number(value.accuracyMeters)};
}
function coordinatesRecordOptional(value){return value==null?null:coordinatesRecord(value);}
function sessionBindingValue(value){if(value==null||value==='')return null;const text=String(value);if(!/^[0-9a-f]{64}$/i.test(text))throw fail('attendance_session_binding_invalid',401);return text.toLowerCase();}
function hashToken(value){return createHash('sha256').update(String(value)).digest('hex');}
function dateIso(value){if(value==null||value==='')return null;const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toISOString():null;}
function numberOrNull(value){return value==null?null:Number(value);}
function positiveInt(value,code){const result=Number(value);if(!Number.isSafeInteger(result)||result<1)throw fail(code);return result;}
function validateOvertimeRequest(eligible,startsAt,endsAt){
  if(!eligible)throw fail('overtime_attendance_required',409);
  const candidate=Number(eligible.overtime_candidate_minutes??0),approved=Number(eligible.approved_overtime_minutes??0);
  if(!Number.isSafeInteger(candidate)||candidate<1)throw fail('overtime_candidate_required',409);
  if(approved>0)throw fail('overtime_already_approved',409);
  const start=Date.parse(startsAt),end=Date.parse(endsAt),scheduledEnd=Date.parse(eligible.scheduled_end_at),checkOut=Date.parse(eligible.check_out_at),requestedMinutes=Math.round((end-start)/60_000);
  const boundaryToleranceMs=60_000;
  if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(scheduledEnd)||!Number.isFinite(checkOut)||start<scheduledEnd-boundaryToleranceMs||end>checkOut+boundaryToleranceMs||requestedMinutes<1||requestedMinutes>candidate)throw fail('overtime_range_invalid',409);
  return requestedMinutes;
}
function boundedInt(value,min,max,code){const result=Number(value);if(!Number.isInteger(result)||result<min||result>max)throw fail(code);return result;}
function attendanceView(row){
  if(!row)return null;
  const envelope=parseAttendanceEnvelope(row.note);
  return {id:row.id,staffId:row.staff_id,staff_id:row.staff_id,scheduleId:row.shift_schedule_id,shift_schedule_id:row.shift_schedule_id,
    checkInAt:dateIso(row.check_in_at),check_in_at:row.check_in_at,checkOutAt:dateIso(row.check_out_at),check_out_at:row.check_out_at,status:row.status,
    lateMinutes:row.late_minutes,late_minutes:row.late_minutes,earlyLeaveMinutes:row.early_leave_minutes,early_leave_minutes:row.early_leave_minutes,
    workedMinutes:row.worked_minutes,worked_minutes:row.worked_minutes,overtimeCandidateMinutes:row.overtime_candidate_minutes,overtime_candidate_minutes:row.overtime_candidate_minutes,
    reviewStatus:row.review_status??envelope?.reviewStatus,review_status:row.review_status??envelope?.reviewStatus,
    reviewReason:row.review_reason??envelope?.reviewReason,review_reason:row.review_reason??envelope?.reviewReason,checkInEvidence:envelope?.checkInEvidence??null,checkOutEvidence:envelope?.checkOutEvidence??null};
}
function correctionView(row){return {id:row.id,attendanceId:row.attendance_log_id,scheduleId:row.shift_schedule_id,staffId:row.staff_id,type:row.correction_type,proposedAt:dateIso(row.proposed_at),reason:row.reason,status:row.status,reviewNote:row.review_note,createdAt:dateIso(row.created_at)};}
function geofenceResult(coordinates,policy){
  if(coordinates.accuracyMeters>policy.maxAccuracyMeters)return {status:'POOR_ACCURACY',distanceMeters:null};
  if(policy.outletLatitude==null||policy.outletLongitude==null)return {status:'NOT_CONFIGURED',distanceMeters:null};
  const distanceMeters=haversineMeters(coordinates.latitude,coordinates.longitude,policy.outletLatitude,policy.outletLongitude);
  return {status:distanceMeters<=policy.geofenceRadiusMeters?'INSIDE':'OUTSIDE',distanceMeters:Math.round(distanceMeters*100)/100};
}
function haversineMeters(lat1,lng1,lat2,lng2){const radius=6371000,toRad=(value)=>value*Math.PI/180,dLat=toRad(lat2-lat1),dLng=toRad(lng2-lng1),a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;return radius*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function geofenceReviewReason(status){return {OUTSIDE:'attendance_outside_geofence',POOR_ACCURACY:'attendance_gps_accuracy_low',NOT_CONFIGURED:'attendance_outlet_location_not_configured'}[status]??null;}
function attendanceEnvelope(value={}){return {schema:'SAGAPOS_ATTENDANCE_V1',checkInEvidence:value.checkInEvidence??null,checkOutEvidence:value.checkOutEvidence??null,checkInIdempotencyKey:value.checkInIdempotencyKey??null,checkOutIdempotencyKey:value.checkOutIdempotencyKey??null,checkInSessionBindingHash:value.checkInSessionBindingHash??null,checkOutSessionBindingHash:value.checkOutSessionBindingHash??null,policyVersion:value.policyVersion??null,reviewStatus:value.reviewStatus??'NOT_REQUIRED',reviewReason:value.reviewReason??null,reviewedBy:value.reviewedBy??null,reviewedAt:value.reviewedAt??null,...value};}
function parseAttendanceEnvelope(value){try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed?.schema==='SAGAPOS_ATTENDANCE_V1'?parsed:null;}catch{return null;}}
function evidenceView(row){return row?{evidenceId:row.id,contentType:row.content_type,byteSize:row.byte_size,checksum:row.checksum,latitude:numberOrNull(row.latitude),longitude:numberOrNull(row.longitude),accuracyMeters:numberOrNull(row.accuracy_meters),distanceMeters:numberOrNull(row.distance_meters),geofenceStatus:row.geofence_status,capturedAt:dateIso(row.captured_at),riskFlags:[...(row.risk_flags??[])],contentUrl:`/api/operator/native-staff/attendance-evidence/${row.id}/content`}:null;}
function attendanceLocationProof({input,evidence,policy,clock}){
  if(policy.enforcementState!=='ACTIVE'||!policy.gpsRequired)return {view:null,blocked:false,reason:null,reviewReason:null};
  let coordinates,geo,capturedAt;
  if(evidence){coordinates=coordinatesRecord({latitude:evidence.latitude,longitude:evidence.longitude,accuracyMeters:evidence.accuracy_meters});geo={status:evidence.geofence_status,distanceMeters:numberOrNull(evidence.distance_meters)};capturedAt=dateIso(evidence.captured_at);}
  else{coordinates=coordinatesRecord(input.coordinates);capturedAt=iso(input.clientCapturedAt??clock().toISOString());if(Math.abs(Date.parse(capturedAt)-clock().getTime())>10*60_000)throw fail('attendance_location_capture_stale',409);geo=geofenceResult(coordinates,policy);}
  const blocked=policy.geofenceAction==='BLOCK'&&geo.status!=='INSIDE',reason=geo.status==='OUTSIDE'?'attendance_outside_geofence':geo.status==='POOR_ACCURACY'?'attendance_gps_accuracy_low':geo.status==='NOT_CONFIGURED'?'attendance_outlet_location_not_configured':null;
  return {blocked,reason,reviewReason:geo.status==='INSIDE'?null:geofenceReviewReason(geo.status),view:evidence?null:{evidenceId:null,contentType:null,byteSize:null,checksum:null,latitude:coordinates.latitude,longitude:coordinates.longitude,accuracyMeters:coordinates.accuracyMeters,distanceMeters:geo.distanceMeters,geofenceStatus:geo.status,capturedAt,riskFlags:[],contentUrl:null}};
}
function correctionReason({type,reason,attendanceId,evidence}){const e=evidence?{id:evidence.evidenceId,ct:evidence.contentType,lat:evidence.latitude,lng:evidence.longitude,acc:evidence.accuracyMeters,dist:evidence.distanceMeters,geo:evidence.geofenceStatus,at:evidence.capturedAt}:null,text=`ATTENDANCE_CORRECTION_V1|${JSON.stringify({t:type,r:reason,a:attendanceId,e})}`;if(text.length>500)throw fail('attendance_correction_invalid');return text;}
function parseCorrectionReason(value){const text=String(value??''),prefix='ATTENDANCE_CORRECTION_V1|';if(!text.startsWith(prefix))return null;try{const parsed=JSON.parse(text.slice(prefix.length)),type=parsed.t??parsed.type,reason=parsed.r??parsed.reason,attendanceId=parsed.a??parsed.attendanceId,raw=parsed.e??parsed.evidence;if(!['MISSED_CLOCK_IN','MISSED_CLOCK_OUT'].includes(type)||typeof reason!=='string')return null;const evidence=raw?{evidenceId:raw.id,contentType:raw.ct,latitude:raw.lat,longitude:raw.lng,accuracyMeters:raw.acc,distanceMeters:raw.dist,geofenceStatus:raw.geo,capturedAt:raw.at,contentUrl:`/api/operator/native-staff/attendance-evidence/${raw.id}/content`}:null;return {type,reason,attendanceId,evidence};}catch{return null;}}
