import test from "node:test";
import assert from "node:assert/strict";
import { analyzeInputs, getAnalysisConfig } from "../settings-analyzer.mjs";
import { validateSettings, reconcileItemReferences, fieldLabel } from "../settings-model.js";

const complete = "A4 세로, 모든 여백 20mm, 글꼴 맑은 고딕, 본문 10pt, 줄 간격 160%. 필수 항목: 연구 목적, 방법, 결과, 결론.";
const analyze = (prompt, files = []) => analyzeInputs({ prompt, files }, { env: {} });

const publicationTable='| 항목 | 제출 규정 |\n| 언어 | 국문·영문 중 하나 선택 |\n| 전체 분량 | **참고문헌까지 포함하여 2쪽 이내** |\n| 구성 | 제목 → Abstract → 본문(서론·본론·결론) → 참고문헌 |\n| 제목 길이 | 2줄 이내 |\n| Abstract 길이 | 15줄 이내 |\n| 용지 | A4, 세로 |\n| 여백 | 위 30mm / 아래 25mm / 좌우 각 15mm |\n| 머리글·바닥글 위치 | 머리글 20mm / 바닥글 10mm |\n| 본문 배치 | **2단**, 단 사이 간격 약 7.04mm |\n| 글꼴 | 국문 **바탕체**, 영문 **Times New Roman** |\n| 줄 간격 | 1.0 |\n| 정렬 | 제목·Abstract는 왼쪽, 본문은 양쪽 정렬 |';

test('Markdown submission tables extract layout and limits while retaining genuine language and font-size choices',async()=>{
 const result=await analyze(publicationTable);
 assert.deepEqual(result.settings.paper,{size:'A4',orientation:'portrait'});
 assert.deepEqual(result.settings.marginsMm,{top:30,bottom:25,left:15,right:15});
 assert.deepEqual(result.settings.lineSpacing,{value:1,unit:'multiple'});
 assert.deepEqual(result.settings.requiredItems,['Abstract','서론','본론','결론','참고문헌']);
 assert.equal(result.settings.fontSizePt,null);assert.equal(result.settings.fontFamily,null);
 const choice=result.warnings.find(w=>w.type==='choice');assert.deepEqual(choice.candidates.map(c=>[c.choiceLabel,c.value]),[['국문','바탕체'],['영문','Times New Roman']]);
 assert(!result.warnings.some(w=>w.type==='unsupported'));
 assert.deepEqual(result.settings.columns,{count:2,scope:'body',gapMm:7.04});
 assert.deepEqual(result.settings.headerFooterMm,{header:20,footer:10});
 assert.deepEqual(result.settings.alignment,{title:'left',body:'justify'});
 assert.deepEqual(result.settings.limits,{maxPages:2,titleMaxLines:2});
 assert.deepEqual(result.settings.sectionStyles,[{item:'Abstract',maxLines:15,alignment:'left'}]);
 assert(result.warnings.some(w=>w.field==='lineSpacing'&&w.type==='unparsed'));assert(result.warnings.some(w=>w.field==='fontSizePt'&&w.type==='missing'));
 assert(!result.warnings.some(w=>w.field?.startsWith('marginsMm')&&w.type==='conflict'));
});

test('Markdown styling does not invalidate a genuine AI source quote or duplicate table interpretation',async()=>{
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[
  {field:'fontFamily',value:'국문 바탕체, 영문 Times New Roman',sourceId:'prompt',quote:'글꼴 국문 바탕체, 영문 Times New Roman',action:'include'},
  {field:'lineSpacing',value:'1pt',sourceId:'prompt',quote:'줄 간격 1.0',action:'include'},
  {field:'requiredItems',value:'제목',sourceId:'prompt',quote:'구성 제목 → Abstract → 본문(서론·본론·결론) → 참고문헌',action:'include'},
  {field:'marginsMm.top',value:'30mm',sourceId:'prompt',quote:'위 30mm / 아래 25mm / 좌우 각 15mm',action:'include'}
 ]})}]}}]};
 const result=await analyzeInputs({prompt:publicationTable,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json(response)});
 assert.equal(result.engine,'gemini');assert.equal(result.settings.marginsMm.top,30);assert.deepEqual(result.settings.lineSpacing,{value:1,unit:'multiple'});assert(!result.settings.requiredItems.includes('제목'));assert.equal(result.candidates.fontFamily.length,2);
 assert(!result.warnings.some(w=>w.message.includes('AI 제안')));
});

test('genuine conflicting Markdown rows stay conflicts and style-free quotes still validate',async()=>{
 const table='| 용지 | **A4**, 세로 |\n| 여백 | 위 20mm, 아래 25mm, 좌우 각 15mm |\n| 여백 | 위 30mm |';
 const result=await analyze(table);assert.equal(result.settings.marginsMm.top,null);assert(result.warnings.some(w=>w.type==='conflict'&&w.field==='marginsMm.top'));
 const ai=await analyzeInputs({prompt:'본문은 **열한 포인트**로 해 줘.',files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[{field:'fontSizePt',value:'11pt',sourceId:'prompt',quote:'본문은 열한 포인트로 해 줘.',action:'include'}]})}]}}]})});
 assert.equal(ai.settings.fontSizePt,11);assert(!ai.warnings.some(w=>w.type==='unparsed'));
});

test('different paper, units, fonts and composition work for tables, tab-separated text and field lists',async()=>{
 const rows=[['용지','A5, 가로'],['여백','위 2cm / 아래 15mm / 좌우 각 1cm'],['글꼴','Arial'],['본문 글자 크기','12pt'],['줄 간격','2.0'],['구성','목적 → 실험 → 결과']];
 for(const text of [rows.map(r=>'| '+r.join(' | ')+' |').join('\n'),rows.map(r=>r.join('\t')).join('\n'),rows.map(r=>r.join(': ')).join('\n')]){
  const r=await analyze(text);assert.deepEqual(r.settings.paper,{size:'A5',orientation:'landscape'});assert.deepEqual(r.settings.marginsMm,{top:20,bottom:15,left:10,right:10});assert.equal(r.settings.fontFamily,'Arial');assert.equal(r.settings.fontSizePt,12);assert.deepEqual(r.settings.requiredItems,['목적','실험','결과']);assert.deepEqual(r.settings.lineSpacing,{value:2,unit:'multiple'});
 }
});

test('layout and limits work for other values in ordinary prose and extracted attachment text',async()=>{
 const text='A4 세로, 모든 여백 20mm, 본문 12pt, 글꼴 바탕체, 줄 간격 150%. 본문을 3단으로 배치하고 단 간격 8mm로 한다. 머리글 12mm, 바닥글 8mm. 제목은 가운데 정렬. 전체 분량은 4쪽 이내.';
 for(const result of [await analyze(text),await analyze('',[{name:'다른_제출조건.pdf',text,truncated:false}])]){
  assert.equal(result.settings.paper.size,'A4');assert.equal(result.settings.fontSizePt,12);
  assert.equal(result.settings.columns.count,3);assert.equal(result.settings.columns.gapMm,8);
  assert.deepEqual(result.settings.headerFooterMm,{header:12,footer:8});assert.equal(result.settings.alignment.title,'center');assert.equal(result.settings.limits.maxPages,4);
  assert(!result.warnings.some(w=>w.type==='unsupported'));
 }
 const selected=await analyze(publicationTable.replace('국문·영문 중 하나 선택','영문'));assert.equal(selected.settings.fontFamily,'Times New Roman');assert(!selected.warnings.some(w=>w.type==='choice'));
});

test('mixed settings rows keep supported values while header-only sizes never become body sizes',async()=>{
 const mixed=await analyze('서식: A4 세로, 모든 여백 20mm, 본문 12pt, 글꼴 Arial, 줄 간격 150%, 양쪽 정렬');
 assert.equal(mixed.settings.fontSizePt,12);assert.equal(mixed.settings.fontFamily,'Arial');assert.equal(mixed.settings.alignment.body,'justify');
 const header=await analyze('머리글: 9pt\n바닥글: 8pt\n본문: 11pt');assert.equal(header.settings.fontSizePt,11);assert(!header.warnings.some(w=>w.field==='fontSizePt'&&w.type==='conflict'));
});

test('language choices preserve arbitrary font names rather than only the original sample fonts',async()=>{
 const r=await analyze('글꼴: 영문 Source Serif Pro, 국문 프리텐다드');
 assert.deepEqual(r.candidates.fontFamily.map(c=>[c.choiceLabel,c.value]),[['영문','Source Serif Pro'],['국문','프리텐다드']]);assert(r.warnings.some(w=>w.type==='choice'));
});

test('hybrid analysis handles verbal sizes and spacing without letting an invalid AI duplicate block explicit source facts',async()=>{
 const prompt='본문은 열두 포인트, 줄 간격은 한 줄 반으로 해 줘.';
 const result=await analyzeInputs({prompt,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[{field:'fontSizePt',value:'12pt',sourceId:'prompt',quote:'본문은 열두 포인트',action:'include'},{field:'lineSpacing',value:'1.5',sourceId:'prompt',quote:'줄 간격은 한 줄 반으로 해 줘.',action:'include'}]})}]}}]})});
 assert.equal(result.settings.fontSizePt,12);assert.deepEqual(result.settings.lineSpacing,{value:1.5,unit:'multiple'});
 assert(!result.warnings.some(w=>w.field==='lineSpacing'&&w.type==='unparsed'));
 const range=await analyze('줄 간격 한 줄 반 이상');assert.equal(range.settings.lineSpacing.value,null);assert(range.warnings.some(w=>w.type==='unparsed'));
});

test("complete Korean instructions produce six setting groups without invented values", async () => {
  const { settings, warnings } = await analyze(complete);
  assert.deepEqual(settings, {
    schemaVersion: 1, paper: { size: "A4", orientation: "portrait" },
    marginsMm: { top: 20, bottom: 20, left: 20, right: 20 },
    fontFamily: "맑은 고딕", fontSizePt: 10, lineSpacing: { value: 160, unit: "percent" },
    requiredItems: ["연구 목적", "방법", "결과", "결론"],
  });
  assert.equal(warnings.filter((warning) => warning.type !== "analysis").length, 0);
});

test("third-session example keeps all required items and warns about missing conditions", async () => {
  const result = await analyze("A4 크기의 탐구 보고서 양식을 만들어 줘. 본문은 10pt로 하고 연구 목적, 방법, 결과, 결론 항목을 넣어 줘.");
  assert.deepEqual(result.settings.requiredItems, ["연구 목적", "방법", "결과", "결론"]);
  assert.equal(result.settings.fontFamily, null);
  assert.equal(result.settings.lineSpacing.value, null);
  assert(result.warnings.some((warning) => warning.type === "missing" && warning.field === "fontFamily"));
});

test("directional margins do not become global margins and cm converts to mm", async () => {
  const result = await analyze("A4, 위 여백 20mm, 아래 여백 25mm, 왼쪽 여백 3cm, 오른쪽 여백 15mm. 줄 간격 1.6배");
  assert.deepEqual(result.settings.marginsMm, { top: 20, bottom: 25, left: 30, right: 15 });
  assert.deepEqual(result.settings.lineSpacing, { value: 1.6, unit: "multiple" });
  assert(!result.warnings.some((warning) => warning.type === "conflict"));
});

test("equal values from different documents are merged; contradictory values keep both sources", async () => {
  const result = await analyze(complete, [
    { name: "안내.pdf", text: "용지 A4, 본문 12pt, 필수 항목: 참고 문헌", truncated: false },
    { name: "안내.hwpx", text: "모든 여백 2cm, 본문 12pt", truncated: false },
  ]);
  assert.equal(result.settings.fontSizePt, null);
  const conflict = result.warnings.find((warning) => warning.type === "conflict" && warning.field === "fontSizePt");
  assert.deepEqual(conflict.candidates.map((item) => item.value), [10, 12]);
  assert.equal(conflict.candidates[1].evidence.length, 2);
  assert.equal(result.settings.marginsMm.left, 20);
  assert(result.settings.requiredItems.includes("참고 문헌"));
});

test("title and line-spacing point values are not mistaken for body font size", async () => {
  const result = await analyze("제목 16pt, 본문 10pt, 줄 간격 20pt");
  assert.equal(result.settings.fontSizePt, 10);
  assert.deepEqual(result.settings.lineSpacing, { value: 20, unit: "pt" });
  assert.equal(result.settings.typography.titleSizePt,16);
});

test("ranges, missing units and examples require manual review", async () => {
  const result = await analyze("글자 크기 10~12pt, 줄 간격 160, 여백 20. 예시: A4 본문 15pt");
  assert.equal(result.settings.paper.size, null);
  assert.equal(result.settings.fontSizePt, null);
  assert.equal(result.settings.lineSpacing.value, null);
  assert(result.warnings.filter((warning) => warning.type === "unparsed").length >= 3);
});

test("required/excluded item conflicts are visible", async () => {
  const result = await analyze("필수 항목: 서론, 결론. 결론은 제외");
  assert.deepEqual(result.settings.requiredItems, ["서론"]);
  assert(result.warnings.some((warning) => warning.type === "conflict" && warning.field === "requiredItems"));
});

test("editing must pass ranges, units and usable-page geometry", async () => {
  const { settings } = await analyze(complete);
  settings.marginsMm.left = 110;
  settings.marginsMm.right = 110;
  settings.fontSizePt = 0;
  settings.lineSpacing = { value: 160, unit: null };
  const errors = validateSettings(settings);
  assert(errors.some((warning) => warning.field === "marginsMm.left" && warning.type === "invalid"));
  assert(errors.some((warning) => warning.field === "fontSizePt" && warning.type === "invalid"));
  assert(errors.some((warning) => warning.field === "lineSpacing" && warning.type === "invalid"));
});

test("no key never makes an external request and exposes no secret config", async () => {
  const result = await analyzeInputs({ prompt: complete, files: [] }, { env: {}, fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.equal(result.engine, "rules");
  const config = getAnalysisConfig({ GEMINI_API_KEY: "private-key", GEMINI_MODEL: "chosen-model" });
  assert.equal(config.configured, true);
  assert(!JSON.stringify(config).includes("private-key"));
});

test("Gemini schema request validates citations and rejects hallucinated evidence", async () => {
  let request;
  const response = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ conditions: [
    { field: "fontFamily", value: "프리텐다드", sourceId: "prompt", quote: "글꼴은 프리텐다드로", action: "include" },
    { field: "fontSizePt", value: "14pt", sourceId: "prompt", quote: "본문 14pt", action: "include" },
  ] }) }] } }] };
  const result = await analyzeInputs({ prompt: "글꼴은 프리텐다드로", files: [] }, {
    env: { GEMINI_API_KEY: "mock-key" },
    fetchImpl: async (url, init) => { request = { url, init }; return Response.json(response); },
  });
  assert.equal(result.engine, "gemini");
  assert.equal(result.settings.fontFamily, "프리텐다드");
  assert.equal(result.settings.fontSizePt, null);
  assert.equal(request.init.headers["x-goog-api-key"], "mock-key");
  assert(JSON.parse(request.init.body).generationConfig.responseJsonSchema);
  assert.deepEqual(JSON.parse(request.init.body).generationConfig.thinkingConfig,{thinkingLevel:'low'});
  assert(result.warnings.some((warning) => warning.type === "unparsed"));
});

test('AI-only layout and arbitrary section settings retain units, evidence and conflicts',async()=>{
 const text='상부에 확보할 공간은 이 센티미터다. Results 전용 서식은 별도 규정과 같다.';
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[{field:'marginsMm.top',value:'2cm',sourceId:'prompt',quote:'상부에 확보할 공간은 이 센티미터다.',action:'include'},{field:'sectionStyles.Results.alignment',value:'right',sourceId:'prompt',quote:'Results 전용 서식은 별도 규정과 같다.',action:'include'}]})}]}}]};
 const result=await analyzeInputs({prompt:text,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json(response)});
 assert.equal(result.settings.marginsMm.top,20);assert.equal(result.settings.sectionStyles[0].alignment,'right');
 assert(result.warnings.some(w=>w.type==='invalid'&&w.field==='sectionStyles'),'A section style must not silently create an unrequested required item');
 const conflict=await analyze('구성: Results → Conclusion\nResults 정렬: 왼쪽 정렬\nResults 정렬: 오른쪽 정렬');assert(conflict.warnings.some(w=>w.type==='conflict'&&w.field==='sectionStyles.Results.alignment'));
});

test('URI-encoded AI path separators canonicalize without losing section-name dots',async()=>{
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[{field:'sectionStyles.Abstract%2EmaxLines',value:'15',sourceId:'prompt',quote:'Abstract 길이: 15줄 이내',action:'include'},{field:'sectionStyles%2EPart%2EOne%2Ealignment',value:'right',sourceId:'prompt',quote:'Part.One 정렬: 오른쪽 정렬',action:'include'}]})}]}}]};
 const r=await analyzeInputs({prompt:'구성: Abstract → Part.One\nAbstract 길이: 15줄 이내\nPart.One 정렬: 오른쪽 정렬',files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json(response)});
 assert.equal(r.engine,'gemini');assert.equal(r.settings.sectionStyles.find(s=>s.item==='Abstract').maxLines,15);assert.equal(r.settings.sectionStyles.find(s=>s.item==='Part.One').alignment,'right');assert(!r.warnings.some(w=>w.type==='unparsed'));
});

test('AI document-role aliases and case variants merge into existing settings instead of inventing sections',async()=>{
 const prompt='구성: Abstract → Results\n정렬: 제목·Abstract는 왼쪽, 본문은 양쪽 정렬\n제목 길이: 2줄 이내';
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[{field:'sectionStyles.제목.alignment',value:'left',sourceId:'prompt',quote:'제목·Abstract는 왼쪽',action:'include'},{field:'sectionStyles.Title.maxLines',value:'2',sourceId:'prompt',quote:'제목 길이: 2줄 이내',action:'include'},{field:'sectionStyles.abstract.alignment',value:'left',sourceId:'prompt',quote:'제목·Abstract는 왼쪽',action:'include'},{field:'sectionStyles.Body.alignment',value:'justify',sourceId:'prompt',quote:'본문은 양쪽 정렬',action:'include'}]})}]}}]};
 const r=await analyzeInputs({prompt,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json(response)});
 assert.deepEqual(r.settings.alignment,{title:'left',body:'justify'});assert.equal(r.settings.limits.titleMaxLines,2);assert.deepEqual(r.settings.sectionStyles,[{item:'Abstract',alignment:'left'}]);assert(!r.warnings.some(w=>['invalid','conflict','unparsed'].includes(w.type)));
});

test("API errors fall back explicitly without leaking key or raw provider messages", async () => {
  const result = await analyzeInputs({ prompt: complete, files: [] }, {
    env: { GEMINI_API_KEY: "private-key" }, fetchImpl: async () => new Response("private provider detail", { status: 429 }),
  });
  assert.equal(result.engine, "rules");
  assert.equal(result.settings.paper.size, "A4");
  assert(result.warnings.some((warning) => warning.message.includes("할당량")));
  assert(!JSON.stringify(result).includes("private"));
  assert.equal(result.warnings.find(w=>w.type==='analysis').code,'API_429');
});

test('older Gemini models do not receive unsupported thinking levels',async()=>{
  let config;
  const result=await analyzeInputs({prompt:complete,files:[]},{env:{GEMINI_API_KEY:'mock-key',GEMINI_MODEL:'gemini-2.5-flash'},fetchImpl:async(url,init)=>{config=JSON.parse(init.body).generationConfig;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"conditions":[]}'}]}}]});}});
  assert.equal(result.engine,'gemini');assert.equal(config.thinkingConfig,undefined);
});

test('provider key errors are classified without exposing the original provider message',async()=>{
 const result=await analyzeInputs({prompt:complete,files:[]},{env:{GEMINI_API_KEY:'private-key'},fetchImpl:async()=>Response.json({error:{message:'API key not valid: private-key',details:[{reason:'API_KEY_INVALID'}]}},{status:400})});
 assert.equal(result.warnings.find(w=>w.type==='analysis').code,'API_400_KEY_INVALID');assert(!JSON.stringify(result).includes('private-key'));
});

test('invalid request options retry in compatible JSON mode within the same request budget',async()=>{
 const configs=[];
 const result=await analyzeInputs({prompt:complete,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async(url,init)=>{
  configs.push(JSON.parse(init.body).generationConfig);
  return configs.length<3?Response.json({error:{status:'INVALID_ARGUMENT',message:'Request contains an invalid argument.'}},{status:400}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"conditions":[]}'}]}}]});
 }});
 assert.equal(result.engine,'gemini');assert.equal(configs.length,3);assert(configs[0].thinkingConfig);assert.equal(configs[1].thinkingConfig,undefined);assert(configs[1].responseJsonSchema);assert.equal(configs[2].responseJsonSchema,undefined);assert.equal(configs[2].responseMimeType,'application/json');
});

test('invalid key responses never trigger request-option retries',async()=>{
 let calls=0;const result=await analyzeInputs({prompt:complete,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>{calls++;return Response.json({error:{status:'INVALID_ARGUMENT',message:'Request contains an invalid argument.',details:[{reason:'API_KEY_INVALID'}]}},{status:400});}});
 assert.equal(result.engine,'rules');assert.equal(calls,1);assert.equal(result.warnings.find(w=>w.type==='analysis').code,'API_400_KEY_INVALID');
});

test('Gemini timeout is actionable and arbitrary exception details are never returned',async()=>{
  const timeout=await analyzeInputs({prompt:complete,files:[]},{env:{GEMINI_API_KEY:'private-key'},fetchImpl:async()=>{throw new DOMException('private provider detail','TimeoutError');}});
  assert.equal(timeout.engine,'rules');assert.equal(timeout.warnings.find(w=>w.type==='analysis').code,'TIMEOUT');
  assert(timeout.warnings.some(w=>w.message.includes('응답 시간')));assert(!JSON.stringify(timeout).includes('private'));
  const unknown=await analyzeInputs({prompt:complete,files:[]},{env:{GEMINI_API_KEY:'private-key'},fetchImpl:async()=>{throw Error('private-key and private request contents');}});
  assert.equal(unknown.warnings.find(w=>w.type==='analysis').code,'CONNECTION');assert(!JSON.stringify(unknown).includes('private'));
});

test("truncated file input is disclosed", async () => {
  const result = await analyze("A4", [{ name: "긴문서.pdf", text: "본문 10pt", truncated: true }]);
  assert(result.warnings.some((warning) => warning.message.includes("앞 10만 자")));
});

test("ordinary prose containing 바탕으로 is not a font condition", async () => {
  const result = await analyze("입력한 조건을 바탕으로 보고서를 만들어 줘.");
  assert.equal(result.settings.fontFamily, null);
});


test('role-specific typography overrides whole-document defaults for prose and attached source text',async()=>{
 const prompt='A4 세로, 여백 20mm, 글꼴 맑은 고딕, 전체 글자 크기 11pt, 줄 간격 160%. 필수 항목: 목적, 방법, 결과. 제목 16pt, 소제목 12pt. 전체 왼쪽 정렬. 제목은 가운데 정렬. 표지와 목차를 추가해 줘. 방법은 표로 만들어 줘. 항목 번호 없이. 문서 제목은 "실험 보고서".';
 for(const r of [await analyze(prompt),await analyze('',[{name:'안내.hwpx',text:prompt,truncated:false}])]){
  assert.equal(r.settings.documentTitle,'실험 보고서');assert.equal(r.settings.fontSizePt,11);assert.deepEqual(r.settings.typography,{titleSizePt:16,headingSizePt:12});
  assert.deepEqual(r.settings.alignment,{body:'left',heading:'left',title:'center'});assert.deepEqual(r.settings.requiredItems,['목적','방법','결과']);
  assert.deepEqual(r.settings.documentOptions,{coverPage:true,contentsPage:true,tableItems:['방법'],numberedItems:false});
  assert(!r.warnings.some(w=>['conflict','unparsed','invalid','unsupported'].includes(w.type)));
 }
});

test('arbitrary named item sizes and contradictory role sizes retain source scope and conflicts',async()=>{
 const r=await analyze('구성: Summary → Findings\n본문 11pt. 제목 17pt. Summary 글자 크기: 9pt. Findings 13pt.');
 assert.equal(r.settings.fontSizePt,11);assert.equal(r.settings.typography.titleSizePt,17);
 assert.equal(r.settings.sectionStyles.find(s=>s.item==='Summary').fontSizePt,9);assert.equal(r.settings.sectionStyles.find(s=>s.item==='Findings').fontSizePt,13);
 const r2=await analyze('제목 16pt',[{name:'규정.pdf',text:'제목 18pt',truncated:false}]);assert.equal(r2.settings.typography?.titleSizePt,undefined);assert(r2.warnings.some(w=>w.type==='conflict'&&w.field==='typography.titleSizePt'));
});

test('options apply only to their explicit subjects; negatives and attached conflicts are not silently discarded',async()=>{
 const r=await analyze(complete+' 표지 제외. 목차 추가. 방법은 표로 작성. 결과는 표로 작성하지 마.');
 assert.deepEqual(r.settings.documentOptions,{coverPage:false,contentsPage:true,tableItems:['방법']});assert(!r.settings.requiredItems.includes('목차'));
 const conflict=await analyze('표지 추가',[{name:'안내.pdf',text:'표지 제외',truncated:false}]);assert(conflict.warnings.some(w=>w.type==='conflict'&&w.field==='documentOptions.coverPage'));
 const examples=await analyze(complete,[{name:'설명.pdf',text:'입력한 조건을 처리하는 방법을 표로 정리하는 서비스다.',truncated:false}]);assert.equal(examples.settings.documentOptions,undefined);
});

test('unmapped AI conditions require grounded evidence and unsupported formatting is surfaced',async()=>{
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[],unhandled:[{sourceId:'prompt',quote:'기관 로고를 삽입해 줘',reason:'이미지 삽입은 지원하지 않음'},{sourceId:'prompt',quote:'없는 지시',reason:'가짜 조건'}]})}]}}]};
 const r=await analyzeInputs({prompt:complete+' 기관 로고를 삽입해 줘.',files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json(response)});
 assert(r.warnings.some(w=>w.type==='unsupported'&&w.details.some(d=>d.quote==='기관 로고를 삽입해 줘')));assert(!JSON.stringify(r).includes('가짜 조건'));
 const table=await analyze(complete+' 방법은 5행 4열 표로 만들어 줘.');assert(table.warnings.some(w=>w.type==='unsupported'&&w.details.some(d=>d.reason.includes('행·열'))));
});


test('AI cannot turn document roles into duplicate required items in a mixed prose composition list',async()=>{
 const prompt='A4 세로, 머리글 20mm 바닥글 10mm, 글꼴 바탕체, 본문 10pt. 구성: 제목 → Abstract → 본문(서론·본론·결론) → 참고문헌';
 const response={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions:[{field:'requiredItems',value:'제목',sourceId:'prompt',quote:'구성: 제목 → Abstract → 본문(서론·본론·결론) → 참고문헌',action:'include'},{field:'requiredItems',value:'본문',sourceId:'prompt',quote:'본문(서론·본론·결론)',action:'include'}]})}]}}]};
 const r=await analyzeInputs({prompt,files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json(response)});
 assert.deepEqual(r.settings.requiredItems,['Abstract','서론','본론','결론','참고문헌']);assert(!r.warnings.some(w=>w.type==='unsupported'));
});


test('Unicode ranges and unit-free alternatives never become a guessed single font size',async()=>{
 for(const range of ['10–12pt','10—12pt','10±1pt','10부터 12pt','10 또는 12pt']){const r=await analyze('본문 '+range);assert.equal(r.settings.fontSizePt,null,range);assert(r.warnings.some(w=>w.type==='unparsed'));}
});

test('changing required items removes orphan table, column-start and section-style references',async()=>{
 const {settings}=await analyze(complete);Object.assign(settings,{documentOptions:{coverPage:false,contentsPage:false,tableItems:['방법','결과']},columns:{count:2,startItem:'방법'},sectionStyles:[{item:'방법',fontSizePt:13},{item:'결과',alignment:'right'}]});
 settings.requiredItems=['연구 목적','결과'];reconcileItemReferences(settings);
 assert.deepEqual(settings.documentOptions.tableItems,['결과']);assert.equal(settings.columns.startItem,null);assert.deepEqual(settings.sectionStyles,[{item:'결과',alignment:'right'}]);assert.deepEqual(validateSettings(settings),[]);
});

test('invalid JSON settings types and prototype-like AI fields do not crash validation',async()=>{
 for(const value of [null,42,[],{schemaVersion:1,paper:{size:{toString:42}},fontFamily:42,lineSpacing:{unit:{toString:42}},requiredItems:{},columns:{startItem:'x'},alignment:{title:{toString:42}},sectionStyles:[{item:'x',alignment:{toString:42}}]}])assert(validateSettings(value).length>0);
 assert.equal(fieldLabel('__proto__'),undefined);assert.equal(fieldLabel('toString'),undefined);
 const conditions=[null,{field:'__proto__',value:'bad',sourceId:'prompt',quote:'글꼴 프리텐다드',action:'include'},{field:'fontFamily',value:'프리텐다드',sourceId:'prompt',quote:'글꼴 프리텐다드',action:'include'}];
 const r=await analyzeInputs({prompt:'글꼴 프리텐다드',files:[]},{env:{GEMINI_API_KEY:'mock-key'},fetchImpl:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({conditions})}]}}]})});
 assert.equal(r.engine,'gemini');assert.equal(r.settings.fontFamily,'프리텐다드');assert(r.warnings.some(w=>w.code==='INVALID_CONDITION'));
});
