import test from "node:test";
import assert from "node:assert/strict";
import { createApiHandler } from "../server.mjs";
import { POST } from "../api/index.mjs";
import { analyzeInputs } from "../settings-analyzer.mjs";
import { validateHwpx } from "../hwpx-validation.mjs";
import { previewModel, renderDocumentPreview } from "../document-preview.js";
import { checkUploadLimits, UPLOAD_LIMITS } from "../upload-limits.js";
import { timedRequest } from '../upload-limits.js';
import { versionWebAssets } from '../scripts/build-web.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const prompt = "A4 세로, 모든 여백 20mm, 글꼴 맑은 고딕, 본문 10pt, 줄 간격 160%. 필수 항목: 목적, 방법, 결과.";

test('one build versions HTML and every transitive browser module together',()=>{
 const sources=new Map([['index.html','<head></head><link href="styles.css"><script src="app.js"></script>'],['styles.css','body{}'],['app.js','import {x} from "./settings-model.js"; import "./library-ui.js";'],['settings-model.js','export const x=1;'],['library-ui.js',"import {x} from './settings-model.js';"]]);
 const built=versionWebAssets(sources);
 for(const name of ['index.html','app.js','library-ui.js'])assert(built.assets.get(name).includes('?v='+built.version));
 assert(built.assets.get('app.js').includes('./library-ui.js?v='+built.version));assert(built.assets.get('library-ui.js').includes('./settings-model.js?v='+built.version));
 const changed=new Map(sources);changed.set('settings-model.js','export const x=2;');const updated=versionWebAssets(changed);assert.notEqual(updated.version,built.version);assert(updated.assets.get('app.js').includes(updated.version));assert(!updated.assets.get('app.js').includes(built.version));
});

test('analysis button starts disabled and module startup has visible failure recovery',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');assert(/id="generate-button"[^>]*disabled/.test(html));
 const bootstrap=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1],events=new Map();let cleared=false;
 const form={dataset:{},addEventListener:(event,callback)=>events.set('form:'+event,callback)},notice={hidden:true};
 runInNewContext(bootstrap,{window:{addEventListener:(event,callback)=>events.set('window:'+event,callback)},document:{getElementById:id=>id==='template-form'?form:notice,addEventListener:(event,callback)=>events.set('document:'+event,callback)},setTimeout:()=>1,clearTimeout:()=>{cleared=true;}});
 let prevented=false;events.get('form:submit')({preventDefault(){prevented=true;}});assert(prevented,'An early click must never reload the page as a native form submission');
 events.get('window:error')();assert.equal(notice.hidden,false,'Module failures must have a visible recovery action');
 form.dataset.ready='true';events.get('document:hanform-ready')();assert.equal(notice.hidden,true);assert(cleared);
 events.get('window:error')();assert.equal(notice.hidden,true,'Unrelated errors after startup must not mislabel the screen as failed');
});

test('request timeout works without static AbortSignal helpers and cleans its timer',()=>{
 let callback,cleared=false;const timers={setTimeout(fn,delay){assert.equal(delay,1000);callback=fn;return 7;},clearTimeout(id){assert.equal(id,7);cleared=true;}};
 const request=timedRequest(1000,timers);assert.equal(request.signal.aborted,false);callback();assert.equal(request.signal.aborted,true);assert.equal(request.expired(),true);request.finish();assert(cleared);
 const cancelled=timedRequest(1000,timers);cancelled.controller.abort();assert.equal(cancelled.expired(),false);cancelled.finish();
});

function renderedPdf(pages) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const lines of pages){const stream='BT /F1 12 Tf 60 750 Td 18 TL '+lines.map((text,index)=>(index?'T* ':'')+`(${text}) Tj`).join(' ')+' ET';objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length+2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);}
  let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('final PDF checks count actual pages and bounded text lines, fail excess and leave missing headings unverified',async()=>{
 const {settings}=await analyzeInputs({prompt,files:[]},{env:{}});settings.requiredItems=['Abstract','Methods'];settings.limits={maxPages:1,titleMaxLines:1};settings.sectionStyles=[{item:'Abstract',maxLines:2}];
 const check=async(bytes,{web=false,title='Report'}={})=>{const data=new FormData();data.set('file',new Blob([bytes]),'completed.pdf');data.set('settings',JSON.stringify(settings));data.set('title',title);return (web?POST:createApiHandler())(new Request(web?'https://test.invalid/api/index?route=check-document':'https://test.invalid/api/check-document',{method:'POST',body:data}));};
 const passing=await check(renderedPdf([['Report','1. Abstract','First line','Second line','2. Methods','Body']]),{web:true});assert.equal(passing.status,200);const pass=await passing.json();assert.equal(pass.status,'pass');assert.deepEqual(pass.checks.map(c=>c.actual),[1,1,2]);
 const excess=await (await check(renderedPdf([['Report','1. Abstract','First','Second','Third','2. Methods','Body'],['Another page']]))).json();assert.equal(excess.status,'fail');assert.equal(excess.pages,2);assert.equal(excess.checks[2].actual,3);
 const missing=await (await check(renderedPdf([['Unknown title','Unlabelled content']]))).json();assert.equal(missing.status,'unverified');assert(missing.checks.some(c=>c.status==='unverified'));
 const damaged=await check(Buffer.from('%PDF-1.4 broken'));assert.equal(damaged.status,422);
 const invalidSettings=structuredClone(settings);settings.columns={count:2,gapMm:300};assert.equal((await check(renderedPdf([['Report']]))).status,422);Object.assign(settings,invalidSettings);
});
test("stateless generation works in fresh instances and the Vercel rewritten Web handler", async () => {
  const { settings } = await analyzeInputs({ prompt, files: [] }, { env: {} });
  const payload = JSON.stringify({ settings, confirmed: true, title: "배포 확인" });
  for (const handler of [createApiHandler(), createApiHandler(), POST]) {
    const path = handler === POST ? "/api/index?route=hwpx" : "/api/hwpx";
    const result = await handler(new Request(`https://test.invalid${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: payload }));
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.downloadUrl, undefined);
    assert((await validateHwpx(Buffer.from(body.fileBase64, "base64"))).passed);
  }
});
test("shared file limits reject aggregate oversize and oversized request bodies", async () => {
  assert.equal(checkUploadLimits([{ size: 1_750_000 }, { size: 1_750_000 }]), null);
  assert(checkUploadLimits([{ size: 1_750_000 }, { size: 1_750_001 }]));
  const response = await createApiHandler()(new Request("https://test.invalid/api/analyze", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: Buffer.alloc(UPLOAD_LIMITS.maxRequestBytes + 1) }));
  assert.equal(response.status, 413);
});
test("preview geometry, requested font and spacing follow the settings", async () => {
  const { settings } = await analyzeInputs({ prompt, files: [] }, { env: {} });
  settings.paper = { size: "A5", orientation: "landscape" };
  settings.fontSizePt = 13.5;
  const model = previewModel(settings, "수정한 제목");
  assert.equal(model.width, 210); assert.equal(model.height, 148);
  assert.equal(model.bodySize, 13.5); assert.equal(model.title, "수정한 제목");
  assert.equal(model.fontFamily,'맑은 고딕');assert.equal(model.lineSpacing,'1.6');
});
test("public document config no longer exposes account credentials even when old env values exist", async () => {
  const handler = createApiHandler({ analysisOptions: { env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SERVICE_ROLE_KEY: "secret-service" } } });
  const response = await handler(new Request("https://test.invalid/api/config"));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(Object.hasOwn(value, "supabase"), false);
  assert(!JSON.stringify(value).includes("sb_publishable_test"));
  assert(!JSON.stringify(value).includes("secret-service"));
});


test('requirements -> analysis API -> HWPX API -> preview renderer keeps the right column on the same sheet',async()=>{
 const handler=createApiHandler({analysisOptions:{env:{}}}),data=new FormData();
 data.set('requirements','A4 세로, 모든 여백 20mm, 글꼴 바탕체, 본문 10pt, 줄 간격 160%. 구성: Abstract → 서론 → 본론 → 결론 → 참고문헌\n본문 배치: 2단, 단 간격 7.04mm');
 const analysis=await (await handler(new Request('https://test.invalid/api/analyze',{method:'POST',body:data}))).json();
 const settings=analysis.analysis.settings;assert.equal(settings.columns.count,2);
 const response=await handler(new Request('https://test.invalid/api/hwpx',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({settings,title:'연구 보고서',confirmed:true})}));assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.renderPlan.pages.length,1);assert((await validateHwpx(Buffer.from(result.fileBase64,'base64'))).passed);
 // Exercise the real DOM writer without browser automation: inspect its output
 // positions rather than merely asserting the layout planner's own values.
 const doc={createElement(tag){return {tag,ownerDocument:doc,children:[],style:{setProperty(key,value){this[key]=value;}},dataset:{},attrs:{},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(key,value){this.attrs[key]=value;}};}};
 const root=doc.createElement('main');renderDocumentPreview(root,settings,'연구 보고서',{confirmed:true,renderPlan:result.renderPlan});
 const descendants=node=>[node,...node.children.filter(child=>typeof child==='object').flatMap(descendants)];
 const nodes=descendants(root),sheets=nodes.filter(n=>n.className==='preview-paper preview-planned-paper');assert.equal(sheets.length,1);
 const left=nodes.find(n=>n.textContent==='2. 서론'),right=nodes.find(n=>n.textContent==='4. 결론');
 assert(left&&right);assert.notEqual(left.style.left,right.style.left);assert.equal(left.style.top,right.style.top);
 assert(sheets[0].children.includes(left)&&sheets[0].children.includes(right));assert(nodes.some(n=>n.textContent==='생성 파일 기준'));
});
