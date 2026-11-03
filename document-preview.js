import { formatSetting, PAPER_SIZES, ALIGNMENTS, buildDocumentPlan, DOCUMENT_LAYOUT_VERSION } from "./settings-model.js";

export function previewModel(settings, title = settings.documentTitle ?? "") {
  const dimensions = PAPER_SIZES[settings.paper?.size];
  const landscape = settings.paper?.orientation === "landscape";
  const [width, height] = dimensions ? (landscape ? [...dimensions].reverse() : dimensions) : [210, 297];
  const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
  return {
    title: title.trim(),
    width, height, geometryEstimated: !dimensions,
    bodySize: numberOr(settings.fontSizePt, 10),
    fontFamily: settings.fontFamily || "함초롬바탕",
    lineSpacing: settings.lineSpacing?.unit === "pt" ? `${settings.lineSpacing.value}pt` : String(settings.lineSpacing?.unit === "multiple" ? settings.lineSpacing.value : (settings.lineSpacing?.value ?? 160) / 100),
    margins: Object.fromEntries(["top", "bottom", "left", "right"].map((side) => [side, numberOr(settings.marginsMm?.[side], 20)])),
    items: [...(settings.requiredItems ?? [])],
    options:settings.documentOptions || {coverPage:false,contentsPage:false,tableItems:[]},
    columns:settings.columns ?? {}, alignment:settings.alignment ?? {}, sectionStyles:settings.sectionStyles ?? [],
    requested: [
      ["용지", `${formatSetting("paper.size", settings.paper?.size)} · ${settings.paper?.orientation ? formatSetting("paper.orientation", settings.paper.orientation) : "방향 미지정 (생성 시 세로)"}`],
      ["여백 (위 / 아래 / 왼쪽 / 오른쪽)", ["top", "bottom", "left", "right"].map((side) => formatSetting(`marginsMm.${side}`, settings.marginsMm?.[side])).join(" / ")],
      ["본문 크기", formatSetting("fontSizePt", settings.fontSizePt)],
      ["제목 / 항목 제목 크기",`${settings.typography?.titleSizePt ?? 20} / ${settings.typography?.headingSizePt ?? 14} pt`],
      ["글꼴", formatSetting("fontFamily", settings.fontFamily)],
      ["줄 간격", settings.lineSpacing?.value == null ? "미지정" : formatSetting("lineSpacing", settings.lineSpacing)],
      ["필수 항목", `${settings.requiredItems.length}개`],
      ["머리글 / 바닥글 위치", `${settings.headerFooterMm?.header ?? 0} / ${settings.headerFooterMm?.footer ?? 0} mm`],
      ["본문 배치", `${settings.columns?.count ?? 1}단 · 단 간격 ${settings.columns?.gapMm ?? 0} mm · ${settings.columns?.startItem ? settings.columns.startItem+'부터' : settings.columns?.scope==='body'?'본문부터':'제목부터'}`],
      ["정렬", `제목 ${ALIGNMENTS[settings.alignment?.title] ?? '기본값'} / 본문 ${ALIGNMENTS[settings.alignment?.body] ?? '기본값'}`],
      ...((settings.limits?.maxPages || settings.limits?.titleMaxLines || settings.sectionStyles?.some(s=>s.maxLines)) ? [["작성 후 확인할 분량", [settings.limits?.maxPages?`전체 ${settings.limits.maxPages}쪽 이내`:null,settings.limits?.titleMaxLines?`제목 ${settings.limits.titleMaxLines}줄 이내`:null,...(settings.sectionStyles ?? []).filter(s=>s.maxLines).map(s=>`${s.item} ${s.maxLines}줄 이내`)].filter(Boolean).join(' · ')]] : []),
    ],
  };
}

export function renderDocumentPreview(container, settings, title, { confirmed = false, stale = false, renderPlan = null } = {}) {
  const model = previewModel(settings, title);
  const fromFile=renderPlan?.version===DOCUMENT_LAYOUT_VERSION;
  const plan=fromFile?renderPlan:buildDocumentPlan(settings,title);
  const doc = container.ownerDocument;
  const element = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const heading=element('h3','문서 미리보기');heading.id='preview-title';
  const state=element('span',stale?'재분석 필요':fromFile?'생성 파일 기준':confirmed?'확정 완료':'편집 중','preview-state');
  const header=element('div',undefined,'preview-heading');header.append(heading,state);
  const summary=element('dl',undefined,'preview-summary');
  for(const [label,value] of model.requested)summary.append(element('dt',label),element('dd',value));
  const detail=element('details',undefined,'preview-settings');detail.append(element('summary','적용 설정 보기'),summary);
  const sheets=element('div',undefined,'preview-pages');
  for(const page of plan.pages){
    const frame=element('div',undefined,'preview-paper-frame');
    const sheet=element('div',undefined,'preview-paper preview-planned-paper');
    sheet.setAttribute('aria-label',`${page.index+1}쪽 ${ {cover:'표지',contents:'목차',body:'본문'}[page.kind] }`);
    sheet.dataset.page=String(page.index+1);
    sheet.style.aspectRatio=`${plan.widthPt} / ${plan.heightPt}`;
    sheet.style.setProperty('--paper-width-pt',String(plan.widthPt));
    sheet.style.fontFamily=`"${plan.fontFamily.replace(/["\\]/g,'')}", serif`;
    const scale=number=>`calc(${number} * 100cqw / var(--paper-width-pt))`;
    for(const block of page.blocks){
      const node=element(block.type==='table'?'table':'div',block.type==='table'?undefined:block.text,block.type==='table'?'preview-layout-table':'preview-paragraph');
      node.dataset.role=block.role;
      Object.assign(node.style,{left:scale(block.x),top:scale(block.y),width:scale(block.width),height:scale(block.height),fontSize:scale(block.fontSizePt),fontWeight:block.bold?'700':'400',lineHeight:scale(block.height),textAlign:block.alignment==='distribute'?'justify':block.alignment});
      if(block.type==='table'){
        node.style.lineHeight=scale(block.cellLineHeight);
        const columns=element('colgroup'),left=element('col'),right=element('col');
        left.style.width=`${block.leftFraction*100}%`;right.style.width=`${(1-block.leftFraction)*100}%`;columns.append(left,right);node.append(columns);
        const body=element('tbody');
        for(const row of block.rows){const tr=element('tr');tr.style.height=scale(block.rowHeight);
          for(const text of row){const td=element('td',text||'\u00a0');td.style.whiteSpace='pre';td.style.padding=[block.padding.top,block.padding.right,block.padding.bottom,block.padding.left].map(scale).join(' ');tr.append(td);}
          body.append(tr);
        }
        node.append(body);node.setAttribute('aria-label',`${block.item} 작성 표`);
      }
      sheet.append(node);
    }
    frame.append(sheet,element('p',`${page.index+1} / ${plan.pages.length}쪽`,'preview-page-number'));sheets.append(frame);
  }
  const note=element('p','생성 파일과 같은 문단·표·명시적 쪽 나눔을 표시합니다. 글꼴은 이 기기에 설치된 글꼴로 표시되며, 한글의 글꼴 처리에 따라 글자 모양과 세부 위치가 달라질 수 있습니다.','preview-note');
  if(model.geometryEstimated||settings.fontSizePt==null||Object.values(settings.marginsMm ?? {}).some(v=>v==null))note.append(' 미지정 값은 미리보기용 임시값입니다. 생성 전 설정을 완료해 주세요.');
  for(const warning of plan.warnings)note.append(' '+warning);
  container.replaceChildren(header,sheets,detail,note);
}
