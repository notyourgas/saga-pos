import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SagaOpsLocalPostgresRuntime} from '../src/db/local-postgres-runtime.mjs';
import {SagaPosPostgresRepository,SAGA_POS_DURABLE_PILOT_IDS as ids} from '../src/db/saga-pos-postgres-repository.mjs';
import {createNativeStaffService} from '../src/services/native-staff.mjs';

test('native roster publication and employment invariants',async t=>{
 const runtime=new SagaOpsLocalPostgresRuntime();await runtime.start();t.after(()=>runtime.close());const db=runtime.db;
 for(const name of ['native-staff-schema.sql','native-staff-roster-v2.sql','native-staff-report-v3.sql','native-staff-payroll-v4.sql','native-staff-attendance-hardening-v4.sql'])await db.exec(await readFile(new URL('../ops/production/'+name,import.meta.url),'utf8'));
 await new SagaPosPostgresRepository({db}).seedPilotContext();
 const service=createNativeStaffService({db,ids});
 const employee=await service.createAccount({name:'Synthetic Worker',role:'cashier'}),staffId=employee.account.id;
 const templateInput={name:'Morning',code:'MORN',startTime:'08:00',endTime:'16:00',roleRequirements:[{role:'cashier',count:1}]};
 const template=await service.createShiftTemplate(templateInput);
 const count=async table=>(await db.query(`select count(*)::integer as n from sagaops.${table}`)).rows[0].n;
 const draft=await service.generateRoster({periodStart:'2026-10-05',periodEnd:'2026-10-05'}),periodId=draft.period.id;
 let review,published;
 await t.test('draft and preference permit explicit concurrent idempotent publication',async()=>{
  assert.equal(draft.period.status,'draft');assert.equal(draft.assignments.length,1);assert.equal(await count('shift_schedules'),0);
  await assert.rejects(service.publishRoster({periodId}),{code:'roster_review_required'});
  await service.saveAvailability({staffId,startAt:'2026-10-05T01:00:00Z',endAt:'2026-10-05T09:00:00Z',kind:'preferred',templateId:template.id});
  review=await service.setRosterStatus({periodId,status:'review'});
  await assert.rejects(service.publishRoster({periodId,expectedVersion:review.version-1}),{code:'roster_version_conflict'});
  const results=await Promise.all([service.publishRoster({periodId,expectedVersion:review.version}),service.publishRoster({periodId,expectedVersion:review.version})]);
  assert.deepEqual(results[0],results[1]);published=results[0];assert.equal(published.publishedSchedules,1);
 });
 await t.test('unchanged replay preserves original result; stale and changed revisions conflict',async()=>{
  const before=(await db.query('select * from sagaops.shift_schedules order by id')).rows;
  for(const input of [{periodId},{periodId,expectedVersion:review.version},{periodId,expectedVersion:published.period.version},{periodStart:'2026-10-05',periodEnd:'2026-10-05'}])assert.deepEqual(await service.publishRoster(input),published);
  await assert.rejects(service.publishRoster({periodId,expectedVersion:review.version-1}),{code:'roster_version_conflict'});
  await assert.rejects(service.publishRoster({periodId,expectedVersion:published.period.version+1}),{code:'roster_version_conflict'});
  await assert.rejects(service.publishRoster({periodId,rules:{maxWeeklyHours:8}}),{code:'roster_period_locked'});
  assert.deepEqual((await db.query('select * from sagaops.shift_schedules order by id')).rows,before);
  assert.equal((await db.query("select count(*)::integer as n from sagaops.native_roster_audit_log where roster_period_id=$1 and action='published'",[periodId])).rows[0].n,1);
  await db.query('update sagaops.native_roster_periods set version=version+1 where id=$1',[periodId]);
  await assert.rejects(service.publishRoster({periodId}),{code:'roster_version_conflict'});
 });
 await t.test('published snapshots stay immutable and locked',async()=>{
  const before=(await db.query('select * from sagaops.shift_schedules order by id')).rows;
  await service.updateShiftTemplate({...templateInput,templateId:template.id,name:'Updated',startTime:'09:00',endTime:'17:00'});
  assert.deepEqual((await db.query('select * from sagaops.shift_schedules order by id')).rows,before);
  await assert.rejects(service.setRosterStatus({periodId,status:'draft'}),{code:'roster_period_locked'});
  await assert.rejects(service.saveRosterAssignment({periodId,staffId,templateId:template.id,businessDate:'2026-10-05'}),{code:'roster_period_locked'});
 });
 await t.test('login suspension and missing credentials do not change employment eligibility',async()=>{
  await service.setAccountState(staffId,'suspended');
  await assert.rejects(service.login({employeeCode:employee.account.employeeCode,password:employee.temporaryPassword}),{code:'identity_invalid'});
  const next=await service.generateRoster({periodStart:'2026-10-07',periodEnd:'2026-10-07'});assert.equal(next.assignments.length,1);
  await service.saveRosterAssignment({periodId:next.period.id,staffId,templateId:template.id,businessDate:'2026-10-07'});
  await service.setRosterStatus({periodId:next.period.id,status:'review'});assert.equal((await service.publishRoster({periodId:next.period.id})).publishedSchedules,1);
  const active=await service.generateRoster({periodStart:'2026-10-09',periodEnd:'2026-10-09'});
  await db.query("update sagaops.staff_profiles set status='inactive' where id=$1",[staffId]);
  assert.equal((await service.generateRoster({periodStart:'2026-10-11',periodEnd:'2026-10-11'})).assignments.length,0);
  await service.setRosterStatus({periodId:active.period.id,status:'review'});
  await assert.rejects(service.publishRoster({periodId:active.period.id}),e=>e.code==='roster_publish_conflicts'&&e.details.some(d=>d.code==='assignment_no_longer_eligible'));
  await db.query("update sagaops.staff_profiles set status='active' where id=$1",[staffId]);await db.query('delete from sagaops.native_staff_credentials where staff_id=$1',[staffId]);
  assert.equal((await service.generateRoster({periodStart:'2026-10-12',periodEnd:'2026-10-12'})).assignments.length,1);
 });
 await t.test('hard unavailability is checked again before publish',async()=>{
  const next=await service.generateRoster({periodStart:'2026-10-15',periodEnd:'2026-10-15'});
  await service.saveAvailability({staffId,startAt:'2026-10-15T00:00:00Z',endAt:'2026-10-15T12:00:00Z',kind:'unavailable'});await service.setRosterStatus({periodId:next.period.id,status:'review'});
  const before=await count('shift_schedules');await assert.rejects(service.publishRoster({periodId:next.period.id}),e=>e.code==='roster_publish_conflicts'&&e.details.some(d=>d.codes?.includes('unavailable')));assert.equal(await count('shift_schedules'),before);
 });
 await t.test('foreign scope cannot load or publish local period',async()=>{
  for(const context of [{...ids,outletId:randomUUID()},{...ids,organizationId:randomUUID(),outletId:randomUUID()}]){
   const foreign=createNativeStaffService({db,ids:context});
   await assert.rejects(foreign.loadRoster({periodId}),{code:'roster_period_not_found'});await assert.rejects(foreign.publishRoster({periodId}),{code:'roster_period_not_found'});
  }
 });
 await t.test('weekly hour limits follow Jakarta business date at Monday midnight',async()=>{
  await service.setShiftTemplateState(template.id,'inactive');const midnight=await service.createShiftTemplate({name:'Midnight',code:'MID',startTime:'00:00',endTime:'06:00',roleRequirements:[]});
  for(const date of ['2026-11-01','2026-11-02']){
   const next=await service.saveRosterAssignment({periodStart:date,periodEnd:date,rules:{maxWeeklyHours:8},staffId,templateId:midnight.id,businessDate:date});await service.setRosterStatus({periodId:next.period.id,status:'review'});assert.equal((await service.publishRoster({periodId:next.period.id})).publishedSchedules,1);
  }
  await assert.rejects(service.saveRosterAssignment({periodStart:'2026-11-03',periodEnd:'2026-11-03',rules:{maxWeeklyHours:8},staffId,templateId:midnight.id,businessDate:'2026-11-03'}),{code:'roster_weekly_hours'});
  const day=await service.createShiftTemplate({name:'Day',code:'DAY',startTime:'09:00',endTime:'15:00',roleRequirements:[]});
  const next=await service.saveRosterAssignment({periodStart:'2026-11-11',periodEnd:'2026-11-11',rules:{maxWeeklyHours:8},staffId,templateId:day.id,businessDate:'2026-11-11'});await service.setRosterStatus({periodId:next.period.id,status:'review'});assert.equal((await service.publishRoster({periodId:next.period.id})).publishedSchedules,1);
  await assert.rejects(service.saveRosterAssignment({periodStart:'2026-11-12',periodEnd:'2026-11-12',rules:{maxWeeklyHours:8},staffId,templateId:day.id,businessDate:'2026-11-12'}),{code:'roster_weekly_hours'});
 });
});
