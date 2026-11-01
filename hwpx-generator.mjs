import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { XMLBuilder } from "fast-xml-parser";
import { emptySettings, PAPER_SIZES, validateSettings, optionalSettings, buildDocumentPlan } from "./settings-model.js";
import { elements, findElement, isXmlText, validateHwpx, xmlParser } from "./hwpx-validation.mjs";

const TEMPLATE = new URL("./assets/hwpx/basic-report.hwpx", import.meta.url);
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, format: false, suppressEmptyNode: true });
export const mmToHwpUnit = (value) => Math.round(value * 7200 / 25.4);
const xml = (nodes) => builder.build(nodes);
const clone = (node) => structuredClone(node);

export class GenerationError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

export function normalizeGenerationInput(input) {
  if (!input || typeof input !== "object" || input.confirmed !== true) throw new GenerationError("문서 설정을 먼저 확정해 주세요.");
  const raw = input.settings;
  if (!raw || raw.schemaVersion !== 1) throw new GenerationError("지원하는 문서 설정 JSON이 아닙니다.");
  const settings = emptySettings();
  settings.paper = { size: typeof raw.paper?.size === "string" ? raw.paper.size : null, orientation: typeof raw.paper?.orientation === "string" ? raw.paper.orientation : null };
  for (const side of ["top", "bottom", "left", "right"]) settings.marginsMm[side] = typeof raw.marginsMm?.[side] === "number" ? raw.marginsMm[side] : null;
  settings.fontFamily = typeof raw.fontFamily === "string" ? raw.fontFamily.trim() : null;
  settings.fontSizePt = typeof raw.fontSizePt === "number" ? raw.fontSizePt : null;
  settings.lineSpacing = { value: typeof raw.lineSpacing?.value === "number" ? raw.lineSpacing.value : null, unit: typeof raw.lineSpacing?.unit === "string" ? raw.lineSpacing.unit : null };
  settings.requiredItems = Array.isArray(raw.requiredItems) ? raw.requiredItems.map((item) => typeof item === "string" ? item.trim() : item) : [];
  settings.documentOptions = raw.documentOptions == null ? {coverPage:false,contentsPage:false,tableItems:[]} : raw.documentOptions;
  for (const group of ['headerFooterMm','columns','alignment','limits','sectionStyles']) if (raw[group] != null) settings[group] = raw[group];
  const problems = validateSettings(settings);
  if (problems.length) throw new GenerationError(problems[0].message);
  Object.assign(settings,optionalSettings(settings));
  settings.documentOptions={coverPage:settings.documentOptions.coverPage,contentsPage:settings.documentOptions.contentsPage,tableItems:[...new Set(settings.documentOptions.tableItems)]};
  const title = input.title == null || input.title === "" ? "문서 양식" : input.title;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 80 || /[\r\n]/.test(title)) throw new GenerationError("문서 제목은 한 줄, 80자 이내로 입력해 주세요.");
  if (![title, settings.fontFamily, ...settings.requiredItems, ...(settings.sectionStyles || []).map(s=>s.item)].every(isXmlText)) throw new GenerationError("제목 또는 필수 항목에 문서에 넣을 수 없는 제어 문자가 있습니다.");
  return { settings, title: title.trim() };
}

function removeLayoutCaches(nodes) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (Object.hasOwn(nodes[index], "hp:linesegarray")) { nodes.splice(index, 1); continue; }
    for (const children of Object.values(nodes[index])) if (Array.isArray(children)) removeLayoutCaches(children);
  }
}

function paragraphFrom(template, id, text) {
  const paragraph = clone(template);
  paragraph[":@"]["@_id"] = String(id);
  const textElement = findElement([paragraph], "t");
  if (!textElement) throw new Error("템플릿에 문단 텍스트가 없습니다.");
  textElement.node[textElement.name] = text ? [{ "#text": text }] : [];
  return paragraph;
}

function safeFileName(title) {
  const stem = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "문서_양식";
  return `${/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i.test(stem) ? `양식_${stem}` : stem}.hwpx`;
}

// The stage option is only used by local experiments/tests, never accepted by the HTTP route.
export async function generateHwpx(input, { stage = "layout" } = {}) {
  const { settings, title } = normalizeGenerationInput(input);
  if (!["title", "items", "font-size", "layout"].includes(stage)) throw new Error("알 수 없는 생성 단계입니다.");
  const renderPlan = buildDocumentPlan(settings, title);
  if (renderPlan.warnings.length) throw new GenerationError(renderPlan.warnings[0]);
  const tableHostStyles = new Map();
  const original = await readFile(TEMPLATE);
  await validateHwpx(original, { changed: false });
  const zip = await JSZip.loadAsync(original);
  const section = xmlParser.parse(await zip.file("Contents/section0.xml").async("string"));
  const header = xmlParser.parse(await zip.file("Contents/header.xml").async("string"));
  removeLayoutCaches(section);
  const root = findElement(section, "sec");
  const paragraphs = root.children.filter((node) => Object.hasOwn(node, "hp:p"));
  const titleParagraph = paragraphs.find((node) => findElement([node], "p").attributes["@_id"] === "1000000003");
  if (stage === "title") {
    const text = findElement([titleParagraph], "t");
    text.node[text.name] = [{ "#text": title }];
  } else {
    const headingTemplate = paragraphs.find((node) => findElement([node], "p").attributes["@_id"] === "1000000009");
    const bodyTemplate = paragraphs.find((node) => findElement([node], "p").attributes["@_id"] === "1000000010");
    const styleCache = new Map();
    const paragraphStyle = (base, block, tableHost=false) => {
      const key = `${base}:${block.alignment}:${block.keepWithNext}:${tableHost?block.height:''}`;
      if (styleCache.has(key)) return styleCache.get(key);
      const group = findElement(header,'paraProperties');
      const copy = clone(findElement(header,'paraPr',String(base)).node);
      const id = String(Math.max(...[...elements(group.children)].filter(e=>e.localName==='paraPr').map(e=>Number(e.attributes['@_id'])))+1);
      copy[':@']['@_id'] = id;
      for (const e of elements([copy])) {
        if(e.localName==='align') e.attributes['@_horizontal']={left:'LEFT',right:'RIGHT',center:'CENTER',justify:'JUSTIFY',distribute:'DISTRIBUTE'}[block.alignment];
        if(e.localName==='breakSetting') Object.assign(e.attributes,{'@_keepWithNext':block.keepWithNext?'1':'0','@_keepLines':'1'});
      }
      group.children.push(copy); group.attributes['@_itemCnt'] = String(group.children.filter(n=>n['hh:paraPr']).length);
      if(tableHost)tableHostStyles.set(id,block.height);
      styleCache.set(key,id); return id;
    };
    const charCache = new Map();
    const format = (paragraph, block, tableHost=false) => {
      for (const p of [...elements([paragraph])].filter(e=>e.localName==='p')) p.attributes['@_paraPrIDRef'] = paragraphStyle(p.attributes['@_paraPrIDRef'],block,tableHost && p.node===paragraph);
      // Clone each run's original character style so headings retain bold.
      for (const run of [...elements([paragraph])].filter(e=>e.localName==='run')) {
        const base=run.attributes['@_charPrIDRef'];
        const size=block.fontSizePt;
        if(size===(base==='7'?20:base==='8'?14:settings.fontSizePt))continue;
        const key=`${base}:${size}`;
        if(!charCache.has(key)) {
          const group=findElement(header,'charProperties'),copy=clone(findElement(header,'charPr',base).node);
          const id=String(Math.max(...[...elements(group.children)].filter(e=>e.localName==='charPr').map(e=>Number(e.attributes['@_id'])))+1);
          Object.assign(copy[':@'],{'@_id':id,'@_height':String(Math.round(size*100))});
          group.children.push(copy);group.attributes['@_itemCnt']=String(group.children.filter(n=>n['hh:charPr']).length);charCache.set(key,id);
        }
        run.attributes['@_charPrIDRef']=charCache.get(key);
      }
      return paragraph;
    };
    const columnTemplate = clone(findElement(section,'colPr').node);
    const setColumns = (paragraph,count) => {
      const column=clone(columnTemplate);
      Object.assign(column[':@'],{'@_colCount':String(count),'@_sameSz':'1','@_sameGap':String(mmToHwpUnit(count>1?(settings.columns?.gapMm ?? 0):0))});
      findElement([paragraph],'run').children.unshift({'hp:ctrl':[column]});
    };
    let id = 1000000002;
    const next=()=>id++;
    const options=settings.documentOptions;
    const generated = [];
    let gridBorder;
    if(options.tableItems.length){
      const fills=findElement(header,'borderFills');const fill=clone(findElement(header,'borderFill','2').node);
      gridBorder=String(Math.max(...[...elements(fills.children)].filter(e=>e.localName==='borderFill').map(e=>Number(e.attributes['@_id'])))+1);
      fill[':@']['@_id']=gridBorder;
      for(const edge of [...elements([fill])].filter(e=>['leftBorder','rightBorder','topBorder','bottomBorder'].includes(e.localName)))Object.assign(edge.attributes,{'@_type':'SOLID','@_width':'0.12 mm','@_color':'#333333'});
      fills.children.push(fill);fills.attributes['@_itemCnt']=String(fills.children.length);
    }
    const element=(name,attributes={},children=[])=>({[name]:children,':@':Object.fromEntries(Object.entries(attributes).map(([key,value])=>['@_'+key,String(value)]))});
    const table=(block)=>{
      const width=Math.round(block.width*100),left=Math.round(width*block.leftFraction),rowHeight=Math.round(block.rowHeight*100);
      const rows=[];
      for(let row=0;row<3;row++){const cells=[];for(let col=0;col<2;col++){const text=block.rows[row][col];cells.push(element('hp:tc',{name:'',header:row===0?1:0,hasMargin:1,protect:0,editable:0,dirty:1,borderFillIDRef:gridBorder},[
        element('hp:subList',{id:'',textDirection:'HORIZONTAL',lineWrap:'BREAK',vertAlign:'CENTER',linkListIDRef:0,linkListNextIDRef:0,textWidth:0,textHeight:0,hasTextRef:0,hasNumRef:0},text.split('\n').map(line=>paragraphFrom(bodyTemplate,next(),line))),
        element('hp:cellAddr',{colAddr:col,rowAddr:row}),element('hp:cellSpan',{colSpan:1,rowSpan:1}),element('hp:cellSz',{width:col===0?left:width-left,height:rowHeight}),element('hp:cellMargin',{left:300,right:300,top:200,bottom:200})]));}rows.push(element('hp:tr',{},cells));}
      const tbl=element('hp:tbl',{id:next(),zOrder:0,numberingType:'TABLE',textWrap:'TOP_AND_BOTTOM',textFlow:'BOTH_SIDES',lock:0,dropcapstyle:'None',pageBreak:'CELL',repeatHeader:1,rowCnt:3,colCnt:2,cellSpacing:0,borderFillIDRef:gridBorder,noAdjust:0},[
        element('hp:sz',{width,widthRelTo:'ABSOLUTE',height:rowHeight*3,heightRelTo:'ABSOLUTE',protect:0}),
        element('hp:pos',{treatAsChar:1,affectLSpacing:1,flowWithText:1,allowOverlap:0,holdAnchorAndSO:0,vertRelTo:'PARA',horzRelTo:'COLUMN',vertAlign:'TOP',horzAlign:'LEFT',vertOffset:0,horzOffset:0}),
        element('hp:outMargin',{left:0,right:0,top:0,bottom:0}),element('hp:inMargin',{left:0,right:0,top:0,bottom:0}),...rows]);
      return element('hp:p',{id:next(),paraPrIDRef:0,styleIDRef:0,pageBreak:0,columnBreak:0,merged:0},[element('hp:run',{charPrIDRef:0},[tbl,element('hp:t')])]);
    };
    for (const block of renderPlan.paragraphs) {
      const template=block.role==='title'?titleParagraph:block.role==='heading'?headingTemplate:bodyTemplate;
      const paragraph=format(block.type==='table'?table(block):paragraphFrom(template,next(),block.text),block,block.type==='table');
      Object.assign(paragraph[':@'],{'@_pageBreak':block.pageBreak?'1':'0','@_columnBreak':block.columnBreak?'1':'0'});
      if(block.columnStart)setColumns(paragraph,block.columnCount);
      generated.push(paragraph);
    }
    // Carry the trusted section properties in the first visible paragraph, without
    // retaining the template's otherwise invisible leading empty paragraph.
    const firstRun=findElement([generated[0]],'run');
    firstRun.children.unshift(clone(findElement(section,'secPr').node));
    root.node[root.name] = generated;
  }
  if (["font-size", "layout"].includes(stage)) {
    // Body text and writing areas use charPr 0. Title (7) and headings (8) keep 20/14 pt.
    findElement(header, "charPr", "0").attributes["@_height"] = String(Math.round(settings.fontSizePt * 100));
  }
  const orientation = settings.paper.orientation ?? "portrait";
  if (stage === "layout") {
    const [width, height] = PAPER_SIZES[settings.paper.size].map(mmToHwpUnit);
    const page = findElement(section, "pagePr");
    // HWPX stores the unrotated dimensions; NARROWLY is landscape, WIDELY is portrait.
    Object.assign(page.attributes, { "@_width": String(width), "@_height": String(height), "@_landscape": orientation === "landscape" ? "NARROWLY" : "WIDELY" });
    const margin = findElement(page.children, "margin");
    for (const side of ["top", "bottom", "left", "right"]) margin.attributes[`@_${side}`] = String(mmToHwpUnit(settings.marginsMm[side]));
    // The simple form has no header/footer/gutter content. Avoid invisible header offsets.
    Object.assign(margin.attributes, { "@_header": String(mmToHwpUnit(settings.headerFooterMm?.header ?? 0)), "@_footer": String(mmToHwpUnit(settings.headerFooterMm?.footer ?? 0)), "@_gutter": "0" });
    // Keep all original style IDs; append a font definition in each language group.
    const ids = {};
    for (const face of [...elements(header)].filter((item) => item.localName === "fontface")) {
      const fonts = face.children.filter((item) => item["hh:font"]);
      let font = fonts.find((item) => item[":@"]?.["@_face"] === settings.fontFamily);
      if (!font) {
        font = clone(fonts.at(-1));
        Object.assign(font[":@"], { "@_id": String(Math.max(...fonts.map((item) => Number(item[":@"]["@_id"]))) + 1), "@_face": settings.fontFamily });
        face.children.push(font);
      }
      face.attributes["@_fontCnt"] = String(face.children.filter((item) => item["hh:font"]).length);
      ids[face.attributes["@_lang"].toLowerCase()] = font[":@"]["@_id"];
    }
    for (const ref of [...elements(header)].filter((item) => item.localName === "fontRef")) {
      for (const lang of ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"]) ref.attributes[`@_${lang}`] = ids[lang];
    }
    const spacing = settings.lineSpacing;
    for (const paragraphStyle of [...elements(header)].filter(item=>item.localName==='paraPr')) paragraphStyle.attributes['@_snapToGrid']='0';
    for (const line of [...elements(header)].filter((item) => item.localName === "lineSpacing")) {
      Object.assign(line.attributes, { "@_type": spacing.unit === "pt" ? "FIXED" : "PERCENT", "@_value": String(Math.round(spacing.value * (spacing.unit === "percent" ? 1 : 100))), "@_unit": "HWPUNIT" });
    }
  }
  for(const [id,height] of tableHostStyles) {
    for(const line of [...elements([findElement(header,'paraPr',id).node])].filter(e=>e.localName==='lineSpacing'))
      Object.assign(line.attributes,{'@_type':'FIXED','@_value':String(Math.round(height*100)),'@_unit':'HWPUNIT'});
  }
  zip.file("Contents/section0.xml", xml(section));
  zip.file("Contents/header.xml", xml(header));
  const metadata = xmlParser.parse(await zip.file("Contents/content.hpf").async("string"));
  const metadataTitle = findElement(metadata, "title");
  metadataTitle.node[metadataTitle.name] = [{ "#text": title }];
  const hasLimits=settings.limits?.maxPages!=null || settings.limits?.titleMaxLines!=null || settings.sectionStyles?.some(s=>s.maxLines!=null);
  if(hasLimits) {
    const meta=findElement(metadata,'metadata');
    meta.children.push({'opf:meta':[{'#text':JSON.stringify({limits:settings.limits ?? {},sections:(settings.sectionStyles || []).filter(s=>s.maxLines!=null).map(s=>({item:s.item,maxLines:s.maxLines}))})}],':@':{'@_name':'HanformConstraints'}});
  }
  for (const element of elements(metadata)) {
    if (element.localName === "meta" && ["CreatedDate", "ModifiedDate"].includes(element.attributes["@_name"])) element.node[element.name] = [{ "#text": new Date().toISOString() }];
  }
  zip.file("Contents/content.hpf", xml(metadata));
  const text = [...elements(section)].filter((element) => element.localName === "t").map((element) => element.children.map((node) => node["#text"] ?? "").join("")).join("\n");
  zip.file("Preview/PrvText.txt", text);
  zip.remove("Preview/PrvImage.png"); // Do not retain an image of the old template.
  // Keep the original entry order and mimetype first/uncompressed; add no directory entries.
  const packed = new JSZip();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    packed.file(name, await zip.file(name).async("nodebuffer"), { compression: name === "mimetype" ? "STORE" : "DEFLATE", createFolders: false });
  }
  const buffer = await packed.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const validation = await validateHwpx(buffer);
  const warnings = [
    `글꼴 '${settings.fontFamily}'이 문서를 여는 컴퓨터에 없으면 한글이 다른 글꼴로 대체할 수 있습니다.`,
    "파일 내부 구조만 자동 검사합니다. 한글에서 열어 실제 배치·쪽수를 확인해 주세요. 항목 수에 따라 쪽수가 달라질 수 있습니다.",
    ...(settings.paper.orientation == null ? ["용지 방향이 미지정이라 세로 방향으로 생성했습니다."] : []),
    ...(hasLimits ? ['쪽수·줄 수 제한을 문서 메타데이터와 설정에 보관했습니다. 빈 양식은 작성 후의 분량을 강제하거나 검사할 수 없으므로, 내용을 작성한 뒤 한글에서 최종 분량을 확인해 주세요.'] : []),
  ];
  return {
    renderPlan: stage==="layout"?renderPlan:undefined, layoutVersion:renderPlan.version,
    buffer, fileName: safeFileName(title), validation: { ...validation, layoutVerified: false }, warnings,
    appliedSettings: { title, requiredItems: settings.requiredItems, documentOptions:settings.documentOptions, fontFamily: settings.fontFamily, lineSpacing: settings.lineSpacing, fontSizePt: settings.fontSizePt, titleSizePt: 20, headingSizePt: 14, paper: { ...settings.paper, orientation }, marginsMm: settings.marginsMm, ...optionalSettings(settings) },
    constraintChecks: {status:'requires-final-content',limits:settings.limits ?? {},sections:(settings.sectionStyles || []).filter(s=>s.maxLines!=null).map(s=>({item:s.item,maxLines:s.maxLines})),pageCountVerified:false,lineCountsVerified:false},
    unsupportedSettings: [],
  };
}
