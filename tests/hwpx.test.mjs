import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { generateHwpx, mmToHwpUnit, normalizeGenerationInput } from "../hwpx-generator.mjs";
import { elements, findElement, validateHwpx, xmlParser } from "../hwpx-validation.mjs";
import { buildDocumentPlan, DOCUMENT_LAYOUT_VERSION } from "../settings-model.js";
import { createAppServer } from "../server.mjs";

const input = () => ({ confirmed: true, title: "탐구 보고서", settings: {
  schemaVersion: 1, paper: { size: "A4", orientation: "portrait" },
  marginsMm: { top: 25, bottom: 20, left: 30, right: 15 },
  fontFamily: "맑은 고딕", fontSizePt: 12.5,
  lineSpacing: { value: 180, unit: "percent" }, requiredItems: ["연구 목적", "방법", "결과", "결론"],
} });
const readDocument = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const section = xmlParser.parse(await zip.file("Contents/section0.xml").async("string"));
  const header = xmlParser.parse(await zip.file("Contents/header.xml").async("string"));
  const texts = [...elements(section)].filter((element) => element.localName === "t").map((element) => element.children.map((part) => part["#text"] ?? "").join(""));
  return { zip, section, header, texts };
};

test("trusted report template passes checks without changing the source", async () => {
  const original = await readFile(new URL("../assets/hwpx/basic-report.hwpx", import.meta.url));
  assert((await validateHwpx(original, { changed: false })).passed);
  await generateHwpx(input());
  assert.deepEqual(await readFile(new URL("../assets/hwpx/basic-report.hwpx", import.meta.url)), original);
});

test("stages separately apply title, items, body size and page layout", async () => {
  const title = await readDocument((await generateHwpx(input(), { stage: "title" })).buffer);
  assert(title.texts.includes("탐구 보고서"));
  assert(title.texts.includes("{{본문 내용}}"));
  assert.equal(findElement(title.header, "charPr", "0").attributes["@_height"], "1000");
  const items = await readDocument((await generateHwpx(input(), { stage: "items" })).buffer);
  assert.deepEqual(items.texts.filter((text) => /^\d+\./.test(text)), ["1. 연구 목적", "2. 방법", "3. 결과", "4. 결론"]);
  assert(!items.texts.some((text) => text.includes("{{")));
  assert.equal(findElement(items.header, "charPr", "0").attributes["@_height"], "1000");
  const size = await readDocument((await generateHwpx(input(), { stage: "font-size" })).buffer);
  assert.equal(findElement(size.header, "charPr", "0").attributes["@_height"], "1250");
  assert.equal(findElement(size.header, "charPr", "7").attributes["@_height"], "2000");
  assert.equal(findElement(size.header, "charPr", "8").attributes["@_height"], "1400");
  const layout = await readDocument((await generateHwpx(input())).buffer);
  assert.deepEqual(layout.texts.filter(text=>text.trim()),[input().title,...input().settings.requiredItems.map((item,index)=>`${index+1}. ${item}`)]);
  assert(!(await layout.zip.file('Preview/PrvText.txt').async('string')).includes('각 항목 아래에 내용을 작성하세요.'));
  const page = findElement(layout.section, "pagePr");
  assert.equal(page.attributes["@_width"], String(mmToHwpUnit(210)));
  assert.equal(page.attributes["@_height"], String(mmToHwpUnit(297)));
  assert.equal(page.attributes["@_landscape"], "WIDELY");
  for (const [side, value] of Object.entries(input().settings.marginsMm)) assert.equal(findElement(page.children, "margin").attributes[`@_${side}`], String(mmToHwpUnit(value)));
  assert(findElement(layout.section, "secPr"));
  assert(findElement(layout.section, "colPr"));
  assert(!findElement(layout.section, "linesegarray"));
  assert(!layout.zip.file("Preview/PrvImage.png"));
});

test("font references and both spacing branches use the requested font and all supported spacing units", async () => {
  for (const [spacing,type,value] of [[{value:180,unit:'percent'},'PERCENT','180'],[{value:1.7,unit:'multiple'},'PERCENT','170'],[{value:18.5,unit:'pt'},'FIXED','1850']]) {
    const payload=input();payload.settings.lineSpacing=spacing;
    const result=await generateHwpx(payload);
    assert.deepEqual(result.unsupportedSettings,[]);
    const {header}=await readDocument(result.buffer);
    const faces=[...elements(header)].filter(item=>item.localName==='fontface');
    for(const face of faces)assert([...elements(face.children)].some(item=>item.localName==='font'&&item.attributes['@_face']==='맑은 고딕'));
    for(const ref of [...elements(header)].filter(item=>item.localName==='fontRef'))for(const [lang,id] of Object.entries(ref.attributes)){const face=faces.find(item=>item.attributes['@_lang'].toLowerCase()===lang.slice(2));assert([...elements(face.children)].some(item=>item.localName==='font'&&item.attributes['@_id']===id&&item.attributes['@_face']==='맑은 고딕'));}
    const lines=[...elements(findElement(header,'paraPr','0').children)].filter(item=>item.localName==='lineSpacing');
    assert.equal(lines.length,2);for(const line of lines){assert.equal(line.attributes['@_type'],type);assert.equal(line.attributes['@_value'],value);}
  }
});

test("landscape keeps base dimensions and sets the correct rotation flag", async () => {
  const payload = input();
  payload.settings.paper = { size: "A5", orientation: "landscape" };
  const { section } = await readDocument((await generateHwpx(payload)).buffer);
  const page = findElement(section, "pagePr").attributes;
  assert.equal(page["@_landscape"], "NARROWLY");
  assert.equal(page["@_width"], String(mmToHwpUnit(148)));
  assert.equal(page["@_height"], String(mmToHwpUnit(210)));
});

test('advanced settings change actual XML, column-sized tables, section-specific styles and embedded constraints',async()=>{
  const payload=input();
  payload.settings.requiredItems=['요약','방법','결과'];
  Object.assign(payload.settings,{headerFooterMm:{header:18,footer:9},columns:{count:3,gapMm:5.5,scope:'body',startItem:'방법'},alignment:{title:'right',body:'justify'},limits:{maxPages:4,titleMaxLines:3},sectionStyles:[{item:'요약',alignment:'left',maxLines:12,fontSizePt:11}],documentOptions:{coverPage:true,contentsPage:true,tableItems:['방법']}});
  const result=await generateHwpx(payload),{section,header,zip}=await readDocument(result.buffer);
  const margin=findElement(section,'margin').attributes;assert.equal(margin['@_header'],String(mmToHwpUnit(18)));assert.equal(margin['@_footer'],String(mmToHwpUnit(9)));
  const columns=[...elements(section)].filter(e=>e.localName==='colPr');assert.deepEqual(columns.map(e=>e.attributes['@_colCount']),['1','1','1','3']);assert.equal(columns.at(-1).attributes['@_sameGap'],String(mmToHwpUnit(5.5)));
  const paragraphFor=text=>[...elements(section)].findLast(e=>e.localName==='p'&&[...elements(e.children)].some(t=>t.localName==='t'&&t.children.some(n=>n['#text']===text)));
  const alignment=p=>findElement(findElement(header,'paraPr',p.attributes['@_paraPrIDRef']).children,'align').attributes['@_horizontal'];
  assert.equal(alignment(paragraphFor('탐구 보고서')),'RIGHT');assert.equal(alignment(paragraphFor('1. 요약')),'LEFT');assert.equal(alignment(paragraphFor('2. 방법')),'JUSTIFY');
  assert(findElement(paragraphFor('2. 방법').children,'colPr'));
  const run=findElement(paragraphFor('1. 요약').children,'run');assert.equal(findElement(header,'charPr',run.attributes['@_charPrIDRef']).attributes['@_height'],'1100');
  const table=findElement(section,'tbl'),width=Number(findElement(table.children,'sz').attributes['@_width']);assert.equal(width,mmToHwpUnit((210-30-15-2*5.5)/3));
  const metadata=xmlParser.parse(await zip.file('Contents/content.hpf').async('string')),constraints=[...elements(metadata)].find(e=>e.localName==='meta'&&e.attributes['@_name']==='HanformConstraints');
  assert.deepEqual(JSON.parse(constraints.children[0]['#text']),{limits:{maxPages:4,titleMaxLines:3},sections:[{item:'요약',maxLines:12}]});
  assert.equal(result.constraintChecks.pageCountVerified,false);assert.deepEqual(result.appliedSettings.columns,{count:3,gapMm:5.5,scope:'body',startItem:'방법'});
  const edited=structuredClone(payload);edited.settings.columns={count:2,gapMm:9,scope:'document'};edited.settings.headerFooterMm.header=22;
  const changed=await readDocument((await generateHwpx(edited)).buffer);assert.equal([...elements(changed.section)].find(e=>e.localName==='colPr'&&e.attributes['@_colCount']==='2').attributes['@_sameGap'],String(mmToHwpUnit(9)));assert.equal(findElement(changed.section,'margin').attributes['@_header'],String(mmToHwpUnit(22)));
});

test('invalid advanced settings and unusable column geometry are rejected',()=>{
 for(const change of [s=>s.columns={count:9},s=>s.columns={count:3,gapMm:100},s=>s.headerFooterMm={header:-1},s=>s.alignment={body:'sideways'},s=>s.limits={maxPages:2.5},s=>s.sectionStyles=[{item:'방법',maxLines:-1}],s=>s.sectionStyles=[{item:'없는 항목',alignment:'left'}]]){const payload=input();change(payload.settings);assert.throws(()=>normalizeGenerationInput(payload));}
});

test("user XML characters are escaped and preserved, and filenames are safe", async () => {
  const payload = input();
  payload.title = "<연구 & 결과> / 양식";
  payload.settings.requiredItems = ["<script> & 연구", "😀 결과"];
  const result = await generateHwpx(payload);
  const { texts } = await readDocument(result.buffer);
  assert(texts.includes(payload.title));
  assert(texts.includes("1. <script> & 연구"));
  assert(!/[<>:/\\]/.test(result.fileName));
  payload.title = "CON";
  assert.equal((await generateHwpx(payload)).fileName, "양식_CON.hwpx");
});

test("missing confirmation, schema, values, invalid geometry and control characters are rejected", () => {
  for (const mutate of [
    (payload) => { payload.confirmed = false; },
    (payload) => { payload.settings.schemaVersion = 2; },
    (payload) => { payload.settings.fontSizePt = null; },
    (payload) => { payload.settings.requiredItems = [123]; },
    (payload) => { payload.settings.marginsMm.left = 150; payload.settings.marginsMm.right = 150; },
    (payload) => { payload.title = "줄\n바꿈"; },
    (payload) => { payload.title = "불가\x01"; },
  ]) {
    const payload = input(); mutate(payload);
    assert.throws(() => normalizeGenerationInput(payload));
  }
});

test("missing orientation defaults to portrait with a warning", async () => {
  const payload = input(); payload.settings.paper.orientation = null;
  const result = await generateHwpx(payload);
  assert.equal(result.appliedSettings.paper.orientation, "portrait");
  assert(result.warnings.some((warning) => warning.includes("미지정")));
});

test("validator rejects missing package targets, style references and stale layout caches", async () => {
  const { buffer } = await generateHwpx(input());
  for (const change of [
    async (zip) => zip.remove("Contents/header.xml"),
    async (zip) => zip.file("Contents/section0.xml", (await zip.file("Contents/section0.xml").async("string")).replace('charPrIDRef="0"', 'charPrIDRef="999"')),
    async (zip) => zip.file("Contents/section0.xml", (await zip.file("Contents/section0.xml").async("string")).replace("</hp:p>", "<hp:linesegarray/></hp:p>")),
  ]) {
    const zip = await JSZip.loadAsync(buffer); await change(zip);
    await assert.rejects(validateHwpx(await zip.generateAsync({ type: "nodebuffer" })));
  }
});

test("HTTP creates a real HWPX attachment, validates inputs and isolates unknown downloads", async (context) => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, type = "application/json") => fetch(`${base}/api/hwpx`, { method: "POST", headers: { "Content-Type": type }, body });
  assert.equal((await post(JSON.stringify(input()), "text/plain")).status, 415);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(JSON.stringify({ ...input(), confirmed: false }))).status, 422);
  assert.equal((await post("x".repeat(70_000))).status, 413);
  const response = await post(JSON.stringify(input()));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert(result.validation.passed);
  assert.equal(result.downloadUrl, undefined);
  assert.equal(result.expiresAt, undefined);
  assert.equal(result.contentType, "application/hwp+zip");
  const bytes = Buffer.from(result.fileBase64, "base64");
  assert((await validateHwpx(bytes)).passed);
  assert.equal((await fetch(`${base}/api/hwpx/download/../../server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/hwpx-generator.mjs`)).status, 404);
});


test('preview plan and generated paragraphs share pages, columns, visible text and character styles across formats',async()=>{
  for(const variant of ['plain','columns','table','landscape','long','many','fixed']){
    const payload=input(),s=payload.settings;
    if(variant==='columns')Object.assign(s,{columns:{count:2,gapMm:7.04,scope:'body',startItem:'방법'},headerFooterMm:{header:20,footer:10}});
    if(variant==='table')Object.assign(s,{documentOptions:{coverPage:true,contentsPage:true,tableItems:['방법']},sectionStyles:[{item:'방법',fontSizePt:18,alignment:'left'}]});
    if(variant==='landscape')s.paper={size:'A5',orientation:'landscape'};
    if(variant==='long'){s.paper={size:'A5',orientation:'portrait'};s.requiredItems=['긴 항목 제목과 연구 주제의 배경을 설명하는 문장을 사용한 경우의 줄바꿈 확인','Methods and experimental observations'];}
    if(variant==='many'){s.requiredItems=Array.from({length:40},(_,i)=>`항목 ${i+1}`);s.columns={count:2,gapMm:6,scope:'document'};}
    if(variant==='fixed')s.lineSpacing={unit:'pt',value:24};
    const result=await generateHwpx(payload),plan=buildDocumentPlan(normalizeGenerationInput(payload).settings,payload.title);
    assert.equal(result.layoutVersion,DOCUMENT_LAYOUT_VERSION);assert.deepEqual(result.renderPlan,plan);
    const {section,header}=await readDocument(result.buffer);
    const native=findElement(section,'sec').children.filter(n=>n['hp:p']);
    assert.equal(native.length,plan.paragraphs.length,'No invisible leading paragraph or extra body paragraphs');
    const controls=[...elements(section)].filter(e=>e.localName==='secPr');assert.equal(controls.length,1);
    assert(findElement(findElement([native[0]],'run').children,'secPr'));
    for(const [index,block] of plan.paragraphs.entries()){
      const p=findElement([native[index]],'p');
      assert.equal(p.attributes['@_pageBreak'],block.pageBreak?'1':'0');assert.equal(p.attributes['@_columnBreak'],block.columnBreak?'1':'0');
      if(block.type==='paragraph'){
        assert.equal(findElement(p.children,'t').children.map(n=>n['#text'] ?? '').join(''),block.text);
        const run=findElement(p.children,'run'),char=findElement(header,'charPr',run.attributes['@_charPrIDRef']);
        assert.equal(Number(char.attributes['@_height'])/100,block.fontSizePt);assert.equal(Boolean(findElement([char.node],'bold')),block.bold);
      }else{
        const tbl=findElement(p.children,'tbl'),sz=findElement(tbl.children,'sz').attributes;
        assert.equal(Number(sz['@_width']),Math.round(block.width*100));assert.equal(Number(sz['@_height']),Math.round(block.height*100));
        const host=findElement(header,'paraPr',p.attributes['@_paraPrIDRef']);for(const line of [...elements([host.node])].filter(e=>e.localName==='lineSpacing'))assert.equal(Number(line.attributes['@_value']),Math.round(block.height*100));
      }
      assert(block.y>=plan.bodyTop);assert(block.y+block.height<=plan.bodyBottom+0.01);
    }
    if(variant==='many'){assert(plan.pages.length>1);assert(plan.paragraphs.some(b=>b.columnBreak));}
    if(variant==='columns'){assert.equal(plan.bodyTop,mmToHwpUnit(25)/100+mmToHwpUnit(20)/100);assert.equal(plan.pages[0].blocks.at(-1).column,1,'A short blank form must expose the requested right-hand column');}
    if(variant==='long')assert(plan.paragraphs.filter(b=>b.role==='heading').length>s.requiredItems.length);
  }
});

test('layout rejects content groups taller than the page rather than previewing clipped content',async()=>{
 const payload=input();payload.settings.paper={size:'A5',orientation:'landscape'};payload.settings.fontSizePt=100;payload.settings.lineSpacing={unit:'multiple',value:5};
 await assert.rejects(()=>generateHwpx(payload),/작성 영역/);
});


test('narrow table headers wrap in both the page plan and native cells, and unusable header widths fail',async()=>{
 const payload=input();Object.assign(payload.settings,{paper:{size:'A5',orientation:'portrait'},marginsMm:{top:15,bottom:15,left:10,right:10},requiredItems:['방법'],columns:{count:3,gapMm:6,scope:'document'},documentOptions:{coverPage:false,contentsPage:false,tableItems:['방법']},sectionStyles:[{item:'방법',fontSizePt:18}]});
 const result=await generateHwpx(payload),block=result.renderPlan.paragraphs.find(b=>b.type==='table');
 assert.equal(block.rows[0][0],'구\n분');assert(block.rowHeight>=18*1.8*2+4);
 const {section}=await readDocument(result.buffer),row=findElement(findElement(section,'tbl').children,'tr'),cell=findElement(row.children,'tc');
 assert.deepEqual([...elements(cell.children)].filter(e=>e.localName==='t').map(e=>e.children.map(n=>n['#text']??'').join('')),['구','분']);
 payload.settings.sectionStyles[0].fontSizePt=80;await assert.rejects(()=>generateHwpx(payload),/너비|단 너비/);
});


test('publication requirements produce side-by-side body items on one page with matching HWPX column breaks',async()=>{
 const payload=input();Object.assign(payload.settings,{marginsMm:{top:30,bottom:25,left:15,right:15},fontFamily:'바탕체',fontSizePt:10,lineSpacing:{value:1,unit:'multiple'},requiredItems:['Abstract','서론','본론','결론','참고문헌'],columns:{count:2,gapMm:7.04,scope:'body'},alignment:{title:'left',body:'justify'},sectionStyles:[{item:'Abstract',alignment:'left',maxLines:15}],headerFooterMm:{header:20,footer:10}});
 const result=await generateHwpx(payload),plan=result.renderPlan;
 assert.equal(plan.pages.length,1);const headings=plan.paragraphs.filter(b=>b.role==='heading');
 assert.equal(headings[0].columnCount,1,'Abstract stays above the body columns');
 assert.deepEqual(headings.slice(1).map(b=>[b.item,b.column]),[['서론',0],['본론',0],['결론',1],['참고문헌',1]]);
 assert.equal(headings[1].y,headings[3].y,'Both columns start at the same height');
 assert(headings[0].y>plan.paragraphs[0].y+plan.paragraphs[0].height,'Title has breathing room');
 assert(plan.paragraphs.filter(b=>b.item==='본론'&&b.role==='body').length>2,'Body has editable writing space');
 assert(plan.paragraphs.every(b=>b.y+b.height<=plan.bodyBottom+0.01));
 assert(Math.abs(headings[3].x-headings[1].x-headings[1].width-mmToHwpUnit(7.04)/100)<0.001);
 const {section}=await readDocument(result.buffer),paras=findElement(section,'sec').children.filter(n=>n['hp:p']);
 const rightStart=plan.paragraphs.findIndex(b=>b.item==='결론');assert.equal(paras[rightStart][':@']['@_columnBreak'],'1');
 assert.equal(paras[rightStart][':@']['@_pageBreak'],'0','The right-hand column belongs to the same page');
 for(const item of payload.settings.requiredItems){const blocks=plan.paragraphs.filter(b=>b.item===item);assert.equal(new Set(blocks.map(b=>b.page+':'+b.column)).size,1,'Writing areas stay with their heading');}
 payload.settings.sectionStyles[0].maxLines=1;
 const limited=await generateHwpx(payload);
 assert.equal(limited.renderPlan.paragraphs.filter(b=>b.item==='Abstract'&&b.role==='body').length,1);
});

test('balanced multi-column forms preserve order and stay inside the page for unequal tables and additional pages',async()=>{
 for(const count of [2,3,4]){
  const payload=input();Object.assign(payload.settings,{requiredItems:Array.from({length:23},(_,i)=>`항목 ${i+1}`),columns:{count,gapMm:4,scope:'document'},documentOptions:{coverPage:true,contentsPage:true,tableItems:['항목 2','항목 6','항목 12']}});
  const result=await generateHwpx(payload),plan=result.renderPlan;assert.deepEqual(plan.warnings,[]);
  assert.deepEqual(plan.paragraphs.filter(b=>b.role==='heading').map(b=>b.item),payload.settings.requiredItems);
  for(const page of plan.pages.filter(p=>p.kind==='body')){
   assert(new Set(page.blocks.map(b=>b.column)).size>1);
   for(const b of page.blocks){assert(b.y>=plan.bodyTop);assert(b.y+b.height<=plan.bodyBottom+0.01);}
  }
  for(const name of payload.settings.documentOptions.tableItems){const blocks=plan.paragraphs.filter(b=>b.item===name);assert.equal(new Set(blocks.map(b=>b.page+':'+b.column)).size,1);}
 }
});


test('an explicitly edited title replaces the analyzed title in both preview plan and applied settings',async()=>{
 const payload=input();payload.settings.documentTitle='원래 제목';payload.title='수정 제목';const result=await generateHwpx(payload);
 assert.equal(result.appliedSettings.documentTitle,'수정 제목');assert.equal(result.renderPlan.title,'수정 제목');
});
