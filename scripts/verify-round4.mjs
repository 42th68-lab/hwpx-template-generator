// Local real-data verification: never sends source documents to an AI service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createAppServer } from "../server.mjs";
import { elements, findElement, validateHwpx, xmlParser } from "../hwpx-validation.mjs";
import { mmToHwpUnit } from "../hwpx-generator.mjs";
import { validateSettings } from "../settings-model.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "tmp", `round4-check-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const entries = await readdir(join(root, "etc"));
const hwpxName = entries.find((name) => name.includes("계획서") && name.endsWith(".hwpx") && entries.includes(name.replace(/\.hwpx$/, ".pdf")));
assert(hwpxName, "etc 폴더에 같은 이름의 계획서 PDF/HWPX 자료가 필요합니다.");
const pdfName = hwpxName.replace(/\.hwpx$/, ".pdf");
const originalFiles = await Promise.all([pdfName, hwpxName].map(async (name) => ({ name, bytes: await readFile(join(root, "etc", name)) })));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originals = Object.fromEntries(originalFiles.map(({ name, bytes }) => [name, hash(bytes)]));
await mkdir(output); // A new directory every run; no existing outputs overwritten.
const server = createAppServer({ analysisOptions: { env: {} } });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const prompt = "A4 세로, 모든 여백 20mm, 글꼴 맑은 고딕, 본문 10pt, 줄 간격 160%. 필수 항목: 연구 목적, 방법, 결과, 결론.";
const report = { engine: "rules", externalApiUsed: false, sources: originals, checks: [], outputs: [], layoutVerified: false };
async function analyze(requirements, files = []) {
  const form = new FormData(); form.set("requirements", requirements);
  for (const file of files) form.append("files", new Blob([file.bytes]), file.name);
  const response = await fetch(base + "/api/analyze", { method: "POST", body: form });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
}
async function generate(name, settings, title) {
  assert.deepEqual(validateSettings(settings), []);
  const response = await fetch(base + "/api/hwpx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings, title, confirmed: true }) });
  const result = await response.json(); assert.equal(response.status, 200, result.error);
  const bytes = Buffer.from(result.fileBase64, "base64");
  const validation = await validateHwpx(bytes);
  await writeFile(join(output, `${name}.hwpx`), bytes, { flag: "wx" });
  await writeFile(join(output, `${name}.json`), JSON.stringify({ settings, result }, null, 2), { flag: "wx" });
  report.outputs.push({ file: `${name}.hwpx`, validation, unsupportedSettings: result.unsupportedSettings });
  return bytes;
}
try {
  const natural = await analyze(prompt);
  assert.equal(natural.analysis.engine, "rules");
  const settings = natural.analysis.settings;
  assert.equal(settings.fontSizePt, 10);
  assert.deepEqual(settings.requiredItems, ["연구 목적", "방법", "결과", "결론"]);
  await generate("natural-language", settings, "자연어 입력 확인");
  report.checks.push("자연어만 입력: 여섯 설정 그룹 일치 및 생성·다운로드");
  for (const file of originalFiles) {
    const onlyFile = await analyze("", [file]);
    assert(onlyFile.files[0].text.length > 3000);
    assert.deepEqual(onlyFile.analysis.settings.requiredItems, []);
    assert.equal(onlyFile.analysis.settings.paper.size, null);
    assert.equal(onlyFile.analysis.settings.fontSizePt, null);
    assert(onlyFile.analysis.warnings.some(({ type }) => type === "missing"));
    const type = file.name.endsWith(".pdf") ? "pdf" : "hwpx";
    await writeFile(join(output, `real-${type}-analysis.json`), JSON.stringify(onlyFile, null, 2), { flag: "wx" });
    const combined = await analyze(prompt, [file]);
    assert.deepEqual(combined.analysis.settings, settings);
    await generate(`real-${type}-corrected`, combined.analysis.settings, `${type.toUpperCase()} 자료 확인`);
    report.checks.push(`${type.toUpperCase()} 실제 계획서: 예시는 조건으로 확정하지 않고 누락 경고; 자연어로 보완 후 JSON 일치`);
  }
  const edited = structuredClone(settings);
  edited.paper = { size: "A5", orientation: "landscape" };
  edited.marginsMm = { top: 15, bottom: 18, left: 22, right: 25 };
  edited.fontSizePt = 13.5;
  edited.requiredItems = ["수정한 연구 목적", "방법", "결과", "참고 문헌"];
  const bytes = await generate("edited-settings", edited, "사용자 수정값 확인");
  const zip = await JSZip.loadAsync(bytes);
  const section = xmlParser.parse(await zip.file("Contents/section0.xml").async("string"));
  const header = xmlParser.parse(await zip.file("Contents/header.xml").async("string"));
  const page = findElement(section, "pagePr");
  assert.equal(page.attributes["@_width"], String(mmToHwpUnit(148)));
  assert.equal(page.attributes["@_height"], String(mmToHwpUnit(210)));
  assert.equal(page.attributes["@_landscape"], "NARROWLY");
  for (const [side, value] of Object.entries(edited.marginsMm)) assert.equal(findElement(page.children, "margin").attributes[`@_${side}`], String(mmToHwpUnit(value)));
  assert.equal(findElement(header, "charPr", "0").attributes["@_height"], "1350");
  const text = [...elements(section)].filter((element) => element.localName === "t").flatMap((element) => element.children.map((node) => node["#text"] ?? "")).join("\n");
  for (const item of edited.requiredItems) assert(text.includes(item));
  assert(text.includes("사용자 수정값 확인"));
  report.checks.push("수정값: A5 가로, 네 방향 여백, 본문 13.5pt, 제목 및 필수 항목의 XML 반영 확인");
  for (const { name } of originalFiles) assert.equal(hash(await readFile(join(root, "etc", name))), originals[name]);
  report.checks.push("원본 SHA-256 유지: 기존 자료 수정 없음");
  await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ passed: true, output, checks: report.checks, files: report.outputs.map(({ file }) => file), layoutVerified: false }, null, 2));
} finally { await new Promise((resolve) => server.close(resolve)); }
