import { FilesystemReceiptEvidenceStorage } from './receipt-evidence-storage.mjs';
import { lstat,open,readFile,readdir,rename,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const uuid = (value) => {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) throw Object.assign(new Error('attendance_evidence_scope_invalid'),{code:'attendance_evidence_scope_invalid',statusCode:422});
  return text;
};

export class FilesystemAttendanceEvidenceStorage extends FilesystemReceiptEvidenceStorage {
  health(){
    const state=super.health();
    return {...state,writable:state.ready,freeBytes:state.capacity?.availableBytes??0};
  }
  async cleanupExpired({retentionDays=30,now=new Date()}={}){
    await this.initialize();const days=Number(retentionDays);if(!Number.isInteger(days)||days<7||days>90)throw failure('attendance_retention_invalid');const cutoff=now.getTime()-days*86_400_000;let scanned=0,deleted=0;
    const walk=async(directory)=>{for(const entry of await readdir(directory,{withFileTypes:true})){if(++scanned>100_000)throw failure('attendance_cleanup_limit_exceeded');const target=join(directory,entry.name);if(entry.isSymbolicLink())throw failure('attendance_evidence_storage_path_unsafe');if(entry.isDirectory()){await walk(target);continue;}if(!entry.isFile()||entry.name==='policy.json'||entry.name.startsWith('.'))continue;if(!/\.(?:jpe?g|png|webp)$/i.test(entry.name))continue;const info=await lstat(target);if(info.mtimeMs<cutoff){await rm(target);deleted++;}}};await walk(this.root);return {scanned,deleted,retentionDays:days};
  }
  async loadPolicy(){
    await this.initialize();const target=join(this.root,'policy.json'),stat=await lstat(target).catch((error)=>error?.code==='ENOENT'?null:Promise.reject(error));
    if(!stat)return null;if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16_384)throw failure('attendance_policy_file_unsafe');
    let parsed;try{parsed=JSON.parse(await readFile(target,'utf8'));}catch{throw failure('attendance_policy_file_invalid');}
    return validPolicy(parsed);
  }
  async savePolicy(value){
    await this.initialize();const policy=validPolicy(value),target=join(this.root,'policy.json'),temporary=join(this.root,`.policy-${randomUUID()}.tmp`),body=Buffer.from(`${JSON.stringify(policy)}\n`);
    const existing=await lstat(target).catch((error)=>error?.code==='ENOENT'?null:Promise.reject(error));if(existing?.isSymbolicLink()||existing&&!existing.isFile())throw failure('attendance_policy_file_unsafe');
    const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(body);await handle.sync();await handle.close();await rename(temporary,target);return policy;}catch(error){try{await handle.close();}catch{}await rm(temporary,{force:true});throw error;}
  }
}

export function attendanceEvidenceObjectKey({ organizationId,outletId,staffId,evidenceId,extension }={}) {
  const ext=String(extension??'').toLowerCase().replace(/^\./,'');
  if(!['jpg','jpeg','png','webp'].includes(ext))throw Object.assign(new Error('attendance_evidence_extension_invalid'),{code:'attendance_evidence_extension_invalid',statusCode:422});
  return `attendance/${uuid(organizationId)}/${uuid(outletId)}/${uuid(staffId)}/${uuid(evidenceId)}.${ext==='jpeg'?'jpg':ext}`;
}

function validPolicy(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw failure('attendance_policy_file_invalid');
  const integer=(key,min,max)=>{const number=Number(value[key]);if(!Number.isInteger(number)||number<min||number>max)throw failure('attendance_policy_file_invalid');return number;};
  const lat=value.outletLatitude==null?null:Number(value.outletLatitude),lng=value.outletLongitude==null?null:Number(value.outletLongitude);
  if((lat==null)!==(lng==null)||(lat!=null&&(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180)))throw failure('attendance_policy_file_invalid');
  if(!['REVIEW','BLOCK'].includes(value.geofenceAction)||!['ACTIVE','DISABLED'].includes(value.enforcementState))throw failure('attendance_policy_file_invalid');
  const version=value.version==null?1:integer('version',1,2_147_483_647),updatedDate=value.updatedAt==null?null:new Date(value.updatedAt);if(updatedDate&&!Number.isFinite(updatedDate.getTime()))throw failure('attendance_policy_file_invalid');const updatedAt=updatedDate?.toISOString()??null,updatedBy=value.updatedBy==null?null:uuid(value.updatedBy);
  return {timezone:'Asia/Jakarta',earlyOpenMinutes:integer('earlyOpenMinutes',0,120),lateCheckInMinutes:value.lateCheckInMinutes==null?60:integer('lateCheckInMinutes',0,180),postCloseMinutes:integer('postCloseMinutes',0,180),minimumWorkedMinutes:value.minimumWorkedMinutes==null?30:integer('minimumWorkedMinutes',0,240),earlyLeaveReviewMinutes:value.earlyLeaveReviewMinutes==null?30:integer('earlyLeaveReviewMinutes',0,240),anytimeTestMode:value.anytimeTestMode==null?true:value.anytimeTestMode===true,gpsRequired:value.gpsRequired!==false,selfieRequired:value.selfieRequired!==false,maxAccuracyMeters:integer('maxAccuracyMeters',10,500),geofenceRadiusMeters:integer('geofenceRadiusMeters',10,1000),outletLatitude:lat,outletLongitude:lng,geofenceAction:value.geofenceAction,enforcementState:value.enforcementState,version,updatedAt,updatedBy,evidenceRetentionDays:value.evidenceRetentionDays==null?30:integer('evidenceRetentionDays',7,90),loaded:true};
}

function failure(code){return Object.assign(new Error(code),{code,statusCode:500});}
