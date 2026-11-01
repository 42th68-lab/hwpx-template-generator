// Explicitly run against an approved deployment; never uploads secrets or journals.
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import JSZip from "jszip";
import { elements, findElement, validateHwpx, xmlParser } from "../hwpx-validation.mjs";
import { mmToHwpUnit } from "../hwpx-generator.mjs";

const base = process.argv[2];
assert(base && /^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(base), "Pass the approved Vercel deployment URL.");
const output = resolve("tmp", `deployed-check-${Date.now()}`);
await mkdir(output, { recursive: true });
const checks = [];
const check = (value, label) => { assert(value, label); checks.push(label); };
const request = async (path, options = {}) => fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(60000) });
const prompt = "A4 세로, 모든 여백 20mm, 글꼴 맑은 고딕, 본문 10pt, 줄 간격 160%. 필수 항목: 연구 목적, 방법, 결과, 결론.";
async function analyze(text, files = []) {
  const data = new FormData(); data.set("requirements", text);
  for (const { name, bytes } of files) data.append("files", new Blob([bytes]), name);
  const response = await request("/api/analyze", { method: "POST", body: data });
  return { status: response.status, result: await response.json() };
}
async function generate(settings, title) {
  const response = await request("/api/hwpx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings, title, confirmed: true }) });
  return { status: response.status, result: await response.json() };
}
const configResponse = await request("/api/config");
check(configResponse.status === 200, "Anonymous production config accessible");
const config = await configResponse.json();
check(!Object.hasOwn(config, "supabase"), "Removed account configuration is not exposed");
const natural = await analyze(prompt);
check(natural.status === 200 && natural.result.analysis.settings.fontSizePt === 10, "Natural language six-group analysis");
const settings = natural.result.analysis.settings;
for (const extension of ["pdf", "hwpx"]) {
  const name = (await readdir("etc")).find((name) => name.includes("계획서") && name.endsWith(`.${extension}`));
  assert(name, `Real ${extension} material required`);
  const file = { name, bytes: await readFile(join("etc", name)) };
  const only = await analyze("", [file]);
  check(only.status === 200 && only.result.files[0].text.length > 3000 && only.result.analysis.settings.paper.size === null, `${extension}: real extraction and missing-condition warnings`);
  const combined = await analyze(prompt, [file]);
  assert.deepEqual(combined.result.analysis.settings, settings);
  check(combined.status === 200, `${extension}: explicit instructions yield expected settings`);
  const generated = await generate(combined.result.analysis.settings, `${extension.toUpperCase()} 배포 검사`);
  check(generated.status === 200 && (await validateHwpx(Buffer.from(generated.result.fileBase64, "base64"))).passed, `${extension}: stateless generation and structure validation`);
  await writeFile(join(output, `${extension}.hwpx`), Buffer.from(generated.result.fileBase64, "base64"), { flag: "wx" });
}
const edited = structuredClone(settings);
edited.paper = { size: "A5", orientation: "landscape" };
edited.marginsMm = { top: 15, bottom: 18, left: 22, right: 25 };
edited.fontSizePt = 13.5;
edited.requiredItems = ["수정한 연구 목적", "방법", "결과", "참고 문헌"];
const generated = await generate(edited, "배포 수정값 확인");
check(generated.status === 200 && !generated.result.downloadUrl, "Generation returns bytes without a deferred server-memory URL");
const bytes = Buffer.from(generated.result.fileBase64, "base64");
check((await validateHwpx(bytes)).passed, "Edited HWPX structure valid");
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
for (const item of ["배포 수정값 확인", ...edited.requiredItems]) assert(text.includes(item));
checks.push("Edited paper, orientation, four margins, size, title and items match downloaded XML");
await writeFile(join(output, "edited-settings.hwpx"), bytes, { flag: "wx" });
check((await generate({ ...settings, fontSizePt: -1 }, "잘못된 설정")).status === 422, "Invalid settings rejected");
const missing = await analyze("탐구 보고서 양식을 만들어 줘");
check(missing.status === 200 && missing.result.analysis.warnings.some(({ type }) => type === "missing"), "Missing settings warned");
check((await analyze("")).status === 422, "Empty input rejected");
for (const extension of ["pdf", "hwpx"]) check((await analyze("", [{ name: `damaged.${extension}`, bytes: Buffer.from("not a valid document") }])).status === 422, `Damaged ${extension} rejected`);
const report = { base, checkedAt: new Date().toISOString(), passed: true, checks, layoutVerified: false, analysisEngine: natural.result.analysis.engine };
await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ ...report, output }, null, 2));
