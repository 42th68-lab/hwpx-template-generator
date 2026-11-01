import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { loadEnvFile } from "node:process";
import { Readable } from "node:stream";
import { analyzeInputs, getAnalysisConfig } from "./settings-analyzer.mjs";
import { GenerationError, generateHwpx } from "./hwpx-generator.mjs";
import { centralEntries, isXmlText } from "./hwpx-validation.mjs";
import { UPLOAD_LIMITS, checkUploadLimits } from "./upload-limits.js";
import { libraryRequest, sharingConfigured } from "./library-proxy.mjs";
import { validateSettings } from './settings-model.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST_SIZE = UPLOAD_LIMITS.maxRequestBytes;
const MAX_PDF_PAGES = 30;
const MAX_SECTION_SIZE = 2 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 100_000;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/settings-model.js", ["settings-model.js", "text/javascript; charset=utf-8"]],
  ["/document-preview.js", ["document-preview.js", "text/javascript; charset=utf-8"]],
  ["/upload-limits.js", ["upload-limits.js", "text/javascript; charset=utf-8"]],
  ["/template-store.js", ["template-store.js", "text/javascript; charset=utf-8"]],
  ["/library-ui.js", ["library-ui.js", "text/javascript; charset=utf-8"]],
]);

class InputError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

function sendJson(status, data) {
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body) > UPLOAD_LIMITS.maxResponseBytes) throw new InputError("분석 결과가 너무 큽니다. 문서를 나누거나 필요한 조건만 입력해 주세요.", 413);
  return new Response(body, { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}

async function readRequest(request, limit = MAX_REQUEST_SIZE) {
  const chunks = [];
  let length = 0;
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) throw new InputError("입력 데이터의 전체 크기가 너무 큽니다. 첨부 합계는 3.5MB 이하로 줄여 주세요.", 413);
  for await (const chunk of request.body?.values({ preventCancel: true }) ?? []) {
    length += chunk.length;
    if (length > limit) {
      throw new InputError("입력 데이터의 전체 크기가 너무 큽니다.", 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Inspect the rendered PDF, never guess a final HWPX page count from stale caches.
export async function checkPdfDocument(buffer, settings, title) {
  if(buffer.subarray(0,5).toString()!=='%PDF-')throw new InputError('올바른 PDF 파일이 아닙니다.');
  const task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:true,disableFontFace:true});
  let pdf;
  try { pdf=await task.promise; } catch {await task.destroy().catch(()=>{});throw new InputError('PDF가 손상되었거나 암호로 보호되어 있습니다.');}
  try {
    if(pdf.numPages>MAX_PDF_PAGES)throw new InputError('분량 검사는 30쪽 이하 PDF를 지원합니다.');
    const checks=[],lines=[];
    if(settings.limits?.maxPages!=null)checks.push({label:'전체 쪽수 (참고문헌·표지·목차 포함)',actual:pdf.numPages,maximum:settings.limits.maxPages,status:pdf.numPages<=settings.limits.maxPages?'pass':'fail'});
    const skip=(settings.documentOptions?.coverPage?1:0)+(settings.documentOptions?.contentsPage?1:0);
    let rotated=false,hasImages=false;
    for(let number=1;number<=pdf.numPages;number++){
      const page=await pdf.getPage(number),content=await page.getTextContent();
      if(number<=skip)continue;
      if(page.rotate%360!==0){rotated=true;continue;}
      const operators=await page.getOperatorList();
      if(operators.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintImageXObjectRepeat,OPS.paintInlineImageXObject,OPS.paintInlineImageXObjectGroup,OPS.paintImageMaskXObject].includes(op)))hasImages=true;
      const height=page.view[3]-page.view[1],width=page.view[2]-page.view[0],pt=72/25.4;
      let current;
      for(const item of content.items){
        if(!('str' in item)||!item.str.trim())continue;
        const [,,,,x,y]=item.transform;
        if(y>height-(settings.marginsMm.top??0)*pt+2 || y<(settings.marginsMm.bottom??0)*pt-2)continue;
        const count=settings.columns?.count??1,gap=(settings.columns?.gapMm??0)*pt;
        const usable=width-((settings.marginsMm.left??0)+(settings.marginsMm.right??0))*pt;
        const column=Math.max(0,Math.min(count-1,Math.floor((x-(settings.marginsMm.left??0)*pt)/(usable/count+gap/count))));
        if(!current || Math.abs(current.y-y)>Math.max(1,Math.min(3,(item.height||10)*0.2)) || current.column!==column){current={page:number,y,column,text:''};lines.push(current);}
        current.text+=(current.text?' ':'')+item.str;
      }
    }
    const normalize=value=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    const cleanHeading=value=>normalize(value).replace(/^\d+[.)．、]?/,'');
    if(settings.limits?.titleMaxLines!=null){
      const expected=normalize(title),found=[];
      for(let i=0;i<lines.length;i++){let text='';for(let j=i;j<Math.min(lines.length,i+20)&&lines[j].page===lines[i].page;j++){text+=normalize(lines[j].text);if(text===expected){found.push(j-i+1);break;}if(!expected.startsWith(text))break;}}
      checks.push({label:'제목 줄 수',maximum:settings.limits.titleMaxLines,actual:found.length===1?found[0]:null,status:found.length===1&&!hasImages?(found[0]<=settings.limits.titleMaxLines?'pass':'fail'):'unverified',reason:hasImages?'그림·스캔이 포함된 PDF의 줄 수는 직접 확인해 주세요.':found.length===1?null:'입력한 제목을 PDF에서 한 곳으로 식별하지 못했습니다. 제목을 맞추고 직접 확인해 주세요.'});
    }
    const headings=settings.requiredItems.map(normalize),positions=new Map();
    for(let i=0;i<lines.length;i++){const heading=cleanHeading(lines[i].text);if(headings.includes(heading)){const found=positions.get(heading)||[];found.push(i);positions.set(heading,found);}}
    for(const rule of settings.sectionStyles||[]){
      if(rule.maxLines==null)continue;
      const starts=positions.get(normalize(rule.item))||[];
      let actual=null,reason=null;
      if(starts.length===1&&!rotated&&!hasImages){
        const start=starts[0],index=headings.indexOf(normalize(rule.item));
        const following=settings.requiredItems.slice(index+1).map(item=>positions.get(normalize(item))||[]);
        if(following.some(found=>found.length!==1||found[0]<=start))reason='뒤따르는 항목 경계를 확정하지 못했습니다.';
        else {const end=following.length?Math.min(...following.map(found=>found[0])):lines.length;actual=end-start-1;if(actual===0){actual=null;reason='항목 본문의 텍스트가 없어 줄 수를 판정하지 않았습니다.';}}
      } else reason=hasImages?'그림·스캔이 포함된 PDF의 줄 수는 직접 확인해 주세요.':'항목 제목을 한 곳으로 식별하지 못했거나 회전된 쪽이 있습니다.';
      checks.push({label:`${rule.item} 본문 줄 수 (항목 제목 제외)`,actual,maximum:rule.maxLines,status:actual==null?'unverified':actual<=rule.maxLines?'pass':'fail',reason});
    }
    const status=checks.some(check=>check.status==='fail')?'fail':checks.length&&checks.every(check=>check.status==='pass')?'pass':'unverified';
    return {status,pages:pdf.numPages,checks,note:'PDF에 실제 표시된 쪽수와 텍스트 줄을 검사합니다. 표·수식·그림·다단의 복잡한 읽기 순서와 스캔 문서는 줄 수를 직접 확인해 주세요. 원본 HWPX의 서식 일치 여부를 검증하는 기능은 아닙니다.'};
  } finally {await task.destroy();}
}

function collectText(nodes, pieces) {
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    for (const [name, value] of Object.entries(node)) {
      if (name === "t" && Array.isArray(value)) {
        for (const part of value) {
          if (typeof part["#text"] === "string") pieces.push(part["#text"]);
        }
      } else if (Array.isArray(value)) {
        // Nested table-cell paragraphs are collected separately, not glued
        // into their parent paragraph (which destroys words and boundaries).
        if (name !== "p") collectText(value, pieces);
      }
    }
  }
}

function collectParagraphs(nodes, paragraphs) {
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    for (const [name, value] of Object.entries(node)) {
      if (!Array.isArray(value)) continue;
      if (name === "p") {
        const pieces = [];
        collectText(value, pieces);
        const text = pieces.join("").trim();
        if (text) paragraphs.push(text);
        collectParagraphs(value, paragraphs);
      } else {
        collectParagraphs(value, paragraphs);
      }
    }
  }
}

async function extractHwpx(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new InputError("올바른 HWPX 파일이 아닙니다.");
  }

  let zip;
  try {
    const entries = centralEntries(buffer, { maxEntries: 1000 });
    const names = new Set(entries.map((entry) => entry.name));
    if (names.size !== entries.length || entries.some(({ name, size }) => !name || name.includes("\\") || /^(?:\/|[A-Za-z]:)/.test(name) || name.replace(/\/$/, "").split("/").some((part) => !part || part === "." || part === "..") || size > 20 * 1024 * 1024)
      || entries.reduce((sum, entry) => sum + entry.size, 0) > 50 * 1024 * 1024) throw new Error("Unsafe ZIP package");
    const mime = entries.find((entry) => entry.name === "mimetype");
    if (!mime || mime.size > 100) throw new Error("Missing or oversized mimetype");
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new InputError("HWPX 압축 구조가 손상되었거나 지원 크기를 벗어났습니다.");
  }

  const mimetypeFile = zip.file("mimetype");
  if (!mimetypeFile || (await mimetypeFile.async("string")).trim() !== "application/hwp+zip") {
    throw new InputError("HWPX 형식의 문서가 아닙니다.");
  }

  const sections = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (sections.length === 0 || sections.length > 100) {
    throw new InputError("HWPX 본문 구역을 확인할 수 없습니다.");
  }

  const parser = new XMLParser({ preserveOrder: true, removeNSPrefix: true, parseTagValue: false });
  // Text extraction doesn't need to repair existing styles, but requires a
  // genuine HWPX package, valid XML and resolvable package targets.
  for (const path of ["META-INF/container.xml", "Contents/content.hpf", "Contents/header.xml", ...sections]) {
    const entry = zip.file(path);
    if (!entry) throw new InputError("HWPX의 필수 구성 파일이 없습니다.");
    if (entry._data?.uncompressedSize > MAX_SECTION_SIZE) throw new InputError("HWPX XML 구성 파일이 너무 큽니다.");
    const xml = await entry.async("string");
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || !isXmlText(xml) || XMLValidator.validate(xml) !== true) throw new InputError("HWPX XML이 손상되었거나 지원하지 않는 형식입니다.");
    const document = parser.parse(xml);
    const expectedRoot = path.endsWith("container.xml") ? "container" : path.endsWith(".hpf") ? "package" : path.endsWith("header.xml") ? "head" : "sec";
    if (!document.some((node) => Object.hasOwn(node, expectedRoot))) throw new InputError("HWPX XML의 문서 구조가 올바르지 않습니다.");
    if (path.endsWith("container.xml") || path.endsWith(".hpf")) {
      const metadataParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
      const checkTargets = (node) => {
        if (!node || typeof node !== "object") return;
        if (node["@_href"] || node["@_full-path"]) {
          const href = node["@_href"] ?? node["@_full-path"];
          const target = zip.file(href) ?? zip.file(`Contents/${href}`);
          if (!target || /(^\/|\\|^[A-Za-z][A-Za-z0-9+.-]*:|(?:^|\/)\.\.(?:\/|$))/.test(href)) throw new InputError("HWPX의 구성 파일 연결이 손상되었습니다.");
        }
        for (const child of Object.values(node)) checkTargets(child);
      };
      checkTargets(metadataParser.parse(xml));
    }
  }
  const paragraphs = [];
  for (const section of sections) {
    const entry = zip.file(section);
    if (entry?._data?.uncompressedSize > MAX_SECTION_SIZE) {
      throw new InputError("HWPX 본문 구역이 너무 큽니다.");
    }
    const xml = await entry.async("string");
    if (Buffer.byteLength(xml, "utf8") > MAX_SECTION_SIZE) {
      throw new InputError("HWPX 본문 구역이 너무 큽니다.");
    }
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
      throw new InputError("HWPX 본문 XML을 읽을 수 없습니다.");
    }
    collectParagraphs(parser.parse(xml), paragraphs);
  }

  const text = paragraphs.join("\n").slice(0, MAX_EXTRACTED_CHARS).trim();
  if (!text) throw new InputError("HWPX에서 읽을 수 있는 본문 텍스트가 없습니다.");
  return { text, sections: sections.length, truncated: paragraphs.join("\n").length > MAX_EXTRACTED_CHARS };
}

async function extractPdf(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new InputError("올바른 PDF 파일이 아닙니다.");
  }

  let loadingTask;
  try {
    loadingTask = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new InputError(`PDF는 ${MAX_PDF_PAGES}쪽 이하만 처리할 수 있습니다.`);
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : " "}`)
        .join("")
        .replace(/ +\n/g, "\n")
        .trim();
      if (text) pages.push(text);
    }
    const completeText = pages.join("\n\n");
    if (!completeText) {
      throw new InputError("이 PDF에는 추출할 수 있는 문자가 없습니다. 이미지 스캔본은 아직 지원하지 않습니다.");
    }
    return {
      text: completeText.slice(0, MAX_EXTRACTED_CHARS),
      pages: document.numPages,
      truncated: completeText.length > MAX_EXTRACTED_CHARS,
    };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("PDF 내용을 읽을 수 없습니다. 암호나 파일 손상 여부를 확인해 주세요.");
  } finally {
    await loadingTask?.destroy();
  }
}

async function processInputs(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new InputError("입력 형식이 올바르지 않습니다.", 415);
  }
  const body = await readRequest(request);
  let form;
  try {
    form = await new Request("http://localhost/api/inputs", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
  } catch {
    throw new InputError("입력 데이터를 읽을 수 없습니다.", 400);
  }

  const prompt = String(form.get("requirements") ?? "").trim();
  const uploads = form.getAll("files").filter((value) => value && typeof value.arrayBuffer === "function");
  if (!prompt && uploads.length === 0) {
    throw new InputError("요구사항을 입력하거나 참고 파일을 첨부해 주세요.");
  }
  if (prompt.length > 500) throw new InputError("요구사항은 500자 이내로 입력해 주세요.");
  const uploadProblem = checkUploadLimits(uploads);
  if (uploadProblem) throw new InputError(uploadProblem);

  const files = [];
  for (const upload of uploads) {
    const extension = upload.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "hwpx"].includes(extension)) {
      throw new InputError("PDF 또는 HWPX 파일만 첨부할 수 있습니다.");
    }
    const buffer = Buffer.from(await upload.arrayBuffer());
    const result = extension === "pdf" ? await extractPdf(buffer) : await extractHwpx(buffer);
    files.push({ name: upload.name, type: extension, size: upload.size, ...result });
  }
  return { prompt, files };
}

export function createApiHandler({ analysisOptions } = {}) {
  // Every request is independent. No generated-file cache, local writes, or download tokens.
  return async (request) => {
  try {
    const path = new URL(request.url).pathname;
    if(request.method==='POST'&&path==='/api/check-document'){
      if(!/^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new InputError('PDF 파일과 설정을 함께 보내 주세요.',415);
      const bytes=await readRequest(request);
      let data;try{data=await new Request(request.url,{method:'POST',headers:request.headers,body:bytes}).formData();}catch{throw new InputError('첨부 데이터를 읽지 못했습니다.',400);}
      const file=data.get('file');if(!file||typeof file.arrayBuffer!=='function'||!file.name?.toLowerCase().endsWith('.pdf'))throw new InputError('완성한 문서를 PDF로 내보내 첨부해 주세요.');
      if(file.size>UPLOAD_LIMITS.maxTotalFileBytes)throw new InputError('PDF는 3.5MB 이하로 첨부해 주세요.',413);
      let settings;try{settings=JSON.parse(data.get('settings'));}catch{throw new InputError('검사할 문서 설정을 읽지 못했습니다.');}
      let problems;try{problems=validateSettings(settings);}catch{throw new InputError('검사할 문서 설정이 올바르지 않습니다.');}
      if(settings?.schemaVersion!==1||problems.length)throw new InputError(problems[0]?.message||'검사할 문서 설정이 올바르지 않습니다.');
      const title=data.get('title');if(typeof title!=='string'||title.length>80)throw new InputError('제목을 확인해 주세요.');
      return sendJson(200,await checkPdfDocument(Buffer.from(await file.arrayBuffer()),settings,title));
    }
    if (path === "/api/library") {
      let input;
      if (request.method === "GET") {
        const params = new URL(request.url).searchParams;
        input = Object.fromEntries(["op","id","q","page"].filter(key=>params.has(key)).map(key=>[key,params.get(key)]));
        input.op ||= "list";
        if (!["list","get","download"].includes(input.op)) throw new InputError("읽기 요청이 올바르지 않습니다.",405);
      } else if (request.method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new InputError("JSON 형식으로 보내 주세요.",415);
        try { input = JSON.parse((await readRequest(request,65536)).toString("utf8")); } catch (error) { if (error instanceof InputError) throw error; throw new InputError("JSON을 확인해 주세요.",400); }
        if (!input || !["save","unpublish","delete","get","download"].includes(input.op)) throw new InputError("지원하지 않는 요청입니다.",400);
      } else throw new InputError("지원하지 않는 요청입니다.",405);
      return await libraryRequest(input,{env:analysisOptions?.env ?? process.env});
    }
    if (request.method === "POST" && path === "/api/hwpx") {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new InputError("JSON 형식으로 설정을 보내 주세요.", 415);
      let input;
      const body = await readRequest(request, 64 * 1024);
      try { input = JSON.parse(body.toString("utf8")); } catch { throw new InputError("문서 설정 JSON을 읽을 수 없습니다.", 400); }
      const { buffer, ...result } = await generateHwpx(input);
      if (buffer.length > UPLOAD_LIMITS.maxGeneratedFileBytes) throw new InputError("생성 파일이 너무 큽니다. 항목 수를 줄여 주세요.", 413);
      return sendJson(200, { ...result, fileBase64: buffer.toString("base64"), contentType: "application/hwp+zip" });
    }
    if (request.method === "GET" && path.startsWith("/api/hwpx/download/")) {
      return sendJson(410, { error: "이전 다운로드 링크는 더 이상 사용하지 않습니다. 설정으로 양식을 다시 생성해 주세요." });
    }
    if (request.method === "GET" && path === "/api/config") {
      return sendJson(200, { ...getAnalysisConfig(analysisOptions?.env), uploadLimits: UPLOAD_LIMITS, sharingConfigured: sharingConfigured(analysisOptions?.env) });
    }
    if (request.method === "POST" && ["/api/inputs", "/api/analyze"].includes(path)) {
      const result = await processInputs(request);
      return sendJson(200, path === "/api/analyze" ? { ...result, analysis: await analyzeInputs(result, analysisOptions) } : result);
    }
    return sendJson(404, { error: "페이지를 찾을 수 없습니다." });
  } catch (error) {
    const status = error instanceof InputError || error instanceof GenerationError ? error.status : 500;
    if (status === 500) console.error(error);
    return sendJson(status, { error: status === 500 ? "입력 처리 중 오류가 발생했습니다." : error.message });
  }
  };
}

export function createAppServer(options = {}) {
  const handleApi = createApiHandler(options);
  return createServer(async (incoming, outgoing) => {
    try {
      let result;
      const path = new URL(incoming.url, "http://localhost").pathname;
      if (path.startsWith("/api/")) {
        const request = new Request(new URL(incoming.url, "http://localhost"), {
          method: incoming.method, headers: incoming.headers,
          ...(!["GET", "HEAD"].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
        });
        result = await handleApi(request);
      } else if (incoming.method === "GET" && STATIC_FILES.has(path)) {
        const [name, type] = STATIC_FILES.get(path);
        result = new Response(await readFile(join(ROOT, name)), { headers: { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      } else result = sendJson(404, { error: "페이지를 찾을 수 없습니다." });
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
      incoming.resume();
    } catch (error) {
      console.error(error);
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "서버 처리 중 오류가 발생했습니다." }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { loadEnvFile(join(ROOT, ".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const PORT = Number(process.env.PORT || 4173);
  const server = createAppServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`한폼 서버: http://127.0.0.1:${server.address().port}`);
  });
}
