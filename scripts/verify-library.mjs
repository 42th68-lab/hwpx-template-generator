import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import {validateHwpx,xmlParser,findElement} from '../hwpx-validation.mjs';
import JSZip from 'jszip';
const base=process.argv[2];assert(base && /^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(base),'Pass the approved deployment URL');
const checks=[],fixtures=[],marker='기능검사-'+randomUUID().slice(0,8);
const check=(condition,label)=>{assert(condition,label);checks.push(label);};
const settings={schemaVersion:1,paper:{size:'A4',orientation:'portrait'},marginsMm:{top:20,bottom:20,left:20,right:20},fontFamily:'맑은 고딕',fontSizePt:12,lineSpacing:{value:18.5,unit:'pt'},requiredItems:['목적','방법','결과'],documentOptions:{coverPage:true,contentsPage:true,tableItems:['방법']}};
const payload=(suffix)=>({title:marker+suffix,requirements:'공개하지 않을 비공개 입력',settings,publish:true,storageConsent:true,includeRequirements:false,isAnonymous:true,authorName:''});
async function api(input){const response=await fetch(new URL('/api/library',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});return{status:response.status,result:await response.json()};}
async function list(q){const url=new URL('/api/library',base);url.searchParams.set('q',q);const response=await fetch(url);assert.equal(response.status,200);return response.json();}
try{
  check((await api({op:'save',payload:{...payload('無'),storageConsent:false}})).status===422,'Online storage requires explicit action');
  for(const suffix of ['A','B']){const value=await api({op:'save',payload:payload(suffix)});check(value.status===200 && /^[a-f0-9]{64}$/.test(value.result.token),'Independent management capability '+suffix);fixtures.push(value.result);}
  const [a,b]=fixtures;
  let result=await list(marker);check(result.items.length===2,'Public search returns published templates');check(!JSON.stringify(result).includes(a.token) && !JSON.stringify(result).includes('manage_hash'),'Public search never exposes management credentials');
  check((await list(marker+'不存在')).items.length===0,'Search filters unrelated templates');
  const read=await api({op:'get',id:a.item.id});check(read.status===200 && read.result.item.isAnonymous && read.result.item.authorName==='','Anonymous publication hides author name');
  check(read.result.item.requirements==='','Private source requirements are not exposed in public metadata');
  check(result.items.every(item=>item.requirements==='' && !('history' in item)),'Public list hides private requirements and modification history');
  check((await api({op:'save',id:a.item.id,token:b.token,version:1,payload:payload('forbidden')})).status===403,'B cannot edit A');
  check((await api({op:'unpublish',id:a.item.id,token:b.token})).status===403,'B cannot unpublish A');
  check((await api({op:'delete',id:a.item.id,token:b.token})).status===403,'B cannot delete A');
  check((await api({op:'delete',id:a.item.id})).status===403,'Missing management capability cannot delete');
  const update=await api({op:'save',id:a.item.id,token:a.token,version:1,payload:{...payload('A 수정'),isAnonymous:false,authorName:'공개 시험 이름'}});
  check(update.status===200 && update.result.item.version===2 && update.result.item.authorName==='공개 시험 이름','Owner edits and named publication apply');
  const ownUpdated=await api({op:'get',id:a.item.id,token:a.token});
  check(ownUpdated.result.item.history.length===1 && ownUpdated.result.item.history[0].requirements===payload('A').requirements,'Owner cloud history retains the previous private conditions');
  check(!('history' in (await api({op:'get',id:a.item.id})).result.item),'Public detail never exposes modification history');
  check((await api({op:'save',id:a.item.id,token:a.token,version:1,payload:payload('stale')})).status===409,'Stale version cannot overwrite newer public form');
  const downloaded=await api({op:'download',id:a.item.id});const bytes=Buffer.from(downloaded.result.fileBase64,'base64');check(downloaded.status===200 && (await validateHwpx(bytes)).passed,'Public HWPX download passes package validation');
  const zip=await JSZip.loadAsync(bytes);const header=xmlParser.parse(await zip.file('Contents/header.xml').async('string'));const section=xmlParser.parse(await zip.file('Contents/section0.xml').async('string'));
  check(findElement(findElement(header,'paraPr','0').children,'lineSpacing').attributes['@_value']==='1850','Cloud generated HWPX applies requested fixed line spacing');
  check(Boolean(findElement(section,'tbl')),'Cloud generated HWPX includes writing table');
  check((await api({op:'unpublish',id:a.item.id,token:a.token})).status===200,'Owner can unpublish');
  check((await api({op:'get',id:a.item.id})).status===404,'Unpublished metadata hidden from other visitors');
  check((await api({op:'download',id:a.item.id})).status===404,'Unpublished file hidden from other visitors');
  check((await api({op:'get',id:a.item.id,token:b.token})).status===404,'Other capability cannot read private metadata');
  check((await api({op:'get',id:a.item.id,token:a.token})).status===200,'Owner retains private access after unpublishing');
  check(!(await list(marker)).items.some(item=>item.id===a.item.id),'Unpublished form removed from search');
  const privateSaved=await api({op:'save',payload:{...payload('비공개'),publish:false}});check(privateSaved.status===200 && !privateSaved.result.item.isPublic,'New online backup is private when publish is false');fixtures.push(privateSaved.result);
  check((await api({op:'get',id:privateSaved.result.item.id})).status===404,'New private backup cannot be read by other visitors');
  const ownPrivate=await api({op:'get',id:privateSaved.result.item.id,token:privateSaved.result.token});check(ownPrivate.result.item.requirements==='공개하지 않을 비공개 입력','Private online backup retains owner source requirements');
  check((await api({op:'download',id:privateSaved.result.item.id,token:b.token})).status===404,'Other capability cannot download a private backup');
  check((await api({op:'download',id:privateSaved.result.item.id,token:privateSaved.result.token})).status===200,'Private backup owner can download their stored file');
  const publishConditions=await api({op:'save',id:privateSaved.result.item.id,token:privateSaved.result.token,version:1,payload:{...payload('조건 공개'),includeRequirements:true}});
  check(publishConditions.status===200 && (await api({op:'get',id:privateSaved.result.item.id})).result.item.requirements===payload('').requirements,'Conditions are public only after explicit publication choice');
  try{loadEnvFile('.env');}catch{}
  if(process.env.SUPABASE_URL==='https://oealbssaoxeizrqosvzp.supabase.co'){
    const headers={apikey:process.env.SUPABASE_PUBLISHABLE_KEY};
    const raw=await fetch(process.env.SUPABASE_URL+'/rest/v1/guest_templates?select=id',{headers});check(!raw.ok,'Direct anonymous table access denied');
    const objects=await fetch(process.env.SUPABASE_URL+'/storage/v1/object/list/hanform-shared',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefix:'',limit:20})});const value=await objects.json();check(!objects.ok || (Array.isArray(value)&&value.length===0),'Direct anonymous Storage enumeration denied');
  }
  await mkdir('tmp',{recursive:true});await writeFile('tmp/library-shared-check.hwpx',bytes);
}finally{for(const item of fixtures){const result=await api({op:'delete',id:item.item.id,token:item.token});assert.equal(result.status,200,'Synthetic template cleanup');}}
const report={base,checkedAt:new Date().toISOString(),passed:true,checks,count:checks.length,syntheticTemplatesRemoved:true};
await writeFile('tmp/library-check-'+Date.now()+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
