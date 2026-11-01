import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const input = process.argv[2];

if (!input) {
  console.error("사용법: node scripts/inspect-hwpx.mjs <파일.hwpx>");
  process.exit(1);
}

const filePath = resolve(input);
const archive = await readFile(filePath);

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP 중앙 디렉터리를 찾지 못했습니다.");
}

function readEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`ZIP 항목 ${index}의 중앙 디렉터리 헤더가 올바르지 않습니다.`);
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const encoding = flags & 0x0800 ? "utf8" : "utf8";
    const name = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString(encoding);

    entries.push({
      index,
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function entryData(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`${entry.name}: 로컬 파일 헤더가 올바르지 않습니다.`);
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`${entry.name}: 지원하지 않는 ZIP 압축 방식 ${entry.method}입니다.`);
}

function countTag(xml, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (xml.match(new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}(?:\\s|>)`, "g")) ?? []).length;
}

function xmlText(xml) {
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
    .map((match) => match[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'"))
    .join("");
}

const entries = readEntries(archive);
const byName = new Map(entries.map((entry) => [entry.name, entry]));
const mimetypeEntry = byName.get("mimetype");
const mimetype = mimetypeEntry ? entryData(archive, mimetypeEntry).toString("utf8") : "(없음)";

console.log(`파일: ${basename(filePath)}`);
console.log(`크기: ${archive.length.toLocaleString("ko-KR")} bytes`);
console.log(`ZIP 항목: ${entries.length}개`);
console.log(`mimetype: ${mimetype}`);
console.log(`mimetype 첫 항목: ${entries[0]?.name === "mimetype" ? "예" : "아니요"}`);
console.log(`mimetype 비압축: ${mimetypeEntry?.method === 0 ? "예" : "아니요"}`);
console.log("\n[패키지 항목]");

for (const entry of entries) {
  const methodName = entry.method === 0 ? "stored" : entry.method === 8 ? "deflate" : `method-${entry.method}`;
  console.log(`${String(entry.index).padStart(2, "0")}  ${methodName.padEnd(7)}  ${String(entry.uncompressedSize).padStart(9)}  ${entry.name}`);
}

const headerEntry = byName.get("Contents/header.xml");
if (headerEntry) {
  const headerXml = entryData(archive, headerEntry).toString("utf8");
  console.log("\n[서식 요약]");
  console.log(`글자 모양(charPr): ${countTag(headerXml, "charPr")}개`);
  console.log(`문단 모양(paraPr): ${countTag(headerXml, "paraPr")}개`);
  console.log(`스타일(style): ${countTag(headerXml, "style")}개`);
}

const sections = entries
  .filter((entry) => /^Contents\/section\d+\.xml$/i.test(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

console.log("\n[본문 구역 요약]");
for (const section of sections) {
  const sectionXml = entryData(archive, section).toString("utf8");
  const text = xmlText(sectionXml);
  console.log(`${section.name}: 문단 ${countTag(sectionXml, "p")}개, run ${countTag(sectionXml, "run")}개, 표 ${countTag(sectionXml, "tbl")}개, 텍스트 ${text.length}자`);
}

const required = [
  "mimetype",
  "Contents/content.hpf",
  "Contents/header.xml",
  "META-INF/container.xml",
];
const missing = required.filter((name) => !byName.has(name));

console.log("\n[기본 검사]");
console.log(`필수 항목: ${missing.length === 0 ? "통과" : `누락 - ${missing.join(", ")}`}`);
console.log(`본문 구역: ${sections.length > 0 ? `${sections.length}개` : "없음"}`);

if (entries[0]?.name !== "mimetype" || mimetypeEntry?.method !== 0 || missing.length > 0 || sections.length === 0) {
  process.exitCode = 2;
}
