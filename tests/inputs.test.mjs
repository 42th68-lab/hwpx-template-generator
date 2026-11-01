import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { XMLBuilder } from "fast-xml-parser";
import { readFile } from "node:fs/promises";
import { createAppServer } from "../server.mjs";
import { generateHwpx, mmToHwpUnit } from "../hwpx-generator.mjs";
import { findElement, elements, validateHwpx, xmlParser } from "../hwpx-validation.mjs";
import { analyzeInputs } from "../settings-analyzer.mjs";

export const completePrompt = "A4 세로, 모든 여백 20mm, 글꼴 맑은 고딕, 본문 10pt, 줄 간격 160%. 필수 항목: 연구 목적, 방법, 결과, 결론.";
const analyzed = async (prompt) => (await analyzeInputs({ prompt, files: [] }, { env: {} })).settings;
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, suppressEmptyNode: true });
async function conditionDocument(contents=completePrompt) {
  const { buffer } = await generateHwpx({ settings: await analyzed(completePrompt), confirmed: true, title: "제출 안내" });
  const zip = await JSZip.loadAsync(buffer);
  const section = xmlParser.parse(await zip.file("Contents/section0.xml").async("string"));
  const text = [...elements(section)].find((element) => element.localName === "t" && element.children.some((part) => part["#text"] === "제출 안내"));
  text.node[text.name] = [{ "#text": contents }];
  zip.file("Contents/section0.xml", builder.build(section));
  return zip.generateAsync({ type: "nodebuffer" });
}
async function harness(context) {
  const server = createAppServer({ analysisOptions: { env: {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async analyze(prompt = "", files = []) {
      const data = new FormData(); data.set("requirements", prompt);
      for (const { name, bytes } of files) data.append("files", new Blob([bytes]), name);
      const response = await fetch(base + "/api/analyze", { method: "POST", body: data });
      return { status: response.status, result: await response.json() };
    },
    async generate(settings, title = "검증 양식") {
      const response = await fetch(base + "/api/hwpx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings, title, confirmed: true }) });
      const result = await response.json();
      if (!response.ok) return { status: response.status, result };
      assert.equal(result.downloadUrl, undefined);
      return { status: response.status, result, bytes: Buffer.from(result.fileBase64, "base64") };
    },
  };
}

test("natural-language HTTP analysis -> user edits -> downloaded HWPX contains edited values", async (context) => {
  const app = await harness(context);
  const { status, result } = await app.analyze(completePrompt);
  assert.equal(status, 200);
  assert.deepEqual(result.analysis.settings, await analyzed(completePrompt));
  const edited = structuredClone(result.analysis.settings);
  edited.paper = { size: "A5", orientation: "landscape" };
  edited.fontSizePt = 13.5;
  edited.marginsMm = { top: 15, bottom: 18, left: 22, right: 25 };
  edited.requiredItems = ["수정한 연구 목적", "방법", "결과", "참고 문헌"];
  const output = await app.generate(edited, "수정값 확인 & 보고서");
  assert.equal(output.status, 200);
  assert((await validateHwpx(output.bytes)).passed);
  const zip = await JSZip.loadAsync(output.bytes);
  const section = xmlParser.parse(await zip.file("Contents/section0.xml").async("string"));
  const header = xmlParser.parse(await zip.file("Contents/header.xml").async("string"));
  const page = findElement(section, "pagePr");
  assert.equal(page.attributes["@_width"], String(mmToHwpUnit(148)));
  assert.equal(page.attributes["@_height"], String(mmToHwpUnit(210)));
  assert.equal(page.attributes["@_landscape"], "NARROWLY");
  for (const [side, value] of Object.entries(edited.marginsMm)) assert.equal(findElement(page.children, "margin").attributes[`@_${side}`], String(mmToHwpUnit(value)));
  assert.equal(findElement(header, "charPr", "0").attributes["@_height"], "1350");
  const texts = [...elements(section)].filter((element) => element.localName === "t").map((element) => element.children.map((node) => node["#text"] ?? "").join(""));
  assert(texts.includes("수정값 확인 & 보고서"));
  assert.deepEqual(texts.filter((text) => /^\d+\./.test(text)), edited.requiredItems.map((item, index) => `${index + 1}. ${item}`));
  assert.equal(output.result.validation.layoutVerified, false);
});

test("real project PDF and HWPX produce the same missing settings, without inventing example headings", async (context) => {
  const app = await harness(context);
  const results = [];
  for (const extension of ["pdf", "hwpx"]) {
    let bytes;
    try { bytes = await readFile(new URL(`../etc/계획서(2413 전재현).${extension}`, import.meta.url)); }
    catch (error) { if (error.code === "ENOENT") { context.skip("Private real materials are optional; run test:real locally to verify them."); return; } throw error; }
    const { status, result } = await app.analyze("", [{ name: `계획서.${extension}`, bytes }]);
    assert.equal(status, 200);
    assert(result.files[0].text.includes("프로젝트 계획서"));
    assert(result.files[0].text.length > 3000);
    assert.deepEqual(result.analysis.settings.requiredItems, []);
    assert.equal(result.analysis.settings.paper.size, null);
    assert.equal(result.analysis.settings.fontSizePt, null);
    assert(result.analysis.warnings.some((warning) => warning.type === "missing" && warning.field === "requiredItems"));
    results.push(result.analysis.settings);
    const combined = await app.analyze(completePrompt, [{ name: `계획서.${extension}`, bytes }]);
    assert.deepEqual(combined.result.analysis.settings, await analyzed(completePrompt));
  }
  assert.deepEqual(results[0], results[1]);
});

test("an actual condition HWPX attachment alone yields complete settings; conflicting user values are warned", async (context) => {
  const app = await harness(context);
  const bytes = await conditionDocument();
  const { result, status } = await app.analyze("", [{ name: "제출 안내.hwpx", bytes }]);
  assert.equal(status, 200);
  assert.deepEqual(result.analysis.settings, await analyzed(completePrompt));
  const conflict = await app.analyze("본문 12pt", [{ name: "제출 안내.hwpx", bytes }]);
  assert.equal(conflict.result.analysis.settings.fontSizePt, null);
  const warning = conflict.result.analysis.warnings.find((warning) => warning.field === "fontSizePt" && warning.type === "conflict");
  assert.deepEqual(warning.candidates.map((candidate) => candidate.value), [12, 10]);
});

test("missing or invalid conditions block generation, rather than silently using defaults", async (context) => {
  const app = await harness(context);
  for (const prompt of ["A4 양식", "본문 -10pt, 모든 여백 -20mm, 줄 간격 -160%", "A4, 여백 150mm, 본문 500pt, 줄 간격 900%", "본문 10~12pt, 여백 20~30mm, 줄 간격 140~160%", ""]) {
    const analysis = await app.analyze(prompt);
    if (!prompt) { assert.equal(analysis.status, 422); continue; }
    assert(analysis.result.analysis.warnings.some((warning) => ["missing", "invalid", "unparsed"].includes(warning.type)));
    const generation = await app.generate(analysis.result.analysis.settings);
    assert.equal(generation.status, 422);
  }
});

test("truncated, false-format, missing-member, bad XML and CRC-damaged files are rejected", async (context) => {
  const app = await harness(context);
  const bytes = await conditionDocument();
  const invalid = [{ name: "내용.pdf", bytes: Buffer.from("%PDF-1.7\nnot a document") }, { name: "내용.hwpx", bytes: bytes.subarray(0, 90) }];
  for (const change of [
    async (zip) => zip.remove("Contents/header.xml"),
    async (zip) => zip.file("Contents/section0.xml", "<sec><p>broken"),
    async (zip) => zip.file("Contents/section0.xml", "<hello><p><t>A4 본문 10pt</t></p></hello>"),
    async (zip) => zip.file("Contents/section0.xml", '<!DOCTYPE sec [<!ENTITY bad "A4">]><sec><p><t>&bad;</t></p></sec>'),
    async (zip) => zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="missing.hpf"/></rootfiles></container>'),
  ]) {
    const zip = await JSZip.loadAsync(bytes); await change(zip);
    invalid.push({ name: "손상.hwpx", bytes: await zip.generateAsync({ type: "nodebuffer" }) });
  }
  const crc = Buffer.from(bytes);
  const directory = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  crc[directory + 16] ^= 1;
  invalid.push({ name: "CRC.hwpx", bytes: crc });
  for (const file of invalid) {
    const { status, result } = await app.analyze("", [file]);
    assert.equal(status, 422, file.name);
    assert.equal(typeof result.error, "string");
    assert.equal(result.analysis, undefined);
  }
  assert.equal((await app.analyze("", [{ name: "binary.hwp", bytes }])).status, 422);
  assert.equal((await app.analyze("", [{ name: "large.hwpx", bytes: Buffer.alloc(3_500_001) }])).status, 422);
  assert.equal((await app.analyze("", Array.from({ length: 4 }, () => ({ name: "file.hwpx", bytes })))).status, 422);
});

test("multi-line and numbered item lists preserve 결과 and do not accept punctuation as an item", async () => {
  for (const list of ["연구 목적\n방법\n결과\n결론", "1. 연구 목적\n2. 방법\n3. 결과\n4. 결론", "- 연구 목적\n- 방법\n- 결과\n- 결론"]) {
    assert.deepEqual((await analyzed(`필수 항목:\n${list}`)).requiredItems, ["연구 목적", "방법", "결과", "결론"]);
  }
  assert.deepEqual((await analyzed("필수 항목:")).requiredItems, []);
  assert.deepEqual((await analyzed("용지 크기, 줄 간격, 필수 항목 등의 설정을 보여 준다. 목차와 같은 항목으로 구분한다.")).requiredItems, []);
});

test("ranges with units on both ends and upper/lower limits remain unconfirmed for every numeric group", async () => {
  for (const prompt of ["본문 10pt~12pt, 여백 20mm~30mm, 줄 간격 140%~160%", "본문 10pt 이상, 모든 여백 20mm 이하, 줄 간격 160% 이하", "최대 본문 10pt, 최소 여백 20mm, 최대 줄 간격 160%", "본문 ≤10pt, 여백 ≥20mm, 줄 간격 <160%"]) {
    const result = await analyzeInputs({ prompt, files: [] }, { env: {} });
    assert.equal(result.settings.fontSizePt, null, prompt);
    assert.deepEqual(Object.values(result.settings.marginsMm), [null, null, null, null], prompt);
    assert.equal(result.settings.lineSpacing.value, null, prompt);
    assert(result.warnings.some(({ type }) => type === "unparsed"));
  }
});


test('attached HWPX requirements preserve role styles, options and user changes through native XML',async context=>{
 const app=await harness(context),text=completePrompt+' 제목 16pt, 소제목 12pt. 전체 왼쪽 정렬. 표지와 목차를 추가. 방법은 표로 작성. 항목 번호 없이.';
 const analysis=await app.analyze('',[{name:'서식 안내.hwpx',bytes:await conditionDocument(text)}]);assert.equal(analysis.status,200);
 const settings=analysis.result.analysis.settings;assert.equal(settings.typography.titleSizePt,16);assert.deepEqual(settings.documentOptions.tableItems,['방법']);
 settings.typography.titleSizePt=18;settings.typography.headingSizePt=13;settings.alignment.heading='right';
 const generated=await app.generate(settings,'편집한 문서');assert.equal(generated.status,200);assert.equal(generated.result.renderPlan.pages.length,3);
 const zip=await JSZip.loadAsync(generated.bytes),section=xmlParser.parse(await zip.file('Contents/section0.xml').async('string')),header=xmlParser.parse(await zip.file('Contents/header.xml').async('string'));
 const paragraphs=findElement(section,'sec').children.filter(n=>n['hp:p']);
 for(const [index,block] of generated.result.renderPlan.paragraphs.entries()){
  if(block.type!=='paragraph')continue;const p=findElement([paragraphs[index]],'p'),run=findElement(p.children,'run'),char=findElement(header,'charPr',run.attributes['@_charPrIDRef']);
  assert.equal(Number(char.attributes['@_height'])/100,block.fontSizePt);
  if(block.role==='title')assert.equal(block.fontSizePt,18);
  if(block.role==='heading'){assert.equal(block.fontSizePt,13);assert.equal(block.alignment,'right');assert(!/^\d+\./.test(block.text));}
 }
});
