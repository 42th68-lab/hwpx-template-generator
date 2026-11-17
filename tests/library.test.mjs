import {checkedCloudState} from '../library-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {cleanDocument,backupDocument,saveForm,getForm,allForms,importBackup,attachGeneratedFile,setCloud} from '../template-store.js';
import {schoolTemplateSettings,SCHOOL_TEMPLATES,reconcileItemReferences,savedDocumentTitle,DOCUMENT_LAYOUT_VERSION} from '../settings-model.js';
import {generateHwpx} from '../hwpx-generator.mjs';
import {elements,findElement,xmlParser} from '../hwpx-validation.mjs';
import {createLibraryHandler} from '../supabase/functions/guest-library/handler.mjs';
const document=()=>({title:'기능 검사',requirements:'공개하지 않을 개인 입력',settings:{schemaVersion:1,paper:{size:'A4',orientation:'portrait'},marginsMm:{top:20,bottom:20,left:20,right:20},fontFamily:'맑은 고딕',fontSizePt:12,lineSpacing:{value:180,unit:'percent'},requiredItems:['목적','방법','결과'],documentOptions:{coverPage:true,contentsPage:true,tableItems:['방법']}}});

// Exercise the persistence code with asynchronous IDB requests and cloned records.
// Real IndexedDB and the controls are checked separately in the browser.
const memoryRows=new Map();
globalThis.indexedDB={open(){
 const request={};
 const db={createObjectStore(){},transaction(){
   let pending=0,finished=false;
   const transaction={abort(){if(finished)return;finished=true;queueMicrotask(()=>transaction.onabort?.());},objectStore(){return store;}};
   const enqueue=action=>{
     pending++;const result={};
     queueMicrotask(()=>{
       if(finished)return;
       try {result.result=structuredClone(action());result.onsuccess?.();}
       catch {transaction.abort();}
       pending--;queueMicrotask(()=>{if(!pending&&!finished){finished=true;transaction.oncomplete?.();}});
     });
     return result;
   };
   const store={
     get:id=>enqueue(()=>memoryRows.get(id)),
     getAll:()=>enqueue(()=>[...memoryRows.values()]),
     put:value=>enqueue(()=>{memoryRows.set(value.id,structuredClone(value));return value.id;}),
     delete:id=>enqueue(()=>memoryRows.delete(id)),
   };
   return transaction;
 }};
 queueMicrotask(()=>{request.result=db;request.onupgradeneeded?.();request.onsuccess?.();});
 return request;
}};

test('each school template retains ordered figures through save, load, copy and JSON backup/import',async()=>{
 memoryRows.clear();
 for(const template of SCHOOL_TEMPLATES){
   const settings=schoolTemplateSettings(template.id),[first,second]=settings.requiredItems;
   settings.figures=[{item:first,kind:'figure',caption:'장치',heightMm:35},{item:second,kind:'graph',caption:'측정값',heightMm:40}];
   settings.requiredItems.reverse();settings.fontSizePt=12;
   const original=await saveForm({title:template.name,requirements:'',settings});
   assert.deepEqual((await getForm(original.id)).settings.figures,settings.figures);
   const copy=await saveForm({...original,id:undefined,title:original.title+' 복사본',settings:{...original.settings,documentTitle:savedDocumentTitle(original)}});
   assert.notEqual(copy.id,original.id);assert.equal(copy.cloud,null);
   const backup=JSON.parse(JSON.stringify(backupDocument([copy])));
   assert.equal(await importBackup(backup),1);
   const restored=(await allForms()).find(item=>item.id!==copy.id&&item.id!==original.id&&item.title===copy.title);
   assert.deepEqual(restored.settings.figures,settings.figures);
   assert.deepEqual(restored.settings.requiredItems,settings.requiredItems);assert.equal(restored.file,null);
   const generated=await generateHwpx({settings:restored.settings,title:savedDocumentTitle(restored),confirmed:true});
   assert.equal(generated.renderPlan.title,template.name);
   assert.deepEqual(generated.renderPlan.paragraphs.filter(b=>b.role==='caption').map(b=>b.text),['그림 1. 측정값','그림 2. 장치']);
   restored.settings.requiredItems=restored.settings.requiredItems.filter(item=>item!==second);reconcileItemReferences(restored.settings);
   const updated=await saveForm(restored);assert.equal(updated.settings.figures.length,1);
   assert.deepEqual((await getForm(original.id)).settings,original.settings,'Editing a copy cannot change its source');
 }
});

test('regenerated downloads preserve newer settings and current cloud metadata atomically',async()=>{
 const original=await saveForm(document());
 const next={...original,settings:structuredClone(original.settings)};
 next.settings.fontSizePt=13;await saveForm(next);
 const file={file:new Blob(['test HWPX']),fileName:'test.hwpx',fileLayoutVersion:DOCUMENT_LAYOUT_VERSION};
 await assert.rejects(()=>attachGeneratedFile(original,file),/변경/);
 assert.equal((await getForm(original.id)).settings.fontSizePt,13);
 const current=await getForm(original.id);await setCloud(current.id,{id:'cloud-test',version:2});
 const attached=await attachGeneratedFile(current,file);
 assert.equal(attached.cloud.version,2);assert.equal(attached.updatedAt,current.updatedAt);
 assert.equal(attached.file.size,file.file.size);
});

test('legacy schema-one backups without figure or title options still load and regenerate',async()=>{
 const old=document();delete old.settings.documentOptions;
 await importBackup({format:'hanform-backup',version:1,forms:[old]});
 const restored=(await allForms()).find(item=>item.title===old.title&&item.settings.documentOptions==null);
 assert.equal(restored.settings.figures,undefined);
 const generated=await generateHwpx({settings:restored.settings,title:savedDocumentTitle(restored),confirmed:true});
 assert(generated.validation.passed);assert(!generated.renderPlan.paragraphs.some(b=>b.role==='figure'));
 assert.throws(()=>cleanDocument({...old,settings:null}),/문서 설정/);
});
test('cover, generated contents list and writing table preserve unique IDs and correct table geometry',async()=>{
 const doc=document();const result=await generateHwpx({...doc,confirmed:true});const zip=await JSZip.loadAsync(result.buffer);const section=xmlParser.parse(await zip.file('Contents/section0.xml').async('string'));
 const paragraphs=[...elements(section)].filter(e=>e.localName==='p');assert.equal(new Set(paragraphs.map(e=>e.attributes['@_id'])).size,paragraphs.length);
 const pageBreaks=paragraphs.filter(e=>e.attributes['@_pageBreak']==='1');assert.equal(pageBreaks.length,2);
 const table=findElement(section,'tbl');assert.equal(table.attributes['@_rowCnt'],'3');assert.equal(table.attributes['@_colCnt'],'2');assert.equal([...elements(table.children)].filter(e=>e.localName==='tc').length,6);
 const width=Number(findElement(table.children,'sz').attributes['@_width']);const firstRow=findElement(table.children,'tr');const widths=[...elements(firstRow.children)].filter(e=>e.localName==='cellSz').map(e=>Number(e.attributes['@_width']));assert.equal(widths.reduce((a,b)=>a+b,0),width);
 const texts=[...elements(section)].filter(e=>e.localName==='t').flatMap(e=>e.children.map(n=>n['#text']||''));for(const text of ['작성자:','소속:','작성일:','목차','구분','내용'])assert(texts.includes(text));
});
test('portable settings strip ownership on public copies but private backups retain management information',()=>{
 const source={...document(),cloud:{id:'test',token:'private-management-key'},history:[]};assert.equal(cleanDocument(source).cloud,undefined);assert.equal(backupDocument([source]).forms[0].cloud.token,'private-management-key');
 assert.throws(()=>cleanDocument({...source,settings:{...source.settings,fontFamily:42}}));
 assert.throws(()=>cleanDocument({...source,settings:{...source.settings,documentOptions:{coverPage:false,contentsPage:false,tableItems:['없는 항목']}}}));
 const reordered={...source,settings:{...source.settings,marginsMm:{right:20,left:20,bottom:20,top:20},lineSpacing:{unit:'percent',value:180},documentOptions:{tableItems:['방법'],contentsPage:true,coverPage:true}}};
 assert.equal(JSON.stringify(cleanDocument(reordered)),JSON.stringify(cleanDocument(source)),'Property order alone must not create another modification');
});

test('local backups preserve canonical advanced settings and discard unknown nested data',()=>{
 const doc=document();Object.assign(doc.settings,{figures:[{item:'결과',kind:'graph',caption:'측정값',heightMm:40,unknown:'discard'}],headerFooterMm:{footer:10,header:20,unknown:'discard'},columns:{scope:'body',count:2,gapMm:7.04},alignment:{title:'left',body:'justify'},limits:{maxPages:2,titleMaxLines:2},sectionStyles:[{item:'목적',alignment:'left',maxLines:15,fontSizePt:11,unknown:'discard'}]});
 const clean=cleanDocument(doc),backup=backupDocument([doc]);assert.deepEqual(backup.forms[0].settings,clean.settings);assert.equal(clean.settings.headerFooterMm.unknown,undefined);assert.equal(clean.settings.sectionStyles[0].unknown,undefined);assert.equal(clean.settings.columns.count,2);assert.equal(clean.settings.sectionStyles[0].maxLines,15);
 assert.deepEqual(clean.settings.figures,[{item:'결과',kind:'graph',caption:'측정값',heightMm:40}]);
});
test('sharing handler rejects missing credentials, oversized payloads and malformed IDs before touching privileged data',async()=>{
 let calls=0;const handler=createLibraryHandler({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEYS:'{"default":"server-secret"}',SUPABASE_PUBLISHABLE_KEYS:'{"default":"public-key"}'},fetchImpl:async()=>{calls++;return Response.json([]);}});
 const request=(body,key='public-key')=>new Request('https://test.invalid',{method:'POST',headers:{apikey:key,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await handler(request({op:'list'},'wrong'))).status,401);
 assert.equal((await handler(request({op:'get',id:'../private'}))).status,422);
 assert.equal((await handler(request({op:'save',junk:'a'.repeat(66000)}))).status,413);
 assert.equal(calls,0);
 const response=await handler(request({op:'list'}));assert.equal(response.status,200);assert.equal((await response.json()).items.length,0);assert.equal(calls,1);
});

test('cloud save canonicalizes advanced settings through generated output without dropping them',async()=>{
 const doc=document();doc.settings.documentOptions.numberedItems=false;Object.assign(doc.settings,{documentTitle:doc.title,typography:{titleSizePt:17,headingSizePt:12},columns:{count:2,gapMm:7.04,scope:'body'},headerFooterMm:{header:20,footer:10},alignment:{title:'left',body:'justify'},limits:{maxPages:2,titleMaxLines:2},sectionStyles:[{item:'목적',alignment:'right',maxLines:8}]});
 const bodyTitle=doc.settings.documentTitle;doc.title+=' 복사본';
 doc.settings.figures=[{item:'결과',kind:'graph',caption:'결과 비교',heightMm:40}];
 let stored,uploaded=false;
 const handler=createLibraryHandler({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEYS:'{"default":"server-secret"}',SUPABASE_PUBLISHABLE_KEYS:'{"default":"public-key"}'},fetchImpl:async(url,init)=>{
  if(url==='https://hanform.vercel.app/api/hwpx'){const {buffer,...result}=await generateHwpx(JSON.parse(init.body));return Response.json({...result,fileBase64:buffer.toString('base64')});}
  if(url.includes('select=id&limit=1'))return new Response('[]',{headers:{'content-range':'*/0','content-type':'application/json'}});
  if(url.includes('/storage/v1/object/')){uploaded=true;return Response.json({});}
  if(init.method==='POST'&&url.endsWith('/rest/v1/guest_templates')){stored=JSON.parse(init.body);return Response.json([stored]);}
  throw Error('Unexpected mock request');
 }});
 const response=await handler(new Request('https://test.invalid',{method:'POST',headers:{apikey:'public-key'},body:JSON.stringify({op:'save',payload:{...doc,storageConsent:true,publish:false,authorName:'',isAnonymous:true}})}));
 assert.equal(response.status,200);const result=await response.json();assert(uploaded);assert.equal(result.item.settings.columns.gapMm,7.04);assert.equal(stored.settings.headerFooterMm.header,20);assert.equal(stored.settings.sectionStyles[0].maxLines,8);assert.equal(stored.settings.typography.titleSizePt,17);assert.equal(stored.settings.documentTitle,bodyTitle);assert.equal(stored.title,doc.title);assert.equal(stored.settings.documentOptions.numberedItems,false);assert.equal(stored.is_public,false);assert.equal(stored.manage_hash.length,64);assert.notEqual(stored.manage_hash,result.token);
 assert.deepEqual(stored.settings.figures,doc.settings.figures);
});


test('opening sharing controls cannot silently acknowledge a newer remote version',()=>{
 const local={id:'id',token:'local-management',version:1,isPublic:false};
 assert.throws(()=>checkedCloudState(local,{version:2,isPublic:true}),/최신본/);assert.equal(local.version,1);
 assert.deepEqual(checkedCloudState(local,{version:1,isPublic:true}),{...local,isPublic:true});
});

test('private cloud ownership and stale-write guards run before file generation or mutation',async()=>{
 const management='a'.repeat(64),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(management)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const row={id:'11111111-1111-4111-8111-111111111111',is_public:false,manage_hash:hash,version:3,title:'private',requirements:'private input',settings:document().settings,history:[]};let mutations=0;
 const handler=createLibraryHandler({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEYS:'{"default":"server-secret"}',SUPABASE_PUBLISHABLE_KEYS:'{"default":"public-key"}'},fetchImpl:async(url,init)=>{if(init.method!=='GET'){mutations++;throw Error('Unexpected mutation');}return Response.json([row]);}});
 const call=async(op,token,version)=>handler(new Request('https://test.invalid',{method:'POST',headers:{apikey:'public-key'},body:JSON.stringify({op,id:row.id,token,version})}));
 assert.equal((await call('get')).status,404);assert.equal((await call('get','b'.repeat(64))).status,404);assert.equal((await call('get',management)).status,200);
 assert.equal((await call('save','b'.repeat(64),3)).status,403);assert.equal((await call('delete','b'.repeat(64))).status,403);assert.equal((await call('save',management,2)).status,409);assert.equal(mutations,0);
});
