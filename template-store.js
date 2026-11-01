import { validateSettings, optionalSettings } from './settings-model.js';
const MAX_FILE = 2000000;
let connection;
function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('이 브라우저는 양식 보관을 지원하지 않습니다. JSON 백업을 이용해 주세요.'));
  return connection ||= new Promise((resolve,reject)=>{
    const request = indexedDB.open('hanform-library',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('forms',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>{connection=null;reject(new Error('브라우저 저장 공간을 열 수 없습니다. 저장 허용 여부를 확인해 주세요.'));};
  });
}
async function operate(mode, action) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction('forms',mode), request=action(transaction.objectStore('forms'));
    let result; request.onsuccess=()=>{result=request.result;};
    transaction.oncomplete=()=>resolve(result);
    transaction.onabort=transaction.onerror=()=>reject(new Error('양식을 저장하지 못했습니다. 저장 공간을 확인하거나 백업 후 정리해 주세요.'));
  });
}
export function cleanDocument(value) {
  if (!value || typeof value.title!=='string' || !value.title.trim() || value.title.length>80 || /[\x00-\x1f]/.test(value.title) || typeof value.requirements!=='string' || value.requirements.length>500) throw new Error('양식 이름과 입력 조건을 확인해 주세요.');
  let problems; try { problems=validateSettings(value.settings); } catch { throw new Error('문서 설정 형식이 올바르지 않습니다.'); }
  if (value.settings.schemaVersion!==1 || problems.length) throw new Error(problems?.[0]?.message || '지원하는 문서 설정이 아닙니다.');
  const s=value.settings;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test([s.fontFamily,...s.requiredItems].join(''))) throw new Error('설정에 사용할 수 없는 제어 문자가 있습니다.');
  return {title:value.title.trim(),requirements:value.requirements,settings:{schemaVersion:1,paper:{size:s.paper.size,orientation:s.paper.orientation},marginsMm:{top:s.marginsMm.top,bottom:s.marginsMm.bottom,left:s.marginsMm.left,right:s.marginsMm.right},fontFamily:s.fontFamily,fontSizePt:s.fontSizePt,lineSpacing:{value:s.lineSpacing.value,unit:s.lineSpacing.unit},requiredItems:[...s.requiredItems],...optionalSettings(s),...(s.documentOptions?{documentOptions:{coverPage:s.documentOptions.coverPage,contentsPage:s.documentOptions.contentsPage,tableItems:[...s.documentOptions.tableItems]}}:{})}};
}
export const allForms=()=>operate('readonly',store=>store.getAll());
export const getForm=id=>operate('readonly',store=>store.get(id));
export const deleteForm=id=>operate('readwrite',store=>store.delete(id));
export async function saveForm(value) {
  const clean=cleanDocument(value), previous=value.id ? await getForm(value.id) : null;
  const combined=[...(previous?.history || []),...(Array.isArray(value.cloudHistory)?value.cloudHistory.slice(-10).map(entry=>({...cleanDocument({...entry,requirements:entry.requirements ?? ''}),at:entry.at})):[])];
  const history=[...new Map(combined.map(entry=>[entry.at+JSON.stringify(entry.settings)+entry.title,entry])).values()].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  if(previous && JSON.stringify(clean)!==JSON.stringify(cleanDocument(previous))) history.push({...cleanDocument(previous),at:previous.updatedAt});
  const file=value.file instanceof Blob && value.file.size<=MAX_FILE ? value.file : null;
  const result={...clean,id:previous?.id || crypto.randomUUID(),createdAt:previous?.createdAt || new Date().toISOString(),updatedAt:new Date().toISOString(),history:history.slice(-20),file,fileLayoutVersion:file&&Number.isInteger(value.fileLayoutVersion)?value.fileLayoutVersion:null,fileName:file && typeof value.fileName==='string'?value.fileName:null,cloud:previous?.cloud || null};
  await operate('readwrite',store=>store.put(result)); return result;
}
export async function setCloud(id,cloud) {
  const item=await getForm(id); if(!item)throw new Error('저장한 양식을 찾을 수 없습니다.');
  item.cloud=cloud; await operate('readwrite',store=>store.put(item)); return item;
}
export async function importBackup(raw) {
  if(!raw || raw.format!=='hanform-backup' || raw.version!==1 || !Array.isArray(raw.forms) || raw.forms.length>200) throw new Error('한폼 양식 백업 파일이 아닙니다.');
  // Validate the whole file before writing any rows. Imported HWPX is regenerated, never trusted as executable content.
  const docs=raw.forms.map(source=>{
    const doc=cleanDocument(source);
    const cloud=source.cloud;
    if(cloud && (!/^[0-9a-f-]{36}$/i.test(cloud.id) || !/^[0-9a-f]{64}$/.test(cloud.token) || !Number.isInteger(cloud.version))) throw new Error('백업의 공유 관리 정보가 올바르지 않습니다.');
    return {...doc,id:crypto.randomUUID(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),history:(Array.isArray(source.history)?source.history:[]).slice(-20).map(entry=>({...cleanDocument(entry),at:typeof entry.at==='string'?entry.at:''})),file:null,fileName:null,cloud:cloud?{id:cloud.id,token:cloud.token,version:cloud.version,isPublic:cloud.isPublic===true,isAnonymous:cloud.isAnonymous!==false,includeRequirements:cloud.includeRequirements===true,authorName:typeof cloud.authorName==='string'?cloud.authorName.slice(0,40):''}:null};
  });
  const db=await database();
  await new Promise((resolve,reject)=>{const transaction=db.transaction('forms','readwrite');for(const doc of docs)transaction.objectStore('forms').put(doc);transaction.oncomplete=resolve;transaction.onabort=transaction.onerror=()=>reject(new Error('백업을 가져오지 못했습니다.'));});
  return docs.length;
}
export function backupDocument(forms) {
  return {format:'hanform-backup',version:1,exportedAt:new Date().toISOString(),forms:forms.map(item=>({...cleanDocument(item),history:item.history || [],cloud:item.cloud || null}))};
}
