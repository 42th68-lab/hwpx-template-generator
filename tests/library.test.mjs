import {checkedCloudState} from '../library-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {cleanDocument,backupDocument} from '../template-store.js';
import {generateHwpx} from '../hwpx-generator.mjs';
import {elements,findElement,xmlParser} from '../hwpx-validation.mjs';
import {createLibraryHandler} from '../supabase/functions/guest-library/handler.mjs';
const document=()=>({title:'기능 검사',requirements:'공개하지 않을 개인 입력',settings:{schemaVersion:1,paper:{size:'A4',orientation:'portrait'},marginsMm:{top:20,bottom:20,left:20,right:20},fontFamily:'맑은 고딕',fontSizePt:12,lineSpacing:{value:180,unit:'percent'},requiredItems:['목적','방법','결과'],documentOptions:{coverPage:true,contentsPage:true,tableItems:['방법']}}});
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
 const doc=document();Object.assign(doc.settings,{headerFooterMm:{footer:10,header:20,unknown:'discard'},columns:{scope:'body',count:2,gapMm:7.04},alignment:{title:'left',body:'justify'},limits:{maxPages:2,titleMaxLines:2},sectionStyles:[{item:'목적',alignment:'left',maxLines:15,fontSizePt:11,unknown:'discard'}]});
 const clean=cleanDocument(doc),backup=backupDocument([doc]);assert.deepEqual(backup.forms[0].settings,clean.settings);assert.equal(clean.settings.headerFooterMm.unknown,undefined);assert.equal(clean.settings.sectionStyles[0].unknown,undefined);assert.equal(clean.settings.columns.count,2);assert.equal(clean.settings.sectionStyles[0].maxLines,15);
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
 let stored,uploaded=false;
 const handler=createLibraryHandler({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEYS:'{"default":"server-secret"}',SUPABASE_PUBLISHABLE_KEYS:'{"default":"public-key"}'},fetchImpl:async(url,init)=>{
  if(url==='https://hanform.vercel.app/api/hwpx'){const {buffer,...result}=await generateHwpx(JSON.parse(init.body));return Response.json({...result,fileBase64:buffer.toString('base64')});}
  if(url.includes('select=id&limit=1'))return new Response('[]',{headers:{'content-range':'*/0','content-type':'application/json'}});
  if(url.includes('/storage/v1/object/')){uploaded=true;return Response.json({});}
  if(init.method==='POST'&&url.endsWith('/rest/v1/guest_templates')){stored=JSON.parse(init.body);return Response.json([stored]);}
  throw Error('Unexpected mock request');
 }});
 const response=await handler(new Request('https://test.invalid',{method:'POST',headers:{apikey:'public-key'},body:JSON.stringify({op:'save',payload:{...doc,storageConsent:true,publish:false,authorName:'',isAnonymous:true}})}));
 assert.equal(response.status,200);const result=await response.json();assert(uploaded);assert.equal(result.item.settings.columns.gapMm,7.04);assert.equal(stored.settings.headerFooterMm.header,20);assert.equal(stored.settings.sectionStyles[0].maxLines,8);assert.equal(stored.settings.typography.titleSizePt,17);assert.equal(stored.settings.documentTitle,doc.title);assert.equal(stored.settings.documentOptions.numberedItems,false);assert.equal(stored.is_public,false);assert.equal(stored.manage_hash.length,64);assert.notEqual(stored.manage_hash,result.token);
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
