// Shared by the browser and server. Missing conditions remain null.
export const PAPER_SIZES = {
  A3: [297, 420], A4: [210, 297], A5: [148, 210],
  B4: [250, 353], B5: [176, 250], LETTER: [215.9, 279.4], LEGAL: [215.9, 355.6],
};

export const DOCUMENT_LAYOUT_VERSION = 4;
const hwpMm = value => Math.round(value * 7200 / 25.4) / 100;
export function documentLineHeight(size, spacing) {
  return Math.round((spacing?.unit === 'pt' ? spacing.value : size * (spacing?.unit === 'multiple' ? spacing.value : (spacing?.value ?? 160) / 100)) * 100) / 100;
}

// Both the HWPX writer and browser use these paragraphs and explicit breaks.
// The blank form has no user-authored body text to paginate separately.
export function buildDocumentPlan(settings, title=null) {
  const dimensions=PAPER_SIZES[settings.paper?.size] ?? PAPER_SIZES.A4;
  const [widthMm,heightMm]=settings.paper?.orientation==='landscape'?[dimensions[1],dimensions[0]]:dimensions;
  const widthPt=hwpMm(widthMm),heightPt=hwpMm(heightMm);
  const margins=Object.fromEntries(['top','bottom','left','right'].map(side=>[side,hwpMm(Number.isFinite(settings.marginsMm?.[side])?settings.marginsMm[side]:20)]));
  const bodySize=Number.isFinite(settings.fontSizePt)?settings.fontSizePt:10;
  const spacing=settings.lineSpacing?.value>0?settings.lineSpacing:{value:160,unit:'percent'};
  const options=settings.documentOptions ?? {coverPage:false,contentsPage:false,tableItems:[]};
  const items=settings.requiredItems ?? [],count=settings.columns?.count ?? 1,gap=hwpMm(settings.columns?.gapMm ?? 0);
  const startItem=settings.columns?.startItem ?? (settings.columns?.scope==='body'?items.find(item=>!/^(?:abstract|초록|국문초록|영문초록|요약|목차|표지)$/i.test(item)):null);
  const pages=[],paragraphs=[],warnings=[];
  const bodyTop=margins.top+hwpMm(settings.headerFooterMm?.header ?? 0);
  const usableWidth=widthPt-margins.left-margins.right,bottom=heightPt-margins.bottom-hwpMm(settings.headerFooterMm?.footer ?? 0);
  let page,column=0,columnCount=1,areaTop=bodyTop,y=areaTop,pendingPage=false,pendingColumn=false,pendingColumns=true;
  function newPage(kind,columns=1){page={kind,index:pages.length,widthPt,heightPt,blocks:[]};pages.push(page);column=0;columnCount=columns;areaTop=bodyTop;y=areaTop;pendingPage=pages.length>1;pendingColumn=false;pendingColumns=true;}
  function useColumns(columns){if(columnCount===columns)return;columnCount=columns;column=0;areaTop=y;pendingColumns=true;}
  const columnWidth=()=>(usableWidth-(columnCount-1)*gap)/columnCount;
  function advance(height){
    if(y+height<=bottom+0.01)return;
    if(height>bottom-bodyTop){warnings.push('글자 크기·줄 간격 또는 표 높이가 한 쪽의 작성 영역보다 큽니다.');return;}
    if(columnCount>1&&height<=bottom-areaTop&&column+1<columnCount){column++;y=areaTop;pendingColumn=true;}
    else newPage(page.kind,columnCount);
  }
  function push(block){
    const placed={...block,page:page.index,column,columnCount,x:margins.left+column*(columnWidth()+gap),y,width:columnWidth(),pageBreak:pendingPage,columnBreak:pendingColumn,columnStart:pendingColumns};
    page.blocks.push(placed);paragraphs.push(placed);y+=block.height;pendingPage=false;pendingColumn=false;pendingColumns=false;
  }
  // Conservative wrapping is made explicit in the HWPX as well as the preview.
  function lines(text,size,width){
    const result=[];let line='',used=0;
    for(const char of text){const unit=/[\u2e80-\uffef]/u.test(char)?1:/\s/u.test(char)?0.34:/[MW@#%]/.test(char)?0.95:/[ilI.,:;'!|]/.test(char)?0.3:char.codePointAt(0)>0xffff?1.2:0.64;const extent=unit*size;
      if(extent>width)warnings.push('단 너비보다 큰 글자가 있습니다. 단 수나 글자 크기를 줄여 주세요.');
      if(line&&used+extent>width){result.push(line);line='';used=0;}line+=char;used+=extent;
    }
    if(line||!result.length)result.push(line);return result;
  }
  function paragraph(text,role='body',item=null,keep=false){
    const rule=settings.sectionStyles?.find(s=>s.item===item);
    const fontSizePt=role==='title'?(settings.typography?.titleSizePt ?? 20):rule?.fontSizePt ?? (role==='heading'?(settings.typography?.headingSizePt ?? 14):bodySize);
    const height=documentLineHeight(fontSizePt,spacing);
    const alignment=role==='title'?(settings.alignment?.title ?? 'center'):(rule?.alignment ?? (role==='heading'?settings.alignment?.heading:null) ?? settings.alignment?.body ?? 'justify');
    return lines(text,fontSizePt,columnWidth()).map((line,index,array)=>({type:'paragraph',role,item,text:line,fontSizePt,bold:role==='title'||role==='heading',alignment,height,keepWithNext:keep||index<array.length-1}));
  }
  function group(blocks){advance(blocks.reduce((sum,b)=>sum+b.height,0));for(const block of blocks)push(block);}
  // A blank form must expose writing areas in every requested column, even
  // before the user types enough text to fill the left column naturally.
  // Keep each heading with its writing area and write the same explicit column
  // breaks into HWPX; balancing only the browser's CSS would diverge again.
  function balancedColumns(groups){
    let offset=0;
    const heightOf=blocks=>blocks.reduce((sum,b)=>sum+b.height,0);
    while(offset<groups.length){
      const capacity=bottom-areaTop;
      let end=offset,used=0,needed=1;
      for(;end<groups.length;end++){
        const height=heightOf(groups[end]);
        if(height>capacity+0.01)break;
        if(used+height>capacity+0.01){needed++;used=0;}
        if(needed>columnCount)break;
        used+=height;
      }
      if(end===offset){
        if(areaTop>bodyTop+0.01){newPage(page.kind,columnCount);continue;}
        warnings.push('글자 크기·줄 간격 또는 표 높이가 한 쪽의 작성 영역보다 큽니다.');
        for(const block of groups[offset++])push(block);
        continue;
      }
      const heights=groups.slice(offset,end).map(heightOf),columns=Math.min(columnCount,heights.length);
      let low=Math.max(...heights),high=capacity;
      // Find the shortest column height that can hold these intact item groups.
      for(let attempt=0;attempt<40;attempt++){
        const target=(low+high)/2;let columnsNeeded=1,height=0;
        for(const value of heights){if(height+value>target){columnsNeeded++;height=0;}height+=value;}
        if(columnsNeeded<=columns)high=target;else low=target;
      }
      used=0;
      for(let index=offset;index<end;index++){
        const height=heights[index-offset],remaining=end-index,emptyColumns=columns-column-1;
        if(used>0 && column+1<columns && (used+height>high+0.01 || remaining===emptyColumns)){
          column++;y=areaTop;pendingColumn=true;used=0;
        }
        for(const block of groups[index])push(block);
        used+=height;
      }
      offset=end;
      if(offset<groups.length)newPage(page.kind,columnCount);
    }
  }
  const safeTitle=(title || settings.documentTitle || '').trim()||'문서 양식';
  const label=(item,index)=>options.numberedItems===false?item:`${index+1}. ${item}`;
  if(options.coverPage){newPage('cover');group(paragraph(safeTitle,'title'));for(const text of ['작성자:','소속:','작성일:'])group(paragraph(text));}
  if(options.contentsPage){newPage('contents');group(paragraph('목차','title'));for(const [index,item] of items.entries())group(paragraph(label(item,index)));}
  newPage('body',count>1&&!startItem?count:1);
  const columnGroups=[],mainTitle=paragraph(safeTitle,'title');
  if(columnCount>1)columnGroups.push(mainTitle);else group(mainTitle);
  for(const [index,item] of items.entries()){
    if(item===startItem&&count>1)useColumns(count);
    const blocks=paragraph(label(item,index),'heading',item,true);
    if(options.tableItems?.includes(item)){
      const rule=settings.sectionStyles?.find(s=>s.item===item),cellSize=rule?.fontSizePt ?? bodySize;
      const labelWidths=[Math.round(columnWidth()*100/3)/100-6,columnWidth()-Math.round(columnWidth()*100/3)/100-6];
      if(labelWidths.some(width=>width<cellSize))warnings.push(`${item}: 표 셀에 글자가 들어갈 너비가 부족합니다. 단 수나 글자 크기를 줄여 주세요.`);
      const labels=['구분','내용'].map((label,index)=>lines(label,cellSize,labelWidths[index]));
      const rowHeight=Math.max(28,Math.round(cellSize*200+1000)/100,documentLineHeight(cellSize,spacing)*Math.max(...labels.map(parts=>parts.length))+4);
      blocks.push({type:'table',role:'body',item,fontSizePt:cellSize,bold:false,alignment:rule?.alignment ?? settings.alignment?.body ?? 'justify',height:rowHeight*3,rowHeight,cellLineHeight:documentLineHeight(cellSize,spacing),rows:[labels.map(parts=>parts.join('\n')),['',''],['','']],leftFraction:1/3,padding:{left:3,right:3,top:2,bottom:2},keepWithNext:false});
    }else {
      const maxLines=settings.sectionStyles?.find(rule=>rule.item===item)?.maxLines;
      if(maxLines!==1)blocks.push(...paragraph('','body',item,true));
      blocks.push(...paragraph('','body',item,false));
    }
    if(columnCount>1)columnGroups.push(blocks);else group(blocks);
  }
  if(columnGroups.length){
    if(columnGroups[0][0].role==='title' && columnGroups.length>1){
      columnGroups[0].at(-1).keepWithNext=true;
      columnGroups.splice(0,2,[...columnGroups[0],...columnGroups[1]]);
    }
    balancedColumns(columnGroups);
  }
  // Fit editable writing lines into the existing page and column breaks.
  // A full-width introduction shifts both columns below it by the same amount.
  for(const sheet of pages.filter(sheet=>sheet.kind==='body')){
    const tracks=[];
    for(const block of sheet.blocks){
      if(!tracks.length||block.columnStart||block.columnBreak)tracks.push([]);
      tracks.at(-1).push(block);
    }
    const finalBottom=Math.max(...sheet.blocks.map(block=>block.y+block.height));
    const reserve=documentLineHeight(bodySize,spacing)*2;
    let introductionGrowth=0;
    sheet.blocks=tracks.flatMap((track,index)=>{
      const introduction=index===0&&track[0].columnCount===1&&tracks.length>1;
      const last=track.at(-1);
      let available=Math.max(0,bottom-reserve-introductionGrowth-(introduction?finalBottom:last.y+last.height));
      if(introduction)available=Math.min(available,(bottom-bodyTop)*0.1);
      const writingEnds=track.filter(block=>block.role==='body'&&block.type==='paragraph'&&!block.text&&!block.keepWithNext);
      const perItem=available/Math.max(1,writingEnds.length);
      let growth=0;
      const expanded=track.flatMap((block,blockIndex)=>{
        block.y+=introductionGrowth+growth;
        const next=track[blockIndex+1];
        const titleGap=block.role==='title'&&next&&next.role!=='title';
        if(!titleGap&&!writingEnds.includes(block))return [block];
        const line=titleGap?paragraph('')[0]:block;
        const maxLines=settings.sectionStyles?.find(rule=>rule.item===block.item)?.maxLines ?? Infinity;
        const limit=titleGap?1:Math.max(0,Math.min(6,maxLines-2));
        const extra=line.height>0?Math.min(limit,Math.floor(Math.min(available,titleGap?available:perItem)/line.height)):0;
        const added=Array.from({length:extra},(_,i)=>({
          ...block,...line,y:block.y+block.height+i*line.height,
          pageBreak:false,columnBreak:false,columnStart:false,keepWithNext:titleGap&&block.keepWithNext,
        }));
        growth+=extra*line.height;
        available-=extra*line.height;
        return [block,...added];
      });
      if(introduction)introductionGrowth=growth;
      return expanded;
    });
  }
  paragraphs.splice(0,paragraphs.length,...pages.flatMap(sheet=>sheet.blocks));
  return {version:DOCUMENT_LAYOUT_VERSION,title:safeTitle,widthMm,heightMm,widthPt,heightPt,margins,bodyTop,bodyBottom:bottom,bodySize,fontFamily:settings.fontFamily||'함초롬바탕',lineSpacing:spacing,gapPt:gap,pages,paragraphs,warnings:[...new Set(warnings)]};
}

export const FIELD_LABELS = {
  "paper.size": "용지 크기", "paper.orientation": "용지 방향",
  "marginsMm.top": "위쪽 여백", "marginsMm.bottom": "아래쪽 여백",
  "marginsMm.left": "왼쪽 여백", "marginsMm.right": "오른쪽 여백",
  documentTitle:"문서 제목", "typography.titleSizePt":"제목 글자 크기", "typography.headingSizePt":"항목 제목 글자 크기",
  "documentOptions.coverPage":"표지", "documentOptions.contentsPage":"목차 페이지", "documentOptions.tableItems":"작성 표 항목", "documentOptions.numberedItems":"항목 번호 표시",
  fontFamily: "글꼴", fontSizePt: "본문 글자 크기", lineSpacing: "줄 간격", requiredItems: "필수 항목",
  "headerFooterMm.header": "머리글 위치", "headerFooterMm.footer": "바닥글 위치",
  "columns.count": "단 수", "columns.gapMm": "단 사이 간격", "columns.scope": "다단 적용 범위",
  "columns.startItem": "다단 시작 항목", "alignment.title": "제목 정렬", "alignment.heading":"항목 제목 정렬", "alignment.body": "본문 정렬",
  "limits.maxPages": "최대 쪽수", "limits.titleMaxLines": "제목 최대 줄 수", sectionStyles: "항목별 서식",
};

export const ALIGNMENTS = { left: "왼쪽", right: "오른쪽", center: "가운데", justify: "양쪽", distribute: "배분" };
export const sectionField = (item, property) => `sectionStyles.${encodeURIComponent(item).replace(/\./g,'%2E')}.${property}`;
export function sectionPath(path) {
  if(typeof path!=="string")return null;
  const match = /^sectionStyles\.([^.]+)\.(alignment|maxLines|fontSizePt)$/.exec(path);
  if (!match) return null;
  try { const item = decodeURIComponent(match[1]); return item && item.length <= 100 ? { item, property: match[2] } : null; } catch { return null; }
}
export const fieldLabel = path => { if(typeof path!=="string")return undefined;const section = sectionPath(path); return section ? `${section.item} ${{alignment:'정렬',maxLines:'최대 줄 수',fontSizePt:'글자 크기'}[section.property]}` : Object.hasOwn(FIELD_LABELS,path)?FIELD_LABELS[path]:undefined; };
export const isNumericField = path => /^(?:marginsMm\.|headerFooterMm\.|limits\.)/.test(path) || ['fontSizePt','columns.count','columns.gapMm'].includes(path) || path.startsWith('typography.') || /\.(?:maxLines|fontSizePt)$/.test(path);

// Canonical optional groups are shared by generation and local backup/import.
export function optionalSettings(raw) {
  const result = {};
  for (const [group, keys] of Object.entries({headerFooterMm:['header','footer'],columns:['count','gapMm','scope','startItem'],alignment:['title','body','heading'],typography:['titleSizePt','headingSizePt'],limits:['maxPages','titleMaxLines']})) {
    if (raw[group] != null) result[group] = Object.fromEntries(keys.map(key => [key, raw[group][key] ?? null]));
  }
  if (raw.sectionStyles != null) result.sectionStyles = raw.sectionStyles.map(style => ({item:style.item,alignment:style.alignment ?? null,maxLines:style.maxLines ?? null,fontSizePt:style.fontSizePt ?? null}));
  if(raw.documentTitle!=null)result.documentTitle=raw.documentTitle;
  return result;
}

export function emptySettings() {
  return {
    schemaVersion: 1,
    paper: { size: null, orientation: null },
    marginsMm: { top: null, bottom: null, left: null, right: null },
    fontFamily: null, fontSizePt: null,
    lineSpacing: { value: null, unit: null }, requiredItems: [],
  };
}

// Editing an item list must not leave hidden formatting/table references behind.
export function reconcileItemReferences(settings) {
  const items=new Set(settings.requiredItems);
  if(settings.sectionStyles)settings.sectionStyles=settings.sectionStyles.filter(style=>items.has(style.item));
  if(settings.columns?.startItem && !items.has(settings.columns.startItem))settings.columns.startItem=null;
  if(settings.documentOptions?.tableItems)settings.documentOptions.tableItems=settings.documentOptions.tableItems.filter(item=>items.has(item));
  return settings;
}

export function getSetting(settings, path) {
  const section = sectionPath(path);
  if (section) return settings.sectionStyles?.find(style => style.item === section.item)?.[section.property];
  return path.split(".").reduce((value, key) => value?.[key], settings);
}

export function setSetting(settings, path, value) {
  const section = sectionPath(path);
  if (section) {
    settings.sectionStyles ??= [];
    let style = settings.sectionStyles.find(style => style.item === section.item);
    if (!style) { style = {item:section.item}; settings.sectionStyles.push(style); }
    style[section.property] = value;
    return;
  }
  if (!Object.hasOwn(FIELD_LABELS, path)) throw new Error("지원하지 않는 설정 항목입니다.");
  const keys = path.split(".");
  if (keys.length === 1) settings[path] = value;
  else {if(keys[0]==='documentOptions')settings.documentOptions ??= {coverPage:false,contentsPage:false,tableItems:[]};(settings[keys[0]] ??= {})[keys[1]]=value;}
}

export function formatSetting(path, value) {
  if (value === null || value === undefined) return "미지정";
  if (typeof value === "boolean")return value?"사용":"사용 안 함";
  if (path === "paper.orientation") return value === "portrait" ? "세로" : "가로";
  if (/^(marginsMm|headerFooterMm)\./.test(path) || path === 'columns.gapMm') return `${value} mm`;
  if (path === "fontSizePt" || path.endsWith('.fontSizePt') || path.startsWith("typography.")) return `${value} pt`;
  if (path.startsWith('alignment.') || path.endsWith('.alignment')) return ALIGNMENTS[value] ?? String(value);
  if (path === 'columns.scope') return value === 'body' ? '본문부터' : '제목부터';
  if (path === "lineSpacing") return `${value.value}${{ percent: "%", pt: " pt", multiple: "배" }[value.unit] ?? " (단위 미지정)"}`;
  if (path === "requiredItems") return value.join(" · ");
  return String(value);
}

export function validateSettings(settings) {
  const warnings = [];
  const warn = (type, field, message) => warnings.push({ type, field, message });
  if(!settings||typeof settings!=='object'||Array.isArray(settings))return [{type:'invalid',field:null,message:'문서 설정은 JSON 객체여야 합니다.'}];
  const size = settings.paper?.size;
  const knownPaper=typeof size==='string' && Object.hasOwn(PAPER_SIZES,size);
  if(settings.schemaVersion!==1)warn('invalid',null,'지원하는 문서 설정 버전이 아닙니다.');
  if (!size) warn("missing", "paper.size", "용지 크기를 지정해 주세요.");
  else if (!knownPaper) warn("invalid", "paper.size", "지원하는 용지 크기를 선택해 주세요.");
  if (settings.paper?.orientation != null && !["portrait", "landscape"].includes(settings.paper.orientation)) {
    warn("invalid", "paper.orientation", "용지 방향은 세로 또는 가로여야 합니다.");
  }
  for (const side of ["top", "bottom", "left", "right"]) {
    const path = `marginsMm.${side}`;
    const value = settings.marginsMm?.[side];
    if (value == null) warn("missing", path, `${FIELD_LABELS[path]}을 지정해 주세요. (mm)`);
    else if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 150) {
      warn("invalid", path, `${FIELD_LABELS[path]}은 0~150 mm 사이의 숫자로 입력해 주세요.`);
    }
  }
  if (knownPaper) {
    const [short, long] = PAPER_SIZES[size];
    const [width, height] = settings.paper.orientation === "landscape" ? [long, short] : [short, long];
    const m = settings.marginsMm;
    for (const [first, second, limit] of [["left", "right", width], ["top", "bottom", height]]) {
      if (typeof m?.[first] === "number" && typeof m?.[second] === "number" && m[first] + m[second] >= limit) {
        warn("invalid", `marginsMm.${first}`, "여백의 합이 용지 크기 이상입니다. 본문이 들어갈 공간을 확보해 주세요.");
      }
    }
  }
  if (typeof settings.fontFamily!=='string'||!settings.fontFamily.trim()) warn("missing", "fontFamily", "글꼴을 지정해 주세요.");
  else if (settings.fontFamily.length > 80) warn("invalid", "fontFamily", "글꼴 이름은 80자 이내로 입력해 주세요.");
  if(settings.documentTitle!=null && (typeof settings.documentTitle!=='string' || !settings.documentTitle.trim() || settings.documentTitle.length>80 || /[\x00-\x1f]/.test(settings.documentTitle)))warn('invalid','documentTitle','문서 제목은 한 줄, 80자 이내로 입력해 주세요.');
  const fontSize = settings.fontSizePt;
  if (fontSize == null) warn("missing", "fontSizePt", "본문 글자 크기를 지정해 주세요. (pt)");
  else if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize < 1 || fontSize > 100) {
    warn("invalid", "fontSizePt", "본문 글자 크기는 1~100 pt 사이로 입력해 주세요.");
  }
  const spacing = settings.lineSpacing;
  if (spacing?.value == null) warn("missing", "lineSpacing", "줄 간격과 단위를 지정해 주세요.");
  else {
    const maximum = typeof spacing.unit==='string' ? { percent: 500, pt: 200, multiple: 5 }[spacing.unit] : undefined;
    if (!maximum || typeof spacing.value !== "number" || !Number.isFinite(spacing.value) || spacing.value <= 0 || spacing.value > maximum) {
      warn("invalid", "lineSpacing", "줄 간격의 단위와 값을 확인해 주세요. (최대 500%, 200 pt, 5배)");
    }
  }
  if (!Array.isArray(settings.requiredItems) || settings.requiredItems.length === 0) warn("missing", "requiredItems", "필수 항목을 한 줄에 하나씩 입력해 주세요.");
  else if (settings.requiredItems.length > 50 || settings.requiredItems.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)) {
    warn("invalid", "requiredItems", "필수 항목은 최대 50개, 항목당 100자 이내로 입력해 주세요.");
  }
  const options=settings.documentOptions;
  if(options!=null && (typeof options!=='object' || typeof options.coverPage!=='boolean' || typeof options.contentsPage!=='boolean' || !Array.isArray(options.tableItems) || options.tableItems.length>50 || options.tableItems.some(item=>typeof item!=='string' || !(Array.isArray(settings.requiredItems)&&settings.requiredItems.includes(item))) || (options.numberedItems!=null&&typeof options.numberedItems!=='boolean'))) warn('invalid','documentOptions','표지·목차 설정과 표로 작성할 항목을 확인해 주세요. 표 항목은 필수 항목 이름과 같아야 합니다.');
  for (const [group, keys] of Object.entries({headerFooterMm:['header','footer'],columns:['count','gapMm','scope','startItem'],alignment:['title','body','heading'],typography:['titleSizePt','headingSizePt'],limits:['maxPages','titleMaxLines']})) {
    if (settings[group] != null && (typeof settings[group] !== 'object' || Array.isArray(settings[group]))) { warn('invalid',group,`${group}: 설정 형식이 잘못되었습니다.`); continue; }
    for (const key of keys) {
      const path = `${group}.${key}`, value = settings[group]?.[key];
      if (value == null) continue;
      let valid = true;
      if (group === 'headerFooterMm' || path === 'columns.gapMm') valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 150;
      else if (path === 'columns.count') valid = Number.isInteger(value) && value >= 1 && value <= 8;
      else if (path === 'columns.scope') valid = ['body','document'].includes(value);
      else if (path === 'columns.startItem') valid = typeof value === 'string' && Array.isArray(settings.requiredItems) && settings.requiredItems.includes(value);
      else if (group === 'alignment') valid = typeof value==='string' && Object.hasOwn(ALIGNMENTS,value);
      else if (group === 'typography') valid = typeof value==='number' && Number.isFinite(value) && value>=1 && value<=100;
      else if (group === 'limits') valid = Number.isInteger(value) && value > 0 && value <= 1000;
      if (!valid) warn('invalid',path,`${FIELD_LABELS[path]}의 값과 지원 범위를 확인해 주세요.`);
    }
  }
  const sections = settings.sectionStyles;
  if (sections != null) {
    if (!Array.isArray(sections) || sections.length > 50) warn('invalid','sectionStyles','항목별 서식은 최대 50개입니다.');
    else {
      const seen = new Set();
      for (const style of sections) {
        if (!style || typeof style.item !== 'string' || !style.item.trim() || style.item.length > 100 || seen.has(style.item)) { warn('invalid','sectionStyles','항목별 서식의 항목 이름이 비어 있거나 중복됩니다.'); continue; }
        seen.add(style.item);
        for (const property of ['alignment','maxLines','fontSizePt']) {
          const value = style[property]; if (value == null) continue;
          const valid = property === 'alignment' ? typeof value==='string' && Object.hasOwn(ALIGNMENTS,value) : property === 'maxLines' ? Number.isInteger(value) && value > 0 && value <= 1000 : typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100;
          if (!valid) warn('invalid',sectionField(style.item,property),`${style.item}: ${property} 값을 확인해 주세요.`);
        }
        if (Array.isArray(settings.requiredItems) && !settings.requiredItems.includes(style.item)) warn('invalid','sectionStyles',`${style.item}: 필수 항목에 없는 서식입니다. 항목 이름을 맞추거나 서식을 삭제해 주세요.`);
      }
    }
  }
  if (knownPaper) {
    const dims = PAPER_SIZES[size], width = settings.paper.orientation === 'landscape' ? dims[1] : dims[0];
    const usable = width - (settings.marginsMm?.left ?? 0) - (settings.marginsMm?.right ?? 0);
    if (usable - ((settings.columns?.count ?? 1)-1)*(settings.columns?.gapMm ?? 0) <= 0) warn('invalid','columns.gapMm','단 간격의 합이 본문 너비 이상입니다.');
  }
  if(knownPaper){
    const dims=PAPER_SIZES[size],height=settings.paper.orientation==='landscape'?dims[0]:dims[1];
    const vertical=(settings.marginsMm?.top ?? 0)+(settings.marginsMm?.bottom ?? 0)+(settings.headerFooterMm?.header ?? 0)+(settings.headerFooterMm?.footer ?? 0);
    if(vertical>=height)warn('invalid','headerFooterMm.header','위·아래·머리말·꼬리말 여백의 합이 용지 높이 이상입니다.');
  }
  if(settings.columns?.gapMm!=null && settings.columns?.count==null)warn('missing','columns.count','단 간격을 적용할 단 수를 지정해 주세요.');
  return warnings;
}
