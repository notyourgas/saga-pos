import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestAttempt,clearRequestDrafts,sanitizeRequestAttempts,requestRejectionCodes } from '../public/pos-alpha/ui/staff-request-attempt.js';

const storage=()=>{const rows=new Map();return {get length(){return rows.size;},key:index=>[...rows.keys()][index],getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};};
const input={category:'permission',reason:'Urusan keluarga',startAt:'2026-10-02T05:00:00Z',endAt:'2026-10-02T06:00:00Z'};

test('commit plus lost response is reconciled across reload without another POST; a genuine new request uses a new key',async()=>{
  const disk=storage(),records=new Map(),events=[];let lost=true,key=0;
  const adapter={actorId:'ayu',storage:disk,sessionStorage:storage(),newKey:()=>`attempt-${++key}`,submit:async payload=>{
    events.push(['POST',payload.idempotencyKey]);
    if(!records.has(payload.idempotencyKey))records.set(payload.idempotencyKey,{id:`record-${records.size+1}`});
    if(lost){lost=false;throw new Error('Lost response');}return records.get(payload.idempotencyKey);
  },lookup:async attemptKey=>{events.push(['GET',attemptKey]);return {status:records.has(attemptKey)?'COMMITTED':'NOT_FOUND',request:records.get(attemptKey)||null};}};
  const first=createRequestAttempt(adapter);await first.start(input);
  assert.equal(first.snapshot().state,'UNCERTAIN');
  await first.start({...input,reason:'Changed after ambiguous submission'});
  assert.equal(records.size,1);assert.equal(events.length,1);
  const restored=createRequestAttempt(adapter);restored.restore();
  assert.deepEqual(restored.snapshot().attempt.input,input);
  await restored.retry();assert.equal(restored.snapshot().state,'COMMITTED');
  assert.deepEqual(events,[['POST','attempt-1'],['GET','attempt-1']]);
  await restored.start(input);assert.equal(records.size,2);assert.equal(restored.snapshot().attempt.idempotencyKey,'attempt-2');
});

test('absent lookup replays the frozen original identity and payload, with a fresh lookup on every retry',async()=>{
  const events=[];let calls=0;
  const controller=createRequestAttempt({actorId:'ayu',storage:storage(),newKey:()=> 'original-key',submit:async payload=>{events.push(['POST',payload]);if(++calls===1)throw new Error('Before commit');return {id:'one-record'};},lookup:async key=>{events.push(['GET',key]);return {status:'NOT_FOUND',request:null};}});
  const draft=structuredClone(input);await controller.start(draft);draft.reason='Changed';
  await controller.check();await controller.retry();
  assert.deepEqual(events.map(entry=>entry[0]),['POST','GET','GET','POST']);
  assert.deepEqual(events[0][1],events[3][1]);assert.equal(controller.snapshot().state,'COMMITTED');
});

test('pending or unavailable lookup and repeated clicks never perform a blind POST',async()=>{
  let posts=0,release;const disk=storage();
  const controller=createRequestAttempt({actorId:'ayu',storage:disk,submit:async()=>{posts++;await new Promise(resolve=>release=resolve);throw new Error('Ambiguous');},lookup:async()=>({status:'PENDING'})});
  const waiting=controller.start(input);await controller.start(input);release();await waiting;
  await controller.retry();assert.equal(posts,1);assert.equal(controller.snapshot().state,'UNCERTAIN');
  const reloaded=createRequestAttempt({actorId:'ayu',storage:disk,submit:async()=>posts++,lookup:async()=>{throw new Error('Offline');}});
  reloaded.restore();await reloaded.retry();assert.equal(posts,1);assert.equal(reloaded.snapshot().state,'UNCERTAIN');
});

test('storage failure and corrupt state fail closed; another actor cannot access or replay the draft',async()=>{
  let posts=0;const failed=createRequestAttempt({actorId:'ayu',storage:{getItem:()=>null,setItem:()=>{throw new Error('Unavailable');}},submit:async()=>posts++,lookup:async()=>({status:'NOT_FOUND'})});
  await failed.start(input);assert.equal(failed.snapshot().state,'BLOCKED');assert.equal(posts,0);
  const disk=storage();disk.setItem('sagapos-staff-request-attempt-v1:ayu','invalid');
  const corrupt=createRequestAttempt({actorId:'ayu',storage:disk,submit:async()=>posts++});corrupt.restore();await corrupt.start(input);assert.equal(corrupt.snapshot().state,'BLOCKED');assert.equal(posts,0);
  const other=createRequestAttempt({actorId:'bima',storage:disk,submit:async()=>posts++});other.restore();assert.equal(other.snapshot().attempt,null);assert.equal(other.snapshot().state,'IDLE');
});

test('an already resolved tab cannot overwrite another tab unresolved attempt',async()=>{
  const disk=storage();let key=0,posts=0,fail=false;
  const adapter={actorId:'ayu',storage:disk,newKey:()=>`key-${++key}`,submit:async()=>{posts++;if(fail)throw new Error('Lost');return {id:'record'};}};
  const first=createRequestAttempt(adapter);await first.start(input);
  fail=true;const second=createRequestAttempt(adapter);await second.start(input);
  await first.start(input);assert.equal(posts,2);assert.equal(first.snapshot().attempt.idempotencyKey,'key-2');assert.equal(first.snapshot().state,'UNCERTAIN');
});

test('durable bytes are metadata-only; logout removes session payload but preserves unresolved identity',async()=>{
  const disk=storage(),drafts=storage();let posts=0;
  const adapter={actorId:'ayu',storage:disk,sessionStorage:drafts,newKey:()=> 'retained-key',submit:async()=>{posts++;throw new Error('Lost');},lookup:async()=>({status:'NOT_FOUND'})};
  const first=createRequestAttempt(adapter);await first.start(input);
  const metadata=JSON.parse(disk.getItem(disk.key(0)));
  assert.deepEqual(Object.keys(metadata).sort(),['actorId','createdAt','idempotencyKey','version']);assert.ok(metadata.createdAt);
  assert.doesNotMatch(JSON.stringify(metadata),/Urusan keluarga|permission|startAt|endAt|scheduleId|targetStaffId/);
  clearRequestDrafts(drafts);first.forgetDraft();assert.equal(drafts.length,0);
  const restored=createRequestAttempt(adapter);restored.restore();await restored.check();assert.equal(restored.snapshot().state,'DRAFT_MISSING');
  await restored.start(input);await restored.retry();assert.equal(posts,1);assert.equal(restored.snapshot().attempt.idempotencyKey,'retained-key');
});

test('legacy sensitive payloads for every actor are scrubbed while original operation keys remain reconcilable',async()=>{
  const disk=storage();
  for(const actorId of ['ayu','bima'])disk.setItem(`sagapos-staff-request-attempt-v1:${actorId}`,JSON.stringify({version:1,actorId,idempotencyKey:`old-${actorId}`,input:{...input,targetStaffId:'colleague',targetScheduleId:'schedule'}}));
  sanitizeRequestAttempts(disk);
  for(let i=0;i<disk.length;i++){const row=JSON.parse(disk.getItem(disk.key(i)));assert.equal(row.version,2);assert.equal(row.input,undefined);assert.equal(row.idempotencyKey,`old-${row.actorId}`);}
  const restored=createRequestAttempt({actorId:'ayu',storage:disk,lookup:async key=>({status:'COMMITTED',request:{id:key}})});restored.restore();assert.equal(restored.snapshot().attempt.input,null);await restored.check();assert.equal(restored.snapshot().state,'COMMITTED');
});

for(const code of ['overtime_attendance_required','overtime_candidate_required','overtime_already_approved','overtime_range_invalid']){
  test(`${code} releases rejected frozen input for correction and gives the corrected intent a fresh key`,async()=>{
    const disk=storage(),drafts=storage();let key=0,reject=true;const sent=[];
    const controller=createRequestAttempt({actorId:'ayu',storage:disk,sessionStorage:drafts,newKey:()=>`key-${++key}`,submit:async payload=>{sent.push(payload);if(reject)throw Object.assign(new Error(code),{code,definitiveRejection:requestRejectionCodes.has(code)});return {id:'corrected'};}});
    await controller.start(input);assert.equal(controller.snapshot().state,'REJECTED');assert.equal(disk.length,0);assert.equal(drafts.length,0);
    reject=false;await controller.start({...input,reason:'Corrected request details'});assert.equal(controller.snapshot().state,'COMMITTED');assert.notEqual(sent[0].idempotencyKey,sent[1].idempotencyKey);
  });
}
