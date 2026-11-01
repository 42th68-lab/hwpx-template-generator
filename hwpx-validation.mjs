import { posix } from "node:path";
import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const xmlParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false });
const local = (name) => name.split(":").at(-1);

export function* elements(nodes) {
  for (const node of nodes) {
    for (const [name, children] of Object.entries(node)) {
      if (Array.isArray(children) && !name.startsWith("?")) {
        yield { name, localName: local(name), node, children, attributes: node[":@"] ?? {} };
        yield* elements(children);
      }
    }
  }
}

export function findElement(nodes, name, id) {
  return [...elements(nodes)].find((element) => element.localName === name && (id === undefined || element.attributes["@_id"] === id));
}

export function centralEntries(buffer, { maxEntries = 100 } = {}) {
  let end = buffer.length - 22;
  while (end >= Math.max(0, buffer.length - 65_557) && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < Math.max(0, buffer.length - 65_557)) throw new Error("ZIP 중앙 디렉터리가 없습니다.");
  const count = buffer.readUInt16LE(end + 10);
  if (!count || count > maxEntries) throw new Error("HWPX ZIP 항목 수가 올바르지 않습니다.");
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP 항목이 손상되었습니다.");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, method: buffer.readUInt16LE(offset + 10), size: buffer.readUInt32LE(offset + 24) });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

function safePath(name) {
  return name && !name.includes("\\") && !/^(?:\/|[A-Za-z]:)/.test(name) && name.split("/").every((part) => part && part !== "." && part !== "..");
}

function targetPath(base, href, entries) {
  if (typeof href !== "string" || /^[A-Za-z][A-Za-z0-9+.-]*:|^\//.test(href)) return null;
  const direct = posix.normalize(href);
  const target = entries.has(direct) ? direct : posix.normalize(posix.join(posix.dirname(base), href));
  return safePath(target) && entries.has(target) ? target : null;
}

export function isXmlText(value) {
  return typeof value === "string" && [...value].every((char) => {
    const code = char.codePointAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF);
  });
}

// Runtime checks for the deliberately small, single-section template format.
// Development outputs are also checked independently by hwpx-unified's validator.
export async function validateHwpx(buffer, { changed = true } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("HWPX 패키지가 너무 짧습니다.");
  const entries = centralEntries(buffer);
  const names = new Set(entries.map((entry) => entry.name));
  if (names.size !== entries.length || entries.some((entry) => !safePath(entry.name) || entry.size > 2 * 1024 * 1024)) throw new Error("중복·위험한 경로 또는 과도한 ZIP 항목이 있습니다.");
  if (entries[0].name !== "mimetype" || entries[0].method !== 0 || buffer.readUInt32LE(0) !== 0x04034b50 || buffer.readUInt16LE(8) !== 0) throw new Error("mimetype은 첫 항목이며 비압축이어야 합니다.");
  const firstNameLength = buffer.readUInt16LE(26);
  if (buffer.subarray(30, 30 + firstNameLength).toString("utf8") !== "mimetype") throw new Error("ZIP 로컬 항목 순서가 올바르지 않습니다.");
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  if (await zip.file("mimetype")?.async("string") !== "application/hwp+zip") throw new Error("HWPX mimetype이 올바르지 않습니다.");
  for (const path of ["META-INF/container.xml", "Contents/content.hpf", "Contents/header.xml", "Contents/section0.xml"]) {
    if (!zip.file(path)) throw new Error(`필수 항목이 없습니다: ${path}`);
  }
  const parsed = new Map();
  for (const entry of entries.filter((item) => /\.(?:xml|hpf)$/i.test(item.name))) {
    const xml = await zip.file(entry.name).async("string");
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || !isXmlText(xml) || XMLValidator.validate(xml) !== true) throw new Error(`XML이 올바르지 않습니다: ${entry.name}`);
    parsed.set(entry.name, xmlParser.parse(xml));
  }
  const header = parsed.get("Contents/header.xml");
  const section = parsed.get("Contents/section0.xml");
  if (!findElement(header, "head") || !findElement(section, "sec") || !findElement(section, "secPr")) throw new Error("header/section 또는 페이지 설정이 없습니다.");
  const referenceTypes = { charPrIDRef: "charPr", paraPrIDRef: "paraPr", styleIDRef: "style", borderFillIDRef: "borderFill" };
  const definitions = Object.fromEntries(Object.values(referenceTypes).map((name) => [name, new Set()]));
  for (const element of elements(header)) {
    if (definitions[element.localName]) definitions[element.localName].add(element.attributes["@_id"]);
    if (["charProperties", "paraProperties", "borderFills"].includes(element.localName)) {
      const count = element.children.filter((node) => Object.keys(node).some((name) => Array.isArray(node[name]) && !name.startsWith("?"))).length;
      if (element.attributes["@_itemCnt"] !== String(count)) throw new Error(`스타일 개수가 맞지 않습니다: ${element.localName}`);
    }
  }
  const paragraphIds = new Set();
  for (const element of elements(section)) {
    if (changed && element.localName === "linesegarray") throw new Error("수정된 본문의 낡은 레이아웃 캐시가 남아 있습니다.");
    for (const [attribute, target] of Object.entries(referenceTypes)) {
      const value = element.attributes[`@_${attribute}`];
      if (value !== undefined && !(attribute === "borderFillIDRef" && value === "0") && !definitions[target].has(value)) throw new Error(`정의되지 않은 스타일 참조: ${attribute}=${value}`);
    }
    if (element.localName === "p") {
      const id = element.attributes["@_id"];
      if (!id || paragraphIds.has(id)) throw new Error("문단 ID가 없거나 중복되었습니다.");
      paragraphIds.add(id);
    }
  }
  for (const [base, nodes] of parsed) {
    for (const element of elements(nodes)) {
      if (element.localName === "rootfile" && !targetPath(base, element.attributes["@_full-path"], names)) throw new Error("container의 대상 파일이 없습니다.");
      if (base.endsWith(".hpf") && element.localName === "item" && !targetPath(base, element.attributes["@_href"], names)) throw new Error("manifest의 대상 파일이 없습니다.");
    }
  }
  return { passed: true, checks: ["ZIP/CRC", "mimetype", "XML", "manifest/container", "스타일 참조·개수", "고유 문단 ID", ...(changed ? ["레이아웃 캐시 제거"] : [])] };
}
