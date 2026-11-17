/* DEBOO16 Local Edition — IndexedDB storage; no Supabase required. */
window.DebooDB = (() => {
  "use strict";
  const DB_NAME = "DEBOO16_LOCAL_DB";
  const DB_VERSION = 1;
  let dbPromise;
  const now = () => new Date().toISOString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "d16-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  function openDB() {
    if (!("indexedDB" in window)) return Promise.reject(new Error("هذا المتصفح لا يدعم التخزين المحلي المطلوب."));
    if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("records")) {
          const s = d.createObjectStore("records", {keyPath:"id"});
          s.createIndex("entity_type","entity_type",{unique:false});
          s.createIndex("created_at","created_at",{unique:false});
        }
        if (!d.objectStoreNames.contains("audit_logs")) d.createObjectStore("audit_logs",{keyPath:"id"});
        if (!d.objectStoreNames.contains("approved_reports")) d.createObjectStore("approved_reports",{keyPath:"id"});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("تعذر فتح قاعدة البيانات المحلية."));
    });
    return dbPromise;
  }
  async function txStore(name,mode,work) {
    const d=await openDB();
    return new Promise((resolve,reject)=>{
      const tx=d.transaction(name,mode), store=tx.objectStore(name);
      let result;
      try { result=work(store,tx); } catch(e) { try{tx.abort()}catch{} reject(e); return; }
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error || new Error("فشلت عملية التخزين."));
      tx.onabort=()=>reject(tx.error || new Error("تم إلغاء عملية التخزين."));
    });
  }
  async function getAll(name) {
    const d=await openDB();
    return new Promise((resolve,reject)=>{
      const tx=d.transaction(name,"readonly"),req=tx.objectStore(name).getAll();
      req.onsuccess=()=>resolve(req.result||[]);
      req.onerror=()=>reject(req.error);
    });
  }
  async function get(name,id) {
    const d=await openDB();
    return new Promise((resolve,reject)=>{
      const req=d.transaction(name,"readonly").objectStore(name).get(id);
      req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
    });
  }
  async function addAudit(action,recordId,oldData,newData,reason) {
    const item={id:uid(),action,record_id:recordId||null,old_data:oldData||null,new_data:newData||null,reason:reason||"",created_at:now(),actor:"مستخدم الجهاز"};
    await txStore("audit_logs","readwrite",s=>s.put(item));
  }
  function init(){ return {auth:{signOut:async()=>({error:null}),getUser:async()=>({data:{user:{email:"مستخدم محلي"}}})}}; }
  const configured=()=>true;
  async function all(opts={}) {
    let data=await getAll("records");
    data=data.filter(x=>!!x.is_archived===!!opts.archived);
    return data.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,opts.limit||2000);
  }
  async function list(type,opts={}) {
    let data=await all({archived:opts.archived,limit:opts.limit||500});
    return data.filter(x=>x.entity_type===type&&(!opts.branch_id||x.branch_id===opts.branch_id)&&(!opts.status||x.status===opts.status));
  }
  async function save(type,payload,id=null) {
    if(!type||!payload||typeof payload!=="object") throw new Error("بيانات السجل غير صالحة.");
    if(type==="bike_patrols") {
      const day=(payload.patrol_time||now()).slice(0,10);
      const existing=(await all()).filter(x=>x.entity_type==="bike_patrols"&&x.id!==id&&(x.payload?.patrol_time||x.created_at).slice(0,10)===day);
      if(existing.length>=5) throw new Error("تم تسجيل الحد الأقصى: 5 مرات مرور للدراجات في هذا اليوم.");
    }
    const old=id?await get("records",id):null;
    if(id&&!old) throw new Error("السجل المطلوب تعديله غير موجود.");
    const row={id:id||uid(),entity_type:type,payload:{...payload},branch_id:payload.branch_id||null,status:payload.status||"active",is_archived:false,created_at:old?.created_at||now(),updated_at:now(),created_by:"local"};
    await txStore("records","readwrite",s=>s.put(row));
    await addAudit(id?"update":"create",row.id,old,row,id?(payload.edit_reason||"تعديل سجل"):"إضافة سجل");
    return row;
  }
  async function archive(id,reason="أرشفة سجل") {
    const old=await get("records",id);if(!old)throw new Error("السجل غير موجود.");
    const row={...old,is_archived:true,updated_at:now()};
    await txStore("records","readwrite",s=>s.put(row));
    await addAudit("archive",id,old,row,reason);return row;
  }
  async function audit(limit=100) {return (await getAll("audit_logs")).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,limit);}
  async function approve(snapshot) {
    const item={id:uid(),title:"تقرير DEBOO16",snapshot,created_at:now(),actor:"مستخدم الجهاز"};
    await txStore("approved_reports","readwrite",s=>s.put(item));
    await addAudit("approve",item.id,null,item,"اعتماد نسخة تقرير");return item;
  }
  async function backup() {
    const [records,audit_logs,approved_reports]=await Promise.all([getAll("records"),getAll("audit_logs"),getAll("approved_reports")]);
    return {app:"DEBOO16",format:1,mode:"local",created_at:now(),records,audit_logs,approved_reports};
  }
  async function restore(obj) {
    if(!obj||obj.app!=="DEBOO16"||obj.format!==1||!Array.isArray(obj.records)||!Array.isArray(obj.audit_logs)) throw new Error("ملف النسخة غير صالح أو غير متوافق.");
    if(obj.records.some(x=>!x.id||!x.entity_type||!x.payload)) throw new Error("تحتوي النسخة على سجل غير صالح؛ لم يتم تغيير بياناتك.");
    const current=await backup();
    if(current.records.length) downloadBlob(new Blob([JSON.stringify(current,null,2)],{type:"application/json"}),"DEBOO16-before-restore.json");
    const d=await openDB();
    await new Promise((resolve,reject)=>{
      const tx=d.transaction(["records","audit_logs","approved_reports"],"readwrite");
      for(const name of ["records","audit_logs","approved_reports"]) tx.objectStore(name).clear();
      obj.records.forEach(x=>tx.objectStore("records").put(x));
      obj.audit_logs.forEach(x=>tx.objectStore("audit_logs").put(x));
      (Array.isArray(obj.approved_reports)?obj.approved_reports:[]).forEach(x=>tx.objectStore("approved_reports").put(x));
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("تعذرت الاستعادة."));
    });
    await addAudit("restore",null,null,{count:obj.records.length},"استعادة نسخة احتياطية");
  }
  function downloadBlob(blob,name) {
    const a=document.createElement("a"),url=URL.createObjectURL(blob);
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  return {init,configured,list,all,save,archive,audit,approve,backup,restore,downloadBlob,local:true};
})();