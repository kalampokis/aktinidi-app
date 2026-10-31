// Gives the page the same db, assets, downloads and sample calls it has inside Claude,
// backed by this device: IndexedDB for records and files, the Anthropic API for optional reading.
(function(){
const SDK_URL='https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.2.0/+esm';
const MODEL='claude-opus-5-5';
const KEY_ITEM='aktinidi.apiKey',BACKUP_ITEM='aktinidi.lastBackup';
const ls={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}},del(k){try{localStorage.removeItem(k)}catch(e){}}};

let idbP=null;
function idb(){
  return idbP||(idbP=new Promise((ok,no)=>{
    const r=indexedDB.open('aktinidi',2);
    r.onupgradeneeded=()=>{for(const [n,k] of [['docs','path'],['blobs','id'],['outbox','path']])if(!r.result.objectStoreNames.contains(n))r.result.createObjectStore(n,{keyPath:k})};
    r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);
  }));
}
async function tx(store,mode,fn){
  const d=await idb();
  return new Promise((ok,no)=>{
    const t=d.transaction(store,mode),req=fn(t.objectStore(store));
    t.oncomplete=()=>ok(req&&req.result);t.onerror=t.onabort=()=>no(t.error||{code:'unavailable'});
  });
}
const newId=()=>(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/-/g,'');
const clone=v=>JSON.parse(JSON.stringify(v));

/* Records */
const listeners={};
const channel=window.BroadcastChannel?new BroadcastChannel('aktinidi'):null;
async function readCol(col){return (await tx('docs','readonly',s=>s.getAll())).filter(r=>r.col===col)}
async function emit(col){
  const rows=await readCol(col);
  const snap={docs:rows.map(r=>({id:r.id,exists:true,data:()=>r.data,metadata:{fromCache:false,hasPendingWrites:false}}))};
  snap.size=snap.docs.length;snap.empty=!snap.size;
  (listeners[col]||[]).forEach(f=>f(snap));
}
function changed(col){emit(col);if(channel)channel.postMessage(col)}
if(channel)channel.onmessage=e=>emit(e.data);
function docRef(col,id){
  const path=col+'/'+id;
  return {id,path,
    async get(){const r=await tx('docs','readonly',s=>s.get(path));return {id,exists:!!r,data:()=>r&&r.data}},
    async set(data){const d=clone(data);await tx('docs','readwrite',s=>s.put({path,col,id,data:d}));changed(col);queue({path,col,id,data:d})},
    async update(data){const r=await tx('docs','readonly',s=>s.get(path));if(!r)throw {code:'invalid_argument',message:'missing'};const d={...r.data,...clone(data)};await tx('docs','readwrite',s=>s.put({path,col,id,data:d}));changed(col);queue({path,col,id,data:d})},
    async delete(){await tx('docs','readwrite',s=>s.delete(path));changed(col);queue({path,col,id,deleted:true})}
  };
}
const db={
  collection:col=>({path:col,doc:id=>docRef(col,id||newId()),
    onSnapshot(next){(listeners[col]=listeners[col]||[]).push(next);emit(col);return ()=>{listeners[col]=listeners[col].filter(f=>f!==next)}}}),
  doc:p=>{const i=p.lastIndexOf('/');return docRef(p.slice(0,i),p.slice(i+1))}
};

/* Files */
const urls=new Map();
const FILE_TYPES=['image/jpeg','image/png','image/webp','image/gif','application/pdf'];
const assets={
  async upload(blob,opt){
    const type=(opt&&opt.type)||blob.type;
    if(!FILE_TYPES.includes(type))throw {code:'unsupported_type',message:type};
    if(blob.size>20*1024*1024)throw {code:'too_large',message:'20 MB'};
    const id=newId(),b=new Blob([blob],{type});
    await tx('blobs','readwrite',s=>s.put({id,blob:b,type,createdAt:new Date().toISOString()}));
    const url=URL.createObjectURL(b);urls.set(id,url);
    queue({path:'_file/'+id,col:'_file',id});
    return {id,url,sizeBytes:b.size,contentType:type};
  },
  async delete(id){await tx('blobs','readwrite',s=>s.delete(id));if(urls.has(id)){URL.revokeObjectURL(urls.get(id));urls.delete(id)}queue({path:'_file/'+id,col:'_file',id,deleted:true});return {deleted:true}},
  urlFor:id=>urls.get(id)||'#'
};
async function loadFiles(){for(const r of await tx('blobs','readonly',s=>s.getAll()))if(!urls.has(r.id))urls.set(r.id,URL.createObjectURL(r.blob))}

/* Saving files */
const downloads={
  async save({filename,data}){
    const type=filename.endsWith('.csv')?'text/csv':'application/json';
    const blob=data instanceof Blob?data:new Blob([data],{type});
    const file=new File([blob],filename,{type});
    if(matchMedia('(pointer:coarse)').matches&&navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file]});return {status:'saved'}}
      catch(e){if(e&&e.name==='AbortError')throw {code:'declined',message:'declined'}}
    }
    const a=document.createElement('a'),u=URL.createObjectURL(blob);
    a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(u),30000);
    return {status:'saved'};
  }
};

/* Syncing with Supabase. The device stays the working copy, so the app behaves the same without signal. */
const cfg=window.AKTINIDI_CONFIG||{};
const CURSOR_ITEM='aktinidi.syncCursor';
const sb=cfg.supabaseUrl&&cfg.supabaseKey&&window.supabase?window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey):null;
let session=null,syncing=false,again=false,syncTimer=null;
const syncState={status:sb?'signedOut':'off'};
const authReady=sb?sb.auth.getSession().then(r=>{session=r.data.session}).catch(()=>{}):Promise.resolve();
if(sb)sb.auth.onAuthStateChange((_e,s)=>{session=s});
function showStatus(status,pending){
  syncState.status=status;syncState.pending=pending||0;
  const el=document.getElementById('syncStatus');
  if(el)el.textContent={synced:'Συγχρονισμένα',pending:`${pending} αλλαγές σε αναμονή`,offline:pending?`Χωρίς σύνδεση · ${pending} σε αναμονή`:'Χωρίς σύνδεση',error:'Ο συγχρονισμός δεν έγινε, θα ξαναδοκιμάσει',expired:'Χρειάζεται νέα σύνδεση',syncing:'Συγχρονισμός…'}[status]||'';
}
async function queue(item){
  if(!sb||!session)return;
  await tx('outbox','readwrite',s=>s.put({...item,ts:new Date().toISOString()}));
  clearTimeout(syncTimer);syncTimer=setTimeout(sync,800);
}
async function queueEverything(){
  const ts=new Date().toISOString();
  const docs=await tx('docs','readonly',s=>s.getAll()),blobs=await tx('blobs','readonly',s=>s.getAll());
  const d=await idb();
  await new Promise((ok,no)=>{const t=d.transaction('outbox','readwrite'),o=t.objectStore('outbox');
    blobs.forEach(b=>o.put({path:'_file/'+b.id,col:'_file',id:b.id,ts}));
    docs.forEach(r=>o.put({path:r.path,col:r.col,id:r.id,data:r.data,ts}));
    t.oncomplete=ok;t.onerror=t.onabort=()=>no(t.error)});
}
const filePath=id=>session.user.id+'/'+id;
async function pushOne(item){
  if(item.col==='_file'){
    if(item.deleted){const {error}=await sb.storage.from('invoices').remove([filePath(item.id)]);if(error)throw error;return}
    const b=await tx('blobs','readonly',s=>s.get(item.id));
    if(!b)return;
    const {error}=await sb.storage.from('invoices').upload(filePath(item.id),b.blob,{upsert:true,contentType:b.type});
    if(error)throw error;
    return;
  }
  const {error}=await sb.rpc('push_change',{p_col:item.col,p_id:item.id,p_data:item.deleted?null:item.data,p_deleted:!!item.deleted,p_client_ts:item.ts});
  if(error)throw error;
}
async function pull(){
  const pending=new Set((await tx('outbox','readonly',s=>s.getAllKeys())));
  const {data,error}=await sb.rpc('pull_changes',{p_since:ls.get(CURSOR_ITEM)});
  if(error)throw error;
  const touched=new Set();
  for(const col of ['fields','invoices','entries','products'])for(const row of data[col]||[]){
    const path=col+'/'+row.id;
    if(pending.has(path))continue;
    await tx('docs','readwrite',s=>row.deleted?s.delete(path):s.put({path,col,id:row.id,data:row.data}));
    touched.add(col);
  }
  // Starts a minute back so a change saved at the same moment is not missed; applying one twice is harmless.
  ls.set(CURSOR_ITEM,new Date(new Date(data.server_time).getTime()-60000).toISOString());
  touched.forEach(changed);
}
async function fetchMissingFiles(){
  const have=new Set(await tx('blobs','readonly',s=>s.getAllKeys()));
  const invoices=(await tx('docs','readonly',s=>s.getAll())).filter(r=>r.col==='invoices'&&r.data.fileId&&!have.has(r.data.fileId));
  let got=false;
  for(const r of invoices){
    const id=r.data.fileId,{data,error}=await sb.storage.from('invoices').download(filePath(id));
    if(error||!data)continue;
    await tx('blobs','readwrite',s=>s.put({id,blob:data,type:data.type,createdAt:new Date().toISOString()}));
    urls.set(id,URL.createObjectURL(data));got=true;
  }
  if(got)changed('invoices');
}
async function sync(){
  if(!sb||!session)return;
  if(syncing){again=true;return}
  syncing=true;
  try{
    if(navigator.onLine===false){showStatus('offline',await tx('outbox','readonly',s=>s.count()));return}
    showStatus('syncing');
    const items=await tx('outbox','readonly',s=>s.getAll());
    items.sort((a,b)=>(a.col==='_file'?0:1)-(b.col==='_file'?0:1)||a.ts.localeCompare(b.ts));
    for(const item of items){
      await pushOne(item);
      // A newer edit may have arrived while this one was on its way, and that one still has to go.
      const now=await tx('outbox','readonly',s=>s.get(item.path));
      if(now&&now.ts===item.ts)await tx('outbox','readwrite',s=>s.delete(item.path));
    }
    await pull();
    await fetchMissingFiles();
    const left=await tx('outbox','readonly',s=>s.count());
    showStatus(left?'pending':'synced',left);
  }catch(e){
    const left=await tx('outbox','readonly',s=>s.count()).catch(()=>0);
    const denied=e&&(e.status===401||e.code==='PGRST301'||e.code==='PGRST303');
    showStatus(denied?'expired':navigator.onLine===false?'offline':'error',left);
  }finally{
    syncing=false;
    if(again){again=false;setTimeout(sync,200)}
  }
}
if(sb){
  window.addEventListener('online',sync);
  window.addEventListener('offline',sync);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')sync()});
  setInterval(()=>{if(document.visibilityState==='visible')sync()},60000);
}
async function signIn(email,password,create){
  const r=create?await sb.auth.signUp({email,password}):await sb.auth.signInWithPassword({email,password});
  if(r.error)throw r.error;
  if(!r.data.session)return 'confirm';
  session=r.data.session;
  await queueEverything();
  ls.del(CURSOR_ITEM);
  return 'in';
}
async function signOut(){
  await sb.auth.signOut({scope:'local'}).catch(()=>{});
  const d=await idb();
  await new Promise((ok,no)=>{const t=d.transaction(['docs','blobs','outbox'],'readwrite');['docs','blobs','outbox'].forEach(n=>t.objectStore(n).clear());t.oncomplete=ok;t.onerror=()=>no(t.error)});
  ls.del(CURSOR_ITEM);ls.del(BACKUP_ITEM);
}
async function readInCloud(opt){
  const files=[];
  for(const b of [].concat(opt.images||[]))files.push({type:b.type||'image/jpeg',data:await toB64(b)});
  const {data,error}=await sb.functions.invoke('read-invoice',{body:{files},signal:opt.signal});
  if(opt.signal&&opt.signal.aborted)throw {code:'cancelled',message:'stopped'};
  if(error)throw {code:error.context&&error.context.status===401?'session_expired':'upstream_error',message:String(error.message)};
  if(!data||!data.ok)throw {code:(data&&data.error)||'upstream_error',message:'read failed'};
  return data.invoice;
}

/* Optional reading with the user's own API key */
const toB64=blob=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=()=>no(r.error);r.readAsDataURL(blob)});
function parseJson(text){
  try{return JSON.parse(text)}catch(e){}
  const a=text.indexOf('{'),b=text.lastIndexOf('}');
  if(a>=0&&b>a){try{return JSON.parse(text.slice(a,b+1))}catch(e){}}
  throw {code:'invalid_json',message:'no JSON',text};
}
const sample=Object.assign(()=>Promise.reject({code:'capability_removed',message:'json only'}),{
  async limits(){await authReady;return session||ls.get(KEY_ITEM)?{maxPromptBytes:262144,images:{maxCount:3,maxInputBytes:20971520,mediaTypes:['image/jpeg','image/png','image/webp']},pdf:true}:{maxPromptBytes:262144}},
  async json(prompt,opt={}){
    await authReady;
    if(session)return readInCloud(opt);
    const apiKey=ls.get(KEY_ITEM);
    if(!apiKey)throw {code:'images_unavailable',message:'no key'};
    let Anthropic;
    try{Anthropic=(await import(SDK_URL)).default}catch(e){throw {code:'upstream_error',message:'sdk'}}
    const content=[];
    for(const b of [].concat(opt.images||[])){
      const data=await toB64(b);
      content.push(b.type==='application/pdf'
        ?{type:'document',source:{type:'base64',media_type:'application/pdf',data}}
        :{type:'image',source:{type:'base64',media_type:b.type||'image/jpeg',data}});
    }
    content.push({type:'text',text:prompt});
    const client=new Anthropic({apiKey,dangerouslyAllowBrowser:true});
    let res;
    try{
      res=await client.beta.messages.create({model:MODEL,max_tokens:16000,output_config:{effort:'medium'},betas:['server-side-fallback-2026-07-01'],fallbacks:'default',messages:[{role:'user',content}]},{signal:opt.signal});
    }catch(e){
      if(e instanceof Anthropic.APIUserAbortError)throw {code:'cancelled',message:'stopped'};
      if(e instanceof Anthropic.AuthenticationError||e instanceof Anthropic.PermissionDeniedError)throw {code:'bad_key',message:'key'};
      if(e instanceof Anthropic.RateLimitError)throw {code:'rate_limited',message:'limit'};
      throw {code:'upstream_error',message:String(e&&e.message)};
    }
    if(res.stop_reason==='refusal')throw {code:'refused',message:'refused'};
    if(res.stop_reason==='max_tokens')throw {code:'invalid_json',message:'cut short'};
    return parseJson(res.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
  }
});

window.claude={local:true,use:async name=>{
  if(name==='db')return db;
  if(name==='assets'){await loadFiles();return assets}
  if(name==='downloads')return downloads;
  if(name==='sample')return sample;
  return null;
}};

/* Backup */
const b64ToBlob=(b64,type)=>{const s=atob(b64),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new Blob([u],{type})};
async function makeBackup(){
  const docs=await tx('docs','readonly',s=>s.getAll()),files=[];
  for(const r of await tx('blobs','readonly',s=>s.getAll()))files.push({id:r.id,type:r.type,createdAt:r.createdAt,data:await toB64(r.blob)});
  return JSON.stringify({app:'aktinidi',version:1,exportedAt:new Date().toISOString(),docs,files});
}
async function restoreBackup(text){
  const b=JSON.parse(text);
  if(!b||b.app!=='aktinidi'||!Array.isArray(b.docs)||!Array.isArray(b.files))throw new Error('format');
  const d=await idb();
  await new Promise((ok,no)=>{
    const t=d.transaction(['docs','blobs'],'readwrite'),ds=t.objectStore('docs'),bs=t.objectStore('blobs');
    ds.clear();bs.clear();
    b.docs.forEach(r=>ds.put({path:r.col+'/'+r.id,col:r.col,id:r.id,data:r.data}));
    b.files.forEach(f=>bs.put({id:f.id,type:f.type,createdAt:f.createdAt,blob:b64ToBlob(f.data,f.type)}));
    t.oncomplete=ok;t.onerror=t.onabort=()=>no(t.error);
  });
}

/* Settings */
const fmtDate=s=>new Date(s).toLocaleDateString('el-GR',{day:'2-digit',month:'2-digit',year:'numeric'});
function el(html){const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstChild}
async function backupNow(out){
  try{
    await downloads.save({filename:`aktinidi-antigrafo-${new Date().toISOString().slice(0,10)}.json`,data:await makeBackup()});
    ls.set(BACKUP_ITEM,new Date().toISOString());
    const n=document.getElementById('backupNag');if(n)n.remove();
    if(out)out.textContent='Το αντίγραφο αποθηκεύτηκε. Φύλαξέ το και εκτός κινητού, π.χ. στο email ή στο Drive σου.';
  }catch(e){if(out&&!(e&&e.code==='declined'))out.textContent='Το αντίγραφο δεν αποθηκεύτηκε. Ξαναδοκίμασε.'}
}
async function openSettings(){
  const dlg=document.getElementById('dlg'),hasKey=!!ls.get(KEY_ITEM),last=ls.get(BACKUP_ITEM);
  const persisted=navigator.storage&&navigator.storage.persisted?await navigator.storage.persisted():false;
  const account=!sb?'':session?`<h2>Λογαριασμός</h2>
    <p style="margin:0">Συνδεδεμένος ως <b id="setWho"></b>. Τα στοιχεία σου συγχρονίζονται με όλες τις συσκευές σου.</p>
    <p class="lbl" style="margin:0" id="setSync"></p>
    <div class="toolbar"><button type="button" class="btn small" id="setSyncNow">Συγχρονισμός τώρα</button><button type="button" class="btn small danger" id="setOut">Αποσύνδεση</button></div>`
    :`<h2>Λογαριασμός</h2>
    <p style="margin:0">Σύνδεσε τη συσκευή για να σώζονται τα στοιχεία σου και να τα βλέπεις παντού. Όσα έχεις ήδη περάσει εδώ θα ανέβουν στον λογαριασμό σου.</p>
    <label class="f"><span>Email</span><input id="setEmail" type="email" autocomplete="username" inputmode="email"></label>
    <label class="f"><span>Κωδικός</span><input id="setPass" type="password" autocomplete="current-password"></label>
    <p class="err" id="setAuthErr" hidden></p>
    <div class="toolbar"><button type="button" class="btn primary" id="setIn">Σύνδεση</button><button type="button" class="btn" id="setUp">Νέος λογαριασμός</button></div>`;
  dlg.innerHTML=`<form id="settingsForm" novalidate>
    <h2>Ρυθμίσεις</h2>
    ${sb?'':'<p style="margin:0">Τα στοιχεία σου μένουν μόνο σε αυτή τη συσκευή. Δεν στέλνονται πουθενά και δεν συγχρονίζονται με άλλες συσκευές.</p>'}
    ${account}
    <h2>Αντίγραφο ασφαλείας</h2>
    <p class="lbl" style="margin:0">${last?'Τελευταίο αντίγραφο: '+fmtDate(last):'Δεν έχεις κρατήσει ακόμη αντίγραφο.'}${persisted?'':' Ο browser μπορεί να σβήσει τα δεδομένα αν δεν έχεις εγκαταστήσει την εφαρμογή ή αν γεμίσει ο χώρος.'}</p>
    <div class="toolbar"><button type="button" class="btn" id="setBackup">Κατέβασε αντίγραφο</button><label class="btn" style="display:inline-flex;align-items:center;cursor:pointer">Επαναφορά από αρχείο<input id="setRestore" type="file" accept="application/json,.json" hidden></label></div>
    <p class="lbl" id="setMsg" style="margin:0" role="status"></p>
    ${sb?'<div class="actions"><button type="button" class="btn" data-act="closeDlg">Κλείσιμο</button></div>':`<h2>Ανάγνωση τιμολογίων με AI (προαιρετικό)</h2>
    <p class="lbl" style="margin:0">Χωρίς κλειδί όλα δουλεύουν κανονικά και τα τιμολόγια περνούν με το χέρι. Με δικό σου κλειδί Anthropic API, η φωτογραφία ή το PDF του τιμολογίου στέλνεται στην Anthropic για ανάγνωση και χρεώνεσαι ανά ανάγνωση. Το κλειδί μένει μόνο σε αυτή τη συσκευή. Βάλε όριο δαπάνης στο κλειδί.</p>
    <label class="f"><span>Κλειδί API</span><input id="setKey" type="password" autocomplete="off" placeholder="${hasKey?'Υπάρχει αποθηκευμένο κλειδί':'sk-ant-…'}"></label>
    <div class="actions">${hasKey?'<button type="button" class="btn danger left" id="setKeyDel">Αφαίρεση κλειδιού</button>':''}<button type="button" class="btn" data-act="closeDlg">Κλείσιμο</button><button type="button" class="btn primary" id="setKeySave">Αποθήκευση κλειδιού</button></div>`}
  </form>`;
  if(!dlg.open)dlg.showModal();
  const msg=dlg.querySelector('#setMsg');
  dlg.querySelector('#setBackup').onclick=()=>backupNow(msg);
  const on=(id,fn)=>{const b=dlg.querySelector(id);if(b)b.onclick=fn};
  on('#setKeySave',()=>{const v=dlg.querySelector('#setKey').value.trim();if(!v){msg.textContent='';return dlg.close()}ls.set(KEY_ITEM,v);location.reload()});
  on('#setKeyDel',()=>{ls.del(KEY_ITEM);location.reload()});
  if(session){
    dlg.querySelector('#setWho').textContent=session.user.email||'';
    dlg.querySelector('#setSync').textContent=(document.getElementById('syncStatus')||{}).textContent||'';
    on('#setSyncNow',async()=>{await sync();dlg.querySelector('#setSync').textContent=document.getElementById('syncStatus').textContent});
    on('#setOut',async ev=>{
      const b=ev.currentTarget;
      if(!b.classList.contains('armed')){
        const left=await tx('outbox','readonly',s=>s.count());
        b.classList.add('armed');b.textContent='Ναι, αποσύνδεση';
        dlg.querySelector('#setSync').textContent=left?`Προσοχή: ${left} αλλαγές δεν έχουν ανέβει και θα χαθούν. Τα στοιχεία σβήνονται από αυτή τη συσκευή.`:'Τα στοιχεία σβήνονται από αυτή τη συσκευή και μένουν στον λογαριασμό σου.';
        return;
      }
      await signOut();location.reload();
    });
  }else if(sb){
    const go=create=>async()=>{
      const err=dlg.querySelector('#setAuthErr'),email=dlg.querySelector('#setEmail').value.trim(),pass=dlg.querySelector('#setPass').value;
      err.hidden=true;
      if(!email||!pass){err.textContent='Βάλε email και κωδικό.';err.hidden=false;return}
      try{
        const r=await signIn(email,pass,create);
        if(r==='confirm'){err.textContent='Σου στείλαμε email επιβεβαίωσης. Πάτησε τον σύνδεσμο και μετά σύνδεσου εδώ.';err.hidden=false;return}
        location.reload();
      }catch(e){err.textContent=navigator.onLine===false?'Χρειάζεται σύνδεση στο internet για να συνδεθείς.':create?'Ο λογαριασμός δεν δημιουργήθηκε. Ο κωδικός θέλει τουλάχιστον 6 χαρακτήρες ή οι νέες εγγραφές είναι κλειστές.':'Λάθος email ή κωδικός.';err.hidden=false}
    };
    on('#setIn',go(false));on('#setUp',go(true));
  }
  dlg.querySelector('#setRestore').onchange=ev=>{
    const f=ev.target.files[0];if(!f)return;
    msg.innerHTML='';msg.append('Η επαναφορά αντικαθιστά ό,τι υπάρχει τώρα σε αυτή τη συσκευή. ');
    const b=el('<button type="button" class="btn danger small">Ναι, αντικατάστησέ τα</button>');msg.append(b);
    b.onclick=async()=>{try{await restoreBackup(await f.text());if(session)await queueEverything();ls.set(BACKUP_ITEM,new Date().toISOString());location.reload()}catch(e){msg.textContent='Αυτό το αρχείο δεν είναι αντίγραφο της εφαρμογής. Τα στοιχεία σου δεν άλλαξαν.'}};
  };
}
document.addEventListener('DOMContentLoaded',async()=>{
  const head=document.querySelector('header.top'),btn=el('<button class="btn small" id="settingsBtn">Ρυθμίσεις</button>');
  btn.onclick=openSettings;head.append(btn);
  if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{});
  btn.before(el('<span class="lbl" id="syncStatus" role="status" style="flex-basis:100%;order:3"></span>'));
  await authReady;
  if(session){sync();return}
  if(sb){
    const n=el('<div class="banner" id="backupNag"><p>Σύνδεση για να σώζονται τα στοιχεία σου και να τα βλέπεις σε όλες τις συσκευές.</p><button class="btn small">Σύνδεση</button></div>');
    n.querySelector('button').onclick=openSettings;
    document.getElementById('banner').before(n);
    return;
  }
  const count=(await tx('docs','readonly',s=>s.count()))||0,last=ls.get(BACKUP_ITEM);
  if(count>0&&(!last||Date.now()-new Date(last)>30*864e5)){
    const n=el(`<div class="banner" id="backupNag"><p>${last?'Έχεις πάνω από έναν μήνα να κρατήσεις αντίγραφο.':'Δεν έχεις κρατήσει ακόμη αντίγραφο.'} Τα στοιχεία σου υπάρχουν μόνο σε αυτή τη συσκευή.</p><button class="btn small">Κατέβασε αντίγραφο</button></div>`);
    n.querySelector('button').onclick=()=>backupNow();
    document.getElementById('banner').before(n);
  }
});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
})();
