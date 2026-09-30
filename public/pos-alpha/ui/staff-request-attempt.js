// Browser-side attempt persistence and recovery. The injected adapter owns API mapping.
const ATTEMPT_PREFIX='sagapos-staff-request-attempt-v1:',DRAFT_PREFIX='sagapos-staff-request-draft-v2:';
export const requestRejectionCodes=new Set(['request_invalid','request_range_invalid','overtime_schedule_required','swap_target_invalid','schedule_not_found','overtime_request_exists','staff_not_found','overtime_attendance_required','overtime_candidate_required','overtime_already_approved','overtime_range_invalid']);
export function clearRequestDrafts(sessionStorage,keepActorId=null){
  for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith(DRAFT_PREFIX)&&key!==`${DRAFT_PREFIX}${keepActorId}`)sessionStorage.removeItem(key);}
}
export function sanitizeRequestAttempts(storage){
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i);if(!key?.startsWith(ATTEMPT_PREFIX))continue;
    let saved;try{saved=JSON.parse(storage.getItem(key));}catch{saved={};}
    const metadata={version:2,actorId:key.slice(ATTEMPT_PREFIX.length),idempotencyKey:typeof saved?.idempotencyKey==='string'?saved.idempotencyKey:null,createdAt:typeof saved?.createdAt==='string'?saved.createdAt:new Date().toISOString()};
    // Rewrite every legacy record, including other actors, using an explicit metadata whitelist.
    if(JSON.stringify(saved)!==JSON.stringify(metadata))storage.setItem(key,JSON.stringify(metadata));
  }
}
export function createRequestAttempt({actorId,storage,sessionStorage,submit,lookup,onChange=()=>{},newKey=()=>crypto.randomUUID()}) {
  if(!actorId)throw new Error('An authenticated actor is required.');
  const storageKey=`${ATTEMPT_PREFIX}${actorId}`,draftKey=`${DRAFT_PREFIX}${actorId}`;
  if(!sessionStorage){const rows=new Map();sessionStorage={getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};}
  let attempt=null,state='IDLE',busy=false,lastError=null;
  const snapshot=()=>({state,busy,attempt:attempt?structuredClone(attempt):null,error:lastError});
  const emit=()=>onChange(snapshot());
  function persist(){
    const {input,...metadata}=attempt;
    storage.setItem(storageKey,JSON.stringify(metadata));
    sessionStorage.setItem(draftKey,JSON.stringify({idempotencyKey:attempt.idempotencyKey,input}));
  }
  function accepted(receipt){
    state='COMMITTED';lastError=null;
    try{storage.removeItem(storageKey);}catch{ /* A retained key is reconciled on reload, never blindly resent. */ }
    try{sessionStorage.removeItem(draftKey);}catch{}
    attempt={...attempt,receipt};emit();return snapshot();
  }
  function restore(){
    try{
      sanitizeRequestAttempts(storage);
      const raw=storage.getItem(storageKey);
      if(!raw){attempt=null;state='IDLE';emit();return snapshot();}
      const saved=JSON.parse(raw);
      if(saved.version!==2||saved.actorId!==actorId||typeof saved.idempotencyKey!=='string')throw new Error('Stored request attempt is invalid.');
      let draft;try{draft=JSON.parse(sessionStorage.getItem(draftKey)||'null');}catch{draft=null;}
      attempt={...saved,input:draft?.idempotencyKey===saved.idempotencyKey&&draft.input&&typeof draft.input==='object'?draft.input:null};state='UNCERTAIN';lastError=null;
    }catch(error){state='BLOCKED';lastError=error;}
    emit();return snapshot();
  }
  async function send(){
    state='SENDING';emit();
    try{
      const receipt=await submit({...structuredClone(attempt.input),idempotencyKey:attempt.idempotencyKey});
      if(!receipt?.id)throw new Error('The request response did not confirm a receipt.');
      return accepted(receipt);
    }
    catch(error){
      lastError=error;
      if(error.definitiveRejection===true){
        try{storage.removeItem(storageKey);sessionStorage.removeItem(draftKey);attempt=null;state='REJECTED';}catch{state='UNCERTAIN';}
      }else state='UNCERTAIN';
      emit();return snapshot();
    }
  }
  async function withLock(task){
    if(busy)return snapshot();busy=true;emit();
    try{await task();}finally{busy=false;emit();}
    return snapshot();
  }
  async function check(){
    if(!attempt)return snapshot();state='CHECKING';emit();
    try{
      const result=await lookup(attempt.idempotencyKey);
      if(result.status==='COMMITTED'&&result.request?.id)return accepted(result.request);
      state=result.status==='NOT_FOUND'?(attempt.input?'RETRY_READY':'DRAFT_MISSING'):'UNCERTAIN';lastError=null;
    }catch(error){state='UNCERTAIN';lastError=error;}
    emit();return snapshot();
  }
  async function start(input){
    return withLock(async()=>{
      if(!['IDLE','COMMITTED','REJECTED'].includes(state))return snapshot();
      // Check another tab's pending attempt before replacing the actor-scoped identity.
      if(state==='COMMITTED'){
        try{
          const raw=storage.getItem(storageKey);
          if(raw&&JSON.parse(raw).idempotencyKey!==attempt.idempotencyKey){restore();return snapshot();}
        }catch(error){state='BLOCKED';lastError=error;emit();return snapshot();}
      }else{
        restore();if(state!=='IDLE')return snapshot();
      }
      attempt={version:2,actorId,idempotencyKey:newKey(),createdAt:new Date().toISOString(),input:structuredClone(input)};
      try{persist();}catch(error){state='BLOCKED';lastError=error;emit();return snapshot();}
      return send();
    });
  }
  async function retry(){
    return withLock(async()=>{
      if(!attempt||!attempt.input||!['UNCERTAIN','RETRY_READY'].includes(state))return snapshot();
      // Always query again: a prior NOT_FOUND may have raced with a delayed commit.
      await check();if(state!=='RETRY_READY')return snapshot();return send();
    });
  }
  function forgetDraft(){try{sessionStorage.removeItem(draftKey);}finally{if(attempt)attempt.input=null;}}
  return {restore,start,retry,check:()=>withLock(check),snapshot,forgetDraft};
}
