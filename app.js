import { FIELD_LABELS, ALIGNMENTS, formatSetting, getSetting, setSetting, validateSettings, isNumericField, sectionField, reconcileItemReferences, UNTITLED_FORM_NAME, savedDocumentTitle } from "./settings-model.js";
import { renderDocumentPreview } from "./document-preview.js";
import { UPLOAD_LIMITS, checkUploadLimits, timedRequest, generatedFileBytes } from "./upload-limits.js";
import { initializeLibrary } from "./library-ui.js";

const form = document.querySelector("#template-form");
const requirements = document.querySelector("#requirements");
const characterCount = document.querySelector("#character-count");
const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const fileList = document.querySelector("#file-list");
const formMessage = document.querySelector("#form-message");
const exampleButtons = document.querySelectorAll(".example-chip");
const generateButton = document.querySelector("#generate-button");
const inputResult = document.querySelector("#input-result");
const resultContent = document.querySelector("#result-content");
const settingsForm = document.querySelector("#settings-form");
const settingsWarnings = document.querySelector("#settings-warnings");
const settingsJson = document.querySelector("#settings-json");
const settingsState = document.querySelector("#settings-state");
const downloadButton = document.querySelector("#download-settings");
const confirmButton = document.querySelector("#confirm-settings");
const hwpxButton = document.querySelector("#create-hwpx");
const documentTitle = document.querySelector("#document-title");
const hwpxStatus = document.querySelector("#hwpx-status");
const hwpxWarnings = document.querySelector("#hwpx-warnings");
const hwpxDownload = document.querySelector("#download-hwpx");
const hwpxExpiry = document.querySelector("#hwpx-expiry");
const resultLayout=document.createElement('div');resultLayout.className='result-layout';
const editorColumn=document.createElement('div');editorColumn.className='editor-column';
editorColumn.append(document.querySelector('.warning-panel'),settingsForm,document.querySelector('.json-details'),document.querySelector('.source-details'));
resultLayout.append(editorColumn,document.querySelector('.hwpx-panel'));inputResult.append(resultLayout);
const headingActions=document.createElement('div');headingActions.className='heading-actions';confirmButton.setAttribute('form','settings-form');headingActions.append(document.querySelector('#analysis-engine'),confirmButton);document.querySelector('.result-heading').append(headingActions);
const outputActions=document.createElement('div');outputActions.className='output-actions';outputActions.append(hwpxButton,document.querySelector('#save-template'),hwpxDownload,hwpxStatus);documentTitle.after(outputActions);
const inputSummary=document.querySelector('#input-summary'),toggleInput=document.querySelector('#toggle-input');
function collapseInput(collapsed) {
  form.hidden=collapsed;inputSummary.hidden=!collapsed;toggleInput.hidden=!analysis;
  toggleInput.textContent=collapsed?'입력 수정':'접기';toggleInput.setAttribute('aria-expanded',String(!collapsed));
  inputSummary.textContent=[requirements.value.trim().replace(/\s+/g,' ').slice(0,110),selectedFiles.length?`첨부 ${selectedFiles.length}개`:null].filter(Boolean).join(' · ')||'저장된 문서 설정';
  document.body.classList.toggle('has-analysis',Boolean(analysis));
}
toggleInput.addEventListener('click',()=>collapseInput(!form.hidden));
for(const link of document.querySelectorAll('.workflow-steps a'))link.addEventListener('click',event=>{if(link.dataset.step==='1')collapseInput(false);else if(!settings||inputResult.hidden){event.preventDefault();requirements.focus();}});
let generationVersion = 0;
let generatingHwpx = false;
let generatedFileUrl = null;
let generatedBlob = null;
let generatedPlan = null;
let generatedName = null;
const controls = {
  "paper.size": document.querySelector("#setting-paper"),
  "paper.orientation": document.querySelector("#setting-orientation"),
  "marginsMm.top": document.querySelector("#setting-top"),
  "marginsMm.bottom": document.querySelector("#setting-bottom"),
  "marginsMm.left": document.querySelector("#setting-left"),
  "marginsMm.right": document.querySelector("#setting-right"),
  fontFamily: document.querySelector("#setting-font"),
  fontSizePt: document.querySelector("#setting-font-size"),
  requiredItems: document.querySelector("#setting-items"),
};
const advanced = document.createElement('fieldset');
advanced.id = 'advanced-settings';
const legend = document.createElement('legend');legend.textContent = '배치·정렬과 분량 조건';advanced.append(legend);
const advancedGrid = document.createElement('div');advancedGrid.className = 'settings-grid';advanced.append(advancedGrid);
const makeControl = (parent,path,label,options) => {
  const wrapper=document.createElement('label');wrapper.textContent=label;
  const control=document.createElement(options?'select':'input');
  control.id='setting-'+path.replace(/\./g,'-');
  if(options){for(const [value,text] of Object.entries({'':'미지정',...options})){const option=document.createElement('option');option.value=value;option.textContent=text;control.append(option);}}
  else {control.type='number';control.min=path==='columns.count'||path.startsWith('limits.')||path.endsWith('maxLines')||/(?:fontSizePt|titleSizePt|headingSizePt)$/.test(path)?'1':'0';control.max=path==='columns.count'?'8':path.startsWith('limits.')||path.endsWith('maxLines')?'1000':/(?:fontSizePt|titleSizePt|headingSizePt)$/.test(path)?'100':'150';control.step=path==='columns.count'||path.startsWith('limits.')||path.endsWith('maxLines')?'1':'0.01';control.placeholder='미지정';}
  wrapper.append(control);parent.append(wrapper);return control;
};
for(const [path,label,options] of [
  ['typography.titleSizePt','제목 크기 (pt)'],['typography.headingSizePt','항목 제목 크기 (pt)'],
  ['headerFooterMm.header','머리글 위치 (mm)'],['headerFooterMm.footer','바닥글 위치 (mm)'],
  ['columns.count','단 수'],['columns.gapMm','단 간격 (mm)'],['columns.scope','다단 적용 범위',{document:'제목부터',body:'본문부터 (초록 뒤)'}],
  ['columns.startItem','다단 시작 항목',{}],['alignment.title','제목 정렬',ALIGNMENTS],['alignment.heading','항목 제목 정렬',ALIGNMENTS],['alignment.body','본문 정렬',ALIGNMENTS],
  ['limits.maxPages','최대 쪽수 (전체)'],['limits.titleMaxLines','제목 최대 줄 수'],
])controls[path]=makeControl(advancedGrid,path,label,options);
const sectionDetails=document.createElement('details');sectionDetails.className='section-options';const sectionSummary=document.createElement('summary');sectionSummary.textContent='항목별 서식';sectionDetails.append(sectionSummary);
const sectionControls=document.createElement('div');sectionControls.id='section-style-controls';sectionDetails.append(sectionControls);advanced.append(sectionDetails);
const limitNote=document.createElement('p');limitNote.className='config-note';limitNote.textContent='미지정인 추가 서식은 기본 템플릿을 따릅니다. 본문 다단은 초록·요약 뒤부터 적용하며 시작 항목을 직접 지정할 수 있습니다. 쪽수와 줄 수 조건은 양식·설정에 보관합니다. 빈 양식에서 작성 후 분량을 보장할 수 없으므로 최종 분량은 내용을 작성한 뒤 한글에서 확인하세요.';advanced.append(limitNote);
const advancedDetails=document.createElement('details');advancedDetails.id='advanced-options';advancedDetails.className='settings-disclosure';const advancedSummary=document.createElement('summary');advancedSummary.textContent='배치·정렬·분량';advancedDetails.append(advancedSummary,advanced);
settingsForm.insertBefore(advancedDetails,document.querySelector('#setting-items').closest('fieldset').nextSibling);
const extras=document.querySelector('#setting-cover').closest('fieldset'),extraDetails=document.createElement('details');extraDetails.className='settings-disclosure';const extraSummary=document.createElement('summary');extraSummary.textContent='표지·목차·작성 표';extras.before(extraDetails);extraDetails.append(extraSummary,extras);
const numberedLabel=document.createElement('label'),numberedControl=document.createElement('input');numberedControl.type='checkbox';numberedControl.id='setting-numbered';numberedControl.checked=true;numberedLabel.append(numberedControl,document.createTextNode(' 항목 번호 표시'));extras.append(numberedLabel);
function renderSectionControls() {
  sectionControls.replaceChildren();
  const start=controls['columns.startItem'],selected=settings.columns?.startItem ?? '';
  start.replaceChildren();for(const item of ['',...settings.requiredItems]){const option=document.createElement('option');option.value=item;option.textContent=item||'범위 설정에 따라 자동';start.append(option);}start.value=selected;
  for(const item of [...new Set([...settings.requiredItems,...(settings.sectionStyles||[]).map(s=>s.item)])]){
    const detail=document.createElement('details');detail.className='section-style';const title=document.createElement('summary');title.textContent=item;detail.append(title);
    detail.open=Boolean(settings.sectionStyles?.some(s=>s.item===item&&(s.alignment||s.fontSizePt||s.maxLines)));
    const group=document.createElement('div');group.className='settings-grid';detail.append(group);
    for(const [property,label,options] of [['alignment','정렬',ALIGNMENTS],['fontSizePt','글자 크기 (pt)'],['maxLines','최대 줄 수']]){
      const path=sectionField(item,property),control=makeControl(group,path,`${item} ${label}`,options);control.dataset.settingPath=path;control.value=getSetting(settings,path)??'';
    }
    const reset=document.createElement('button');reset.type='button';reset.className='secondary-button';reset.textContent=`${item} 개별 서식 초기화`;
    reset.addEventListener('click',()=>{settings.sectionStyles=settings.sectionStyles?.filter(s=>s.item!==item);for(const property of ['alignment','fontSizePt','maxLines'])reviewedFields.add(sectionField(item,property));confirmed=false;renderSectionControls();refreshSettings();});group.append(reset);
    sectionControls.append(detail);
  }
}
sectionControls.addEventListener('input',event=>{
  const path=event.target.dataset.settingPath;if(!settings||!path)return;
  const value=event.target.value;
  setSetting(settings,path,isNumericField(path)?event.target.validity.badInput?NaN:value===''?null:Number(value):value||null);
  reviewedFields.add(path);confirmed=false;refreshSettings();
});
const finalCheck=document.createElement('details');finalCheck.className='result-block final-check';
const finalHeading=document.createElement('summary');finalHeading.textContent='작성 후 PDF 분량 검사';
const finalNote=document.createElement('p');finalNote.className='config-note';finalNote.textContent='완성한 HWPX를 한글에서 PDF로 내보낸 뒤 첨부하세요. 확정한 최대 쪽수·제목 줄 수·항목별 줄 수와 비교합니다. 최대 30쪽·3.5MB이며 파일은 보관하거나 Gemini로 전송하지 않습니다. 복잡한 배치나 스캔 문서는 자동 판정이 제한됩니다.';
const finalLabel=document.createElement('label');finalLabel.textContent='검사할 PDF';
const finalFile=document.createElement('input');finalFile.type='file';finalFile.accept='.pdf,application/pdf';finalFile.id='final-document-file';finalLabel.htmlFor=finalFile.id;
const finalButton=document.createElement('button');finalButton.type='button';finalButton.className='secondary-button';finalButton.id='check-final-document';finalButton.textContent='확정한 분량 조건으로 검사';finalButton.disabled=true;
const finalResult=document.createElement('div');finalResult.id='final-document-result';finalResult.setAttribute('aria-live','polite');
finalCheck.append(finalHeading,finalNote,finalLabel,finalFile,finalButton,finalResult);inputResult.append(finalCheck);
let checkingFinal=false;
finalButton.addEventListener('click',async()=>{
  if(!settings||!confirmed||stale||checkingFinal)return;
  const file=finalFile.files[0];if(!file){finalResult.textContent='완성한 PDF를 선택해 주세요.';return;}
  if(file.size>UPLOAD_LIMITS.maxFileBytes){finalResult.textContent='PDF는 3.5MB 이하로 첨부해 주세요.';return;}
  invalidateFinalCheck();const requestId=++finalSequence,request=timedRequest(60000),controller=request.controller;finalController=controller;
  const signature=JSON.stringify([settings,documentTitle.value]);
  const data=new FormData();data.set('file',file);data.set('settings',JSON.stringify(settings));data.set('title',documentTitle.value.trim());
  checkingFinal=true;finalButton.disabled=true;finalResult.textContent='PDF의 실제 쪽수와 항목별 텍스트 줄을 검사하고 있습니다.';
  try {
    const response=await fetch('/api/check-document',{method:'POST',body:data,signal:request.signal}),result=await responseJson(response);
    if(requestId!==finalSequence)return;
    if(!response.ok)throw new Error(result.error||'PDF 검사에 실패했습니다.');
    if(signature!==JSON.stringify([settings,documentTitle.value])||!confirmed||stale){finalResult.textContent='설정이 변경되었습니다. 다시 검사해 주세요.';return;}
    finalResult.replaceChildren();
    const summary=document.createElement('p');summary.textContent=`총 ${result.pages}쪽 · ${result.status==='fail'?'분량 제한 초과':result.status==='pass'?'설정된 분량 검사 통과':'직접 확인할 항목이 있습니다'}`;finalResult.append(summary);
    const list=document.createElement('ul');
    for(const check of result.checks){const item=document.createElement('li');item.textContent=`${check.label}: ${check.actual??'측정 불가'} / 최대 ${check.maximum} · ${{pass:'통과',fail:'초과',unverified:'확인 필요'}[check.status]}${check.reason?' — '+check.reason:''}`;list.append(item);}finalResult.append(list);
    const note=document.createElement('p');note.className='config-note';note.textContent=result.note;finalResult.append(note);
  } catch(error){if(requestId===finalSequence)finalResult.textContent=request.expired()?'검사 시간이 초과되었습니다. 다시 시도해 주세요.':error.message||'PDF 검사에 실패했습니다.';}
  finally{request.finish();if(requestId===finalSequence){finalController=null;checkingFinal=false;finalButton.disabled=!confirmed||stale;}}
});
finalFile.addEventListener('change',invalidateFinalCheck);
const spacingValue = document.querySelector("#setting-spacing-value");
const spacingUnit = document.querySelector("#setting-spacing-unit");
let analysis = null;
let settings = null;
let reviewedFields = new Set();
let reviewedWarnings = new Set();
let confirmed = false;
let stale = false;
let inputVersion = 0;
let analysisController=null,analysisSequence=0,generationController=null,finalController=null,finalSequence=0;
let analysisProgress=null;
function setAnalyzing(busy) {
  clearInterval(analysisProgress);analysisProgress=null;
  generateButton.disabled=busy;form.setAttribute('aria-busy',String(busy));generateButton.querySelector('span').textContent=busy?'조건 분석 중…':'문서 조건 분석하기';
  if(busy){const started=Date.now();analysisProgress=setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);generateButton.querySelector('span').textContent=`조건 분석 중 · ${seconds}초`;setMessage(seconds<20?`문서 조건을 분석하고 있습니다. ${seconds}초 경과`:`분석이 평소보다 오래 걸리고 있습니다. ${seconds}초 경과`);},1000);}
}
function cancelAnalysis() {
  analysisSequence+=1;analysisController?.abort();analysisController=null;setAnalyzing(false);
}
function invalidateFinalCheck() {
  finalSequence+=1;finalController?.abort();finalController=null;checkingFinal=false;finalResult.replaceChildren();finalButton.disabled=!confirmed||stale;
}
function focusSetting(path) {
  const optionTargets={'documentOptions.coverPage':'setting-cover','documentOptions.contentsPage':'setting-contents','documentOptions.tableItems':'setting-tables','documentOptions.numberedItems':'setting-numbered'};
  const target=controls[path] || (path==='documentTitle'?documentTitle:document.getElementById(optionTargets[path]||'')) || (path==='lineSpacing'?spacingValue:[...sectionControls.querySelectorAll('[data-setting-path]')].find(control=>control.dataset.settingPath===path));
  if(target){for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;target.focus();target.scrollIntoView({behavior:'smooth',block:'center'});}
  else {advancedDetails.open=true;advancedDetails.scrollIntoView({behavior:'smooth',block:'center'});}
}

const ALLOWED_EXTENSIONS = ["pdf", "hwpx"];
let selectedFiles = [];

function clearHwpx() {
  generationVersion += 1;
  generationController?.abort();generationController=null;generatingHwpx=false;hwpxButton.textContent='HWPX 양식 만들기';hwpxButton.removeAttribute('aria-busy');
  hwpxButton.disabled=!confirmed||stale;
  hwpxDownload.hidden = true;
  hwpxDownload.removeAttribute("href");
  if (generatedFileUrl) URL.revokeObjectURL(generatedFileUrl);
  generatedFileUrl = null;
  generatedBlob = null;
  generatedPlan = null;
  generatedName = null;
  hwpxExpiry.hidden = true;
  hwpxWarnings.replaceChildren();
  document.querySelector('#generation-notes').hidden=true;
  hwpxStatus.textContent = confirmed && !stale ? "확정한 설정으로 양식을 만들 수 있습니다." : "먼저 위에서 설정을 확정해 주세요.";
}

function refreshPreview() {
  if (settings) renderDocumentPreview(document.querySelector("#document-preview"), settings, documentTitle.value, { confirmed, stale, renderPlan:generatedPlan });
}

async function responseJson(response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new Error(response.status === 413 ? "파일이 배포 서버의 전송 한도를 넘었습니다. 첨부 합계를 3.5MB 이하로 줄여 주세요."
      : [502, 504].includes(response.status) ? "서버 처리 시간이 초과되었거나 일시적으로 연결할 수 없습니다. 파일을 줄여 다시 시도해 주세요."
        : "서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.");
  }
  return response.json();
}

function markInputChanged() {
  inputVersion += 1;
  if(analysisController){cancelAnalysis();setMessage('입력이 바뀌어 분석을 중단했습니다. 다시 분석해 주세요.');if(settings)inputResult.hidden=false;}
  if (!analysis) return;
  stale = true;
  confirmed = false;
  refreshSettings();
}

fetch("/api/config").then(async (response) => {
  if (!response.ok) throw new Error();
  const config = await response.json();
  document.querySelector("#analysis-config").textContent = config.configured?'입력한 조건과 첨부 본문은 Gemini로 전송되어 분석됩니다.':'기본 분석을 사용합니다. 결과를 원문과 비교해 주세요.';
}).catch(() => {
  document.querySelector("#analysis-config").textContent = "분석 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
});

function setMessage(message = "", type = "") {
  formMessage.textContent = message;
  formMessage.className = "form-message";
  if (type) formMessage.classList.add(`is-${type}`);
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderFiles() {
  fileList.replaceChildren();

  selectedFiles.forEach((file, index) => {
    const item = document.createElement("li");
    item.className = "file-item";

    const details = document.createElement("span");
    details.className = "file-details";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatFileSize(file.size);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-file";
    removeButton.textContent = "제거";
    removeButton.setAttribute("aria-label", `${file.name} 제거`);
    removeButton.addEventListener("click", () => {
      selectedFiles = selectedFiles.filter((_, fileIndex) => fileIndex !== index);
      renderFiles();
      setMessage();
      markInputChanged();
    });

    details.append(name, size);
    item.append(details, removeButton);
    fileList.append(item);
  });
}

function addFiles(files) {
  const nextFiles = Array.from(files);
  let errorMessage = "";

  nextFiles.forEach((file) => {
    const extension = file.name.split(".").pop()?.toLowerCase();

    if (!extension || !ALLOWED_EXTENSIONS.includes(extension)) {
      errorMessage = "PDF 또는 HWPX 파일만 첨부할 수 있습니다.";
      return;
    }


    const duplicate = selectedFiles.some(
      (selected) => selected.name === file.name && selected.size === file.size,
    );
    if (duplicate) return;
    const problem = checkUploadLimits([...selectedFiles, file]);
    if (problem) { errorMessage = problem; return; }
    selectedFiles.push(file);
  });

  renderFiles();
  setMessage(errorMessage, errorMessage ? "error" : "");
  fileInput.value = "";
  markInputChanged();
}

requirements.addEventListener("input", () => {
  characterCount.textContent = `${requirements.value.length} / 500`;
  setMessage();
  markInputChanged();
});

requirements.addEventListener('paste',event=>{
  const pasted=event.clipboardData?.getData('text/plain');if(!pasted)return;
  const available=500-(requirements.value.length-(requirements.selectionEnd-requirements.selectionStart));
  if(pasted.length<=available)return;
  const compact=pasted.split(/\r?\n/).map(line=>/^\s*\|.*\|\s*$/.test(line)?'| '+line.trim().slice(1,-1).split('|').map(cell=>cell.trim()).join(' | ')+' |':line).join('\n');
  event.preventDefault();
  if(compact.length<=available){requirements.setRangeText(compact,requirements.selectionStart,requirements.selectionEnd,'end');requirements.dispatchEvent(new Event('input',{bubbles:true}));}
  else setMessage('입력은 500자까지입니다. 내용이 잘리지 않도록 붙여넣기를 멈췄습니다. 조건을 줄이거나 기존 PDF/HWPX 안내문을 첨부해 주세요.','error');
});

exampleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    requirements.value = button.dataset.example;
    requirements.dispatchEvent(new Event("input"));
    requirements.focus();
  });
});

fileInput.addEventListener("change", (event) => addFiles(event.target.files));

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
});

dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

function appendResultBlock(title, details, content) {
  const block = document.createElement("div");
  block.className = "result-block";
  const heading = document.createElement("h3");
  heading.textContent = title;
  block.append(heading);
  if (details) {
    const caption = document.createElement("p");
    caption.textContent = details;
    block.append(caption);
  }
  const preview = document.createElement("pre");
  preview.className = "result-text";
  preview.textContent = content.length > 5000 ? `${content.slice(0, 5000)}\n\n… 화면에는 앞부분만 표시합니다.` : content;
  block.append(preview);
  resultContent.append(block);
}

function fillSettingsControls() {
  renderSectionControls();
  if(settings.documentTitle!=null)documentTitle.value=settings.documentTitle;
  numberedControl.checked=settings.documentOptions?.numberedItems!==false;
  for (const [path, control] of Object.entries(controls)) {
    const value = getSetting(settings, path);
    control.value = path === "requiredItems" ? value.join("\n") : value ?? "";
  }
  spacingValue.value = settings.lineSpacing.value ?? "";
  spacingUnit.value = settings.lineSpacing.unit ?? "";
  document.querySelector('#setting-cover').checked=settings.documentOptions?.coverPage===true;
  document.querySelector('#setting-contents').checked=settings.documentOptions?.contentsPage===true;
  document.querySelector('#setting-tables').value=settings.documentOptions?.tableItems?.join('\n') || '';
  const advancedFields=['headerFooterMm','columns','alignment','limits','typography'];
  advancedDetails.open=advancedFields.some(group=>Object.values(settings[group]||{}).some(value=>value!=null))||Boolean(settings.sectionStyles?.length);
  sectionDetails.open=Boolean(settings.sectionStyles?.some(s=>s.alignment||s.fontSizePt||s.maxLines));
  extraDetails.open=Boolean(settings.documentOptions?.coverPage||settings.documentOptions?.contentsPage||settings.documentOptions?.tableItems?.length);
  document.querySelector('#analysis-engine').textContent=analysis.engine==='gemini'?'AI 분석':analysis.engine==='saved'?'저장한 양식':'기본 분석';
}

function readSettingsControls() {
  for (const [path, control] of Object.entries(controls)) {
    let value = control.value.trim();
    if (path === "requiredItems") value = [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
    else if (isNumericField(path)) value = control.validity.badInput ? NaN : value === "" ? null : Number(value);
    else value = value || null;
    setSetting(settings, path, value);
  }
  settings.lineSpacing = { value: spacingValue.validity.badInput ? NaN : spacingValue.value === "" ? null : Number(spacingValue.value), unit: spacingUnit.value || null };
  settings.documentOptions={coverPage:document.querySelector('#setting-cover').checked,contentsPage:document.querySelector('#setting-contents').checked,tableItems:[...new Set(document.querySelector('#setting-tables').value.split('\n').map(value=>value.trim()).filter(Boolean))],numberedItems:numberedControl.checked};
}

function pendingWarnings() {
  return analysis.warnings.filter((warning, index) =>
    !["missing", "invalid"].includes(warning.type) && !reviewedWarnings.has(index)
    && !(warning.field && reviewedFields.has(warning.field) && ["conflict", "choice", "unparsed"].includes(warning.type))
  ).map((warning) => ({ ...warning, originalIndex: analysis.warnings.indexOf(warning) }));
}

function refreshSettings() {
  if (!settings) return;
  invalidateFinalCheck();
  const validation = validateSettings(settings);
  const pending = pendingWarnings();
  const acknowledgedNotices=analysis.warnings.filter((warning,index)=>warning.type==='unsupported'&&reviewedWarnings.has(index)).map(warning=>({...warning,acknowledged:true}));
  const active = [...pending.filter(warning=>warning.type!=='analysis'||warning.code),...acknowledgedNotices, ...validation.filter((warning) => !pending.some((item) => ["conflict","choice"].includes(item.type) && item.field === warning.field))];
  document.querySelector('.warning-panel').hidden=active.length===0;
  settingsWarnings.replaceChildren();
  for (const warning of active) {
    const item = document.createElement("li");
    item.className = `warning-item is-${warning.type}`;
    const text = document.createElement("p");
    text.textContent = warning.message;
    item.append(text);
    if(warning.details){const list=document.createElement('ul');for(const detail of warning.details){const entry=document.createElement('li');entry.textContent=`${detail.label}: ${detail.value} — ${detail.reason}`;list.append(entry);}item.append(list);}
    const evidence = warning.candidates?.flatMap((candidate) => candidate.evidence) ?? (warning.quote ? [warning] : []);
    for (const entry of evidence.filter((entry, index, list) => list.findIndex((other) => other.sourceId === entry.sourceId && other.quote === entry.quote) === index)) {
      const quote = document.createElement("small");
      quote.textContent = `${entry.sourceName}: ${entry.quote.length > 350 ? `${entry.quote.slice(0, 350)}…` : entry.quote}`;
      item.append(quote);
    }
    if (["conflict","choice"].includes(warning.type) && warning.field !== "requiredItems") {
      const choices = document.createElement("div");
      choices.className = "warning-actions";
      for (const candidate of warning.candidates) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = `${candidate.choiceLabel?candidate.choiceLabel+' · ':''}${formatSetting(warning.field, candidate.value)} 적용`;
        button.addEventListener("click", () => {
          setSetting(settings, warning.field, structuredClone(candidate.value));
          fillSettingsControls();
          reviewedFields.add(warning.field);
          confirmed = false;
          refreshSettings();
        });
        choices.append(button);
      }
      item.append(choices);
    } else if (warning.type === "unparsed" || (warning.type==='unsupported'&&!warning.acknowledged) || (warning.type === "conflict" && warning.field === "requiredItems")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.textContent = warning.type==='unsupported'?'미적용 조건 확인 · 기본 양식만 생성':'원문과 설정값을 직접 확인했습니다';
      button.addEventListener("click", () => { reviewedWarnings.add(warning.originalIndex); confirmed = false; refreshSettings(); });
      item.append(button);
    }
    settingsWarnings.append(item);
    if(warning.field && !['analysis','unsupported'].includes(warning.type)){
      const jump=document.createElement('button');jump.type='button';jump.className='text-button';jump.textContent='설정으로 이동';jump.addEventListener('click',()=>focusSetting(warning.field));item.append(jump);
    }
  }
  if (active.length === 0) {
    const item = document.createElement("li");
    item.className = "warning-clear";
    item.textContent = confirmed?'설정을 확정했습니다.':'모든 필수 조건을 읽었습니다.';
    settingsWarnings.append(item);
  }
  for (const [path, control] of Object.entries(controls)) {
    control.setAttribute("aria-invalid", String(validation.some((warning) => warning.field === path) || pending.some((warning) => warning.field === path && ["conflict","choice"].includes(warning.type))));
  }
  const blocking = pending.some((warning) => ["conflict", "choice", "unparsed", "unsupported"].includes(warning.type)) || validation.length > 0;
  if(blocking)confirmed=false;
  const remaining=active.filter(w=>w.type!=='analysis'&&!w.acknowledged).length;
  confirmButton.textContent=stale?'재분석 필요':confirmed?'설정 확정 완료':blocking?`확인할 조건 ${remaining}개`:'설정 확정하기';
  confirmButton.classList.toggle('needs-review',blocking);
  settingsJson.textContent = JSON.stringify(settings, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? null : value, 2);
  downloadButton.disabled = !confirmed || stale;
  hwpxButton.disabled = !confirmed || stale || generatingHwpx;
  document.querySelector('#save-template').disabled = !confirmed || stale || document.querySelector('#save-template').dataset.busy==='true';
  if (!confirmed || stale) clearHwpx();
  refreshPreview();
  confirmButton.disabled = stale || confirmed;
  settingsState.className = `settings-state${confirmed || !blocking&&!stale ? " is-confirmed" : ""}`;
  settingsState.textContent = stale ? "입력이 변경되었습니다. 다시 분석해 주세요."
    : confirmed ? "설정 확정 완료 · 양식을 생성할 수 있습니다."
      : blocking ? `확인이 필요한 조건 ${remaining}개`
        : '필수 조건 준비 완료 · 값을 검토한 뒤 확정하세요.';
  for(const link of document.querySelectorAll('.workflow-steps a')){
    const current=stale?1:confirmed?3:2;link.classList.toggle('is-complete',Number(link.dataset.step)<current);if(Number(link.dataset.step)===current)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');
  }
  return !blocking;
}

for (const [path, control] of Object.entries(controls)) {
  control.addEventListener("input", () => {
    if (!settings) return;
    readSettingsControls();
    if(path==='requiredItems') {reconcileItemReferences(settings);document.querySelector('#setting-tables').value=settings.documentOptions?.tableItems?.join('\n')||'';renderSectionControls();}
    reviewedFields.add(path);
    confirmed = false;
    refreshSettings();
  });
}
for (const control of [spacingValue, spacingUnit]) {
  control.addEventListener("input", () => {
    if (!settings) return;
    readSettingsControls();
    reviewedFields.add("lineSpacing");
    confirmed = false;
    refreshSettings();
  });
}
for(const [id,field] of Object.entries({'setting-cover':'coverPage','setting-contents':'contentsPage','setting-tables':'tableItems','setting-numbered':'numberedItems'}))document.getElementById(id).addEventListener('input',()=>{if(!settings)return;readSettingsControls();reviewedFields.add('documentOptions.'+field);confirmed=false;refreshSettings();});

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!settings || stale) return;
  readSettingsControls();
  if (!refreshSettings()) {
    settingsState.textContent = "아직 확정할 수 없습니다. 빈칸·잘못된 값·미확인 경고를 확인해 주세요.";
    settingsWarnings.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  confirmed = true;
  clearHwpx();
  refreshSettings();
});

documentTitle.addEventListener("input", () => { if(settings){settings.documentTitle=documentTitle.value.trim()||null;reviewedFields.add("documentTitle");settingsJson.textContent=JSON.stringify(settings,null,2);} clearHwpx(); refreshSettings(); });
hwpxButton.addEventListener("click", async () => {
  if (!confirmed || stale || generatingHwpx) return;
  clearHwpx();
  const submittedVersion = generationVersion;
  const payload = { settings: structuredClone(settings), title: documentTitle.value.trim(), confirmed: true };
  generatingHwpx = true;
  const request=timedRequest(60000),controller=request.controller;generationController=controller;
  hwpxButton.disabled = true;
  hwpxButton.textContent='양식 생성 중…';hwpxButton.setAttribute('aria-busy','true');
  hwpxStatus.textContent = "기본 템플릿에 설정을 적용하고 파일 구조를 검사하고 있습니다.";
  try {
    const response = await fetch("/api/hwpx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),signal:request.signal });
    const result = await responseJson(response);
    if (!response.ok) throw new Error(result.error || "HWPX 생성에 실패했습니다.");
    if (submittedVersion !== generationVersion || !confirmed || stale) return;
    hwpxStatus.textContent = `생성 완료 · ${result.fileName}`;
    for (const warning of result.warnings) {
      const item = document.createElement("li");
      item.className = "warning-item";
      item.textContent = warning;
      hwpxWarnings.append(item);
    }
    document.querySelector('#generation-notes').hidden=result.warnings.length===0;
    const bytes = generatedFileBytes(result);
    generatedBlob = new Blob([bytes], { type: "application/hwp+zip" });
    generatedName = result.fileName;
    generatedPlan = result.renderPlan;
    refreshPreview();
    generatedFileUrl = URL.createObjectURL(generatedBlob);
    hwpxDownload.href = generatedFileUrl;
    hwpxDownload.download = result.fileName;
    hwpxDownload.hidden = false;
    hwpxExpiry.hidden = false;
  } catch (error) {
    if (submittedVersion === generationVersion) hwpxStatus.textContent = request.expired()?'생성 시간이 초과되었습니다. 다시 시도해 주세요.':error.message || "서버에 연결할 수 없습니다.";
  } finally {
    request.finish();
    if(generationController===controller){generationController=null;generatingHwpx=false;hwpxButton.disabled=!confirmed||stale;hwpxButton.textContent='다시 생성';hwpxButton.removeAttribute('aria-busy');}
  }
});

initializeLibrary({
  canSave:()=>Boolean(settings&&confirmed&&!stale),
  snapshot() {
    if (!settings || !confirmed || stale) throw new Error('문서 설정을 먼저 확인하고 확정해 주세요.');
    const title=documentTitle.value.trim();
    return {title:title||UNTITLED_FORM_NAME,requirements:requirements.value,settings:{...structuredClone(settings),documentTitle:title},file:generatedBlob,fileLayoutVersion:generatedPlan?.version ?? null,fileName:generatedName};
  },
  onLoad(item) {
    cancelAnalysis();invalidateFinalCheck();
    finalFile.value='';finalResult.replaceChildren();
    inputVersion += 1;
    requirements.value = item.requirements;
    characterCount.textContent = `${requirements.value.length} / 500`;
    selectedFiles = [];fileInput.value = '';renderFiles();resultContent.replaceChildren();
    analysis = {warnings:[],engine:'saved'};
    settings = structuredClone(item.settings);settings.documentTitle=savedDocumentTitle(item);documentTitle.value = settings.documentTitle;
    reviewedFields = new Set();reviewedWarnings = new Set();confirmed=false;stale=false;
    clearHwpx();fillSettingsControls();refreshSettings();inputResult.hidden=false;
    collapseInput(true);
    setMessage();
    inputResult.scrollIntoView({behavior:'smooth',block:'start'});
  },
  onReset() {
    cancelAnalysis();invalidateFinalCheck();
    finalFile.value='';finalResult.replaceChildren();
    inputVersion += 1;analysis=null;settings=null;confirmed=false;stale=false;
    clearHwpx();requirements.value='';characterCount.textContent='0 / 500';selectedFiles=[];fileInput.value='';renderFiles();
    documentTitle.value='';inputResult.hidden=true;document.querySelector('#save-template').disabled=true;setMessage();collapseInput(false);requirements.focus();
    for(const link of document.querySelectorAll('.workflow-steps a')){link.classList.remove('is-complete');if(link.dataset.step==='1')link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');}
  },
});

downloadButton.addEventListener("click", () => {
  if (!confirmed || stale) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "문서_설정.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!requirements.value.trim() && selectedFiles.length === 0) {
    setMessage("요구사항을 입력하거나 참고 파일을 첨부해 주세요.", "error");
    requirements.focus();
    return;
  }

  const data = new FormData();
  data.append("requirements", requirements.value.trim());
  selectedFiles.forEach((file) => data.append("files", file));

  cancelAnalysis();const requestId=++analysisSequence,request=timedRequest(65000),controller=request.controller;analysisController=controller;setAnalyzing(true);
  confirmed = false;
  stale=true;
  const submittedVersion = inputVersion;
  setMessage("입력한 문서 조건을 분석하고 있습니다.");
  inputResult.hidden = true;

  try {
    if(settings)refreshSettings();
    const response = await fetch("/api/analyze", { method: "POST", body: data,signal:request.signal });
    const result = await responseJson(response);
    if (!response.ok) throw new Error(result.error || "입력 처리에 실패했습니다.");
    if(requestId!==analysisSequence||submittedVersion!==inputVersion)return;

    resultContent.replaceChildren();
    if (result.prompt) appendResultBlock("직접 입력한 요구사항", `${result.prompt.length}자`, result.prompt);
    result.files.forEach((file) => {
      const details = `${file.type.toUpperCase()} · ${formatFileSize(file.size)} · ${file.pages ? `${file.pages}쪽` : `${file.sections}개 본문 구역`}${file.truncated ? " · 긴 내용 일부 생략" : ""}`;
      appendResultBlock(file.name, details, file.text);
    });
    analysis = result.analysis;
    settings = structuredClone(analysis.settings);
    reviewedFields = new Set();
    reviewedWarnings = new Set();
    confirmed = false;
    stale = submittedVersion !== inputVersion;
    fillSettingsControls();
    refreshSettings();
    inputResult.hidden = false;
    collapseInput(true);setMessage();
    inputResult.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if(requestId!==analysisSequence)return;
    setMessage(request.expired()?'분석 시간이 초과되었습니다. 다시 시도해 주세요.':error instanceof TypeError?'분석 서버에 연결하거나 결과를 표시하지 못했습니다. 다시 시도해 주세요.':error.message || "서버에 연결할 수 없습니다. 다시 시도해 주세요.", "error");
    if(settings)inputResult.hidden=false;
  } finally {
    request.finish();
    if(requestId===analysisSequence){analysisController=null;setAnalyzing(false);}
  }
});

form.dataset.ready='true';setAnalyzing(false);document.querySelector('#startup-error').hidden=true;document.dispatchEvent(new Event('hanform-ready'));

