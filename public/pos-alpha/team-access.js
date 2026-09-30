import { workspaceForms } from './team-workspace-forms.js';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actionLabels = {view:'Lihat',write:'Buat / Ubah',approve:'Konfirmasi / Setujui',archive:'Batalkan / Arsipkan',export:'Ekspor'};
let actor, csrf = '', model, config, selectedRole = null, workspaceData, currentFeature;
async function request(path, body) {
  const response = await fetch(path,{credentials:'same-origin',method:body?'POST':'GET',headers:body?{'content-type':'application/json','x-csrf-token':csrf}:{},body:body?JSON.stringify(body):undefined});
  const data = await response.json();
  if(!response.ok) throw Object.assign(new Error(({team_revision_conflict:'Data berubah di sesi lain. Muat ulang dan periksa kembali.',owner_reauthentication_required:'Password Owner diperlukan sebelum menyimpan.',permission_denied:'Role Anda tidak memiliki izin tindakan ini.',last_owner_protected:'Minimal satu Owner aktif harus dipertahankan.',identity_invalid:'Akun atau password tidak sesuai.',permission_view_required:'Tindakan memerlukan izin Lihat.',feature_unavailable:'Fitur belum tersedia untuk outlet ini.'})[data.error?.code] ?? 'Permintaan belum dapat diselesaikan.'),{code:data.error?.code});
  return data;
}
function status(message) { $('#status').textContent=message; }
async function run(work) { try { status(''); await work(); } catch(e) { status(e.message); } }
function table(rows) {
  if(!Array.isArray(rows)||!rows.length)return '<p>Belum ada data.</p>';
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))].filter(k=>!['passwordHash','credentialVersion','actor','permissions'].includes(k)).slice(0,8);
  return `<div class="table-wrap"><table><thead><tr>${keys.map(k=>`<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,100).map(r=>`<tr>${keys.map(k=>`<td>${esc(typeof r[k]==='object'?Array.isArray(r[k])?`${r[k].length} item`:'Tersimpan':r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function dataView(data) {
  if(Array.isArray(data))return table(data);
  return Object.entries(data??{}).map(([key,value])=> `<article><h3>${esc(({ingredients:'Bahan',warehouse:'Gudang',purchasing:'Pembelian',dashboard:'Ringkasan keuangan',accountsPayable:'Utang supplier',catalog:'Menu',staff:'Staf',schedules:'Jadwal',attendance:'Absensi',requests:'Permohonan',hpp:'Resep & HPP'})[key]??key)}</h3>${Array.isArray(value)?table(value):value&&typeof value==='object'?dataView(value):`<p>${esc(value)}</p>`}</article>`).join('');
}
async function load() {
  const session = await request('/api/team/session');actor=session.actor;csrf=session.csrfToken;
  $('#login').hidden=true;$('#logout').hidden=false;
  $('#password-panel').hidden=!actor.passwordChangeRequired;
  if(actor.passwordChangeRequired)return;
  if(actor.systemOwner) {model=await request('/api/team/state');renderManagement();}
  else { $('#management').hidden=true;$('#workspace').hidden=false;await renderWorkspace(); }
}
function roleOptions(value='') {return model.roles.filter(r=>!r.systemOwner).map(r=>`<option value="${esc(r.id)}" ${value===r.id?'selected':''}>${esc(r.name)}</option>`).join('');}
function ownerConfirmation() {return '<label>Alasan perubahan<input name="reason" maxlength="160" required></label><label>Konfirmasi password Owner<input name="password" type="password" autocomplete="current-password" required></label>';}
function renderManagement() {
  $('#management').hidden=false;
  const role = model.roles.find(r=>r.id===selectedRole);
  $('#management').innerHTML=`<div class="grid"><section class="card"><h2>Role</h2><p>Satu role bisa digunakan beberapa akun.</p>${model.roles.map(r=>`<p><strong>${esc(r.name)}</strong> · ${r.members.length} akun ${r.systemOwner?'(terlindungi)':`<button data-role="${esc(r.id)}">Ubah role</button><button data-preview="${esc(r.id)}">Preview menu</button>`}</p>`).join('')}<button id="new-role">Buat role</button><div id="preview"></div></section><section class="card"><h2>Buat akun staf</h2>${model.roles.some(r=>!r.systemOwner)?`<form id="account-form"><label>Nama lengkap<input name="name" maxlength="80" required></label><label>Email / nama akun<input name="login" autocomplete="off" minlength="3" required></label><label>Role<select name="roleId">${roleOptions()}</select></label><label>Outlet<select name="outletId">${model.outletIds.map(id=>`<option value="${esc(id)}">${esc(model.outletLabels?.[id]??"Outlet aktif")}</option>`).join('')}</select></label>${ownerConfirmation()}<button>Buat akun</button></form>`:'<p>Buat role terlebih dahulu, kemudian tetapkan akun.</p>'}<div id="credential" class="credential" hidden></div></section></div>
    <section class="card"><h2>${role?'Ubah role':'Buat role'}</h2><form id="role-form"><label>Nama role<input name="name" value="${esc(role?.name)}" maxlength="80" required></label><label>Mulai dari template<select id="template"><option value="">Pilih sendiri</option>${Object.keys(model.templates).map(k=>`<option>${esc(k)}</option>`).join('')}</select></label><p>Izin tindakan membutuhkan Lihat. Fitur baru tidak otomatis diberikan.</p><div class="permissions">${model.features.map(f=>`<fieldset ${f.available?'':'disabled'}><legend>${esc(f.label)}</legend>${f.actions.map(a=>`<label><input name="permission" value="${f.id}.${a}" type="checkbox" ${role?.permissions.includes(`${f.id}.${a}`)?'checked':''}>${actionLabels[a]}</label>`).join('')}<small>${esc(f.explanation??(f.sensitive?'Akses sensitif; periksa sebelum menyimpan.':''))}</small></fieldset>`).join('')}</div><p id="impact">${role?`Perubahan berlaku untuk ${role.members.length} akun: ${role.members.map(m=>esc(m.name)).join(', ')}.`:'Role baru belum memiliki anggota.'}</p>${ownerConfirmation()}<button>Simpan role</button></form></section>
    <section class="card"><h2>Akun</h2>${model.accounts.map(a=>`<form class="panel account-edit" data-account="${esc(a.id)}"><h3>${esc(a.name)} · ${esc(a.login)}</h3><p>${a.active?'Aktif':'Nonaktif'}${a.passwordChangeRequired?' · Perlu mengganti password awal':''}</p>${a.roleId==='system-owner'?'<p>Owner sistem terlindungi.</p>':`<label>Role<select name="roleId">${roleOptions(a.roleId)}</select></label><label>Outlet<select name="outletId">${model.outletIds.map(id=>`<option value="${esc(id)}" ${a.outletId===id?"selected":""}>${esc(model.outletLabels?.[id]??"Outlet aktif")}</option>`).join("")}</select></label><label><input type="checkbox" name="active" ${a.active?'checked':''}>Akun aktif</label>${ownerConfirmation()}<button>Simpan akun</button><button type="button" data-reset="${esc(a.id)}">Reset akses</button>`}</form>`).join('')}</section><section class="card"><h2>Riwayat perubahan</h2><button id="audit-load">Muat riwayat</button><div id="audit"></div></section>`;
}
async function renderWorkspace() {
  const fresh=await request('/api/team/session');actor=fresh.actor;csrf=fresh.csrfToken;
  const navigation=actor.navigation.filter(n=>n.id!=='team');
  const feature=location.hash.slice(1)||navigation[0]?.id;
  $('#workspace').innerHTML=`<h2>${esc(actor.displayName)} · ${esc(actor.roleName)}</h2><nav aria-label="Fitur Anda">${navigation.map(n=>`<a class="button" href="${esc(n.href)}">${esc(n.label)}</a>`).join('')}</nav><div id="work-data"></div>`;
  if(!navigation.some(n=>n.id===feature))return;
  const result=await request(`/api/team/workspace/${feature}`);
  workspaceData=result.data;currentFeature=feature;
  const forms=workspaceForms(feature,result.data).filter(f=>actor.permissions.includes(f.permission));
  $('#work-data').innerHTML=`${actor.permissions.includes(`${feature}.export`)?`<a class="button" href="/api/team/workspace/${feature}.csv">Ekspor</a>`:''}${forms.map(f=>`<form class="panel work-form" data-action="${esc(f.action)}"><h3>${esc(f.label)}</h3>${f.fields.map(field=>`<label>${esc(field.label)}${field.options?`<select name="${esc(field.name)}" required>${field.options.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`:`<input name="${esc(field.name)}" type="${field.type}" ${field.type==='number'?'min="0" step="any"':''} required>`}</label>`).join('')}<label>Alasan<input name="reason" maxlength="160" minlength="8" required></label><button>Simpan</button></form>`).join('')}${dataView(result.data)}`;
}
function savedCredential(result) { if(!result.temporaryPassword)return; const el=$('#credential');el.hidden=false;el.innerHTML=`<strong>Password awal — ditampilkan sekali</strong><p>Berikan langsung kepada staf melalui jalur aman. Staf wajib menggantinya saat masuk. Password awal berlaku 7 hari.</p><code>${esc(result.temporaryPassword)}</code><button id="credential-close">Tutup</button>`;el.scrollIntoView({block:'center'}); }
document.addEventListener('submit',e=>{const form=e.target;e.preventDefault();run(async()=>{
  const values=Object.fromEntries(new FormData(form));
  if(form.id==='login-form'){config??=await request('/api/team/config');const data=await request('/api/team/login',{...values,organizationId:config.organizationId,outletId:config.outletIds[0]});csrf=data.csrfToken;form.reset();await load();return;}
  if(form.id==='password-form'){await request('/api/team/password',{...values,expectedRevision:actor.revision});form.reset();location.reload();return;}
  if(form.matches('.work-form')) {
    const spec=workspaceForms(currentFeature,workspaceData).find(f=>f.action===form.dataset.action);
    const payload=Object.fromEntries(spec.fields.map(f=>[f.name,f.type==='number'?Number(values[f.name]):f.type==='datetime-local'?new Date(values[f.name]).toISOString():values[f.name]]));
    const command={action:spec.action,expectedRevision:workspaceData.revision,reason:values.reason,payload:{...spec.payload(payload),reason:values.reason,expectedVersion:workspaceData.revision}};
    await request(`/api/team/workspace/${currentFeature}`,command);await renderWorkspace();status('Perubahan tersimpan.');return;
  }
  let result;
  if(form.id==='role-form')result=await request('/api/team/roles',{...values,roleId:selectedRole??undefined,permissions:[...form.querySelectorAll('[name=permission]:checked')].map(i=>i.value),expectedRevision:model.revision});
  if(form.id==='account-form')result=await request('/api/team/accounts',{...values,expectedRevision:model.revision});
  if(form.matches('.account-edit'))result=await request('/api/team/accounts/update',{...values,accountId:form.dataset.account,active:form.active.checked,expectedRevision:model.revision});
  if(result){selectedRole=null;await load();savedCredential(result);status('Perubahan tersimpan.');}
});});
document.addEventListener('click',e=>run(async()=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.id==='new-role'){selectedRole=null;renderManagement();$('#role-form input').focus();}
  if(b.dataset.role){selectedRole=b.dataset.role;renderManagement();$('#role-form input').focus();}
  if(b.dataset.preview){const data=await request(`/api/team/preview?roleId=${encodeURIComponent(b.dataset.preview)}`);$('#preview').innerHTML=`<h3>Preview menu</h3><p>${data.navigation.map(n=>esc(n.label)).join(' · ')||'Belum ada fitur'}</p><p>${data.members.length} akun menggunakan role ini. Preview tidak membuka sesi staf.</p>`;}
  if(b.dataset.reset){const f=b.closest('form');if(!f.reportValidity())return;const v=Object.fromEntries(new FormData(f));const result=await request('/api/team/accounts/reset',{accountId:b.dataset.reset,reason:v.reason,password:v.password,expectedRevision:model.revision});await load();savedCredential(result);}
  if(b.id==='audit-load'){const data=await request('/api/team/audit');$('#audit').innerHTML=table(data.events.map(v=>({tanggal:v.event.at??v.created_at,tindakan:v.event.operation,alasan:v.event.reason,revisi:v.revision})));}
  if(b.id==='credential-close'){$('#credential').textContent='';$('#credential').hidden=true;}
  if(b.id==='logout'){await request('/api/operator/logout',{});location.reload();}
}));
document.addEventListener('change',e=>{
  if(e.target.id==='template'){const grants=model.templates[e.target.value]??[];$('#role-form').querySelectorAll('[name=permission]').forEach(i=>{i.checked=grants.includes(i.value);});}
  if(e.target.name==='permission'){const feature=e.target.value.split('.')[0],view=$(`[value="${feature}.view"]`);if(!view.checked){e.target.closest('fieldset').querySelectorAll('input').forEach(i=>{if(i!==view)i.checked=false;});} }
  if(e.target.name==='permission'||e.target.id==='template'){
    const role=model.roles.find(r=>r.id===selectedRole),next=[...$('#role-form').querySelectorAll('[name=permission]:checked')].map(i=>i.value),previous=role?.permissions??[];
    const label=p=>{const [id,a]=p.split('.');return `${model.features.find(f=>f.id===id)?.label}: ${actionLabels[a]}`;};
    $('#impact').textContent=`${role?.members.length??0} akun terdampak. Ditambah: ${next.filter(p=>!previous.includes(p)).map(label).join(', ')||'tidak ada'}. Dicabut: ${previous.filter(p=>!next.includes(p)).map(label).join(', ')||'tidak ada'}.`;
  }
});
window.addEventListener('hashchange',()=>run(async()=>{if(actor&&!actor.systemOwner)await renderWorkspace();}));
run(load);
