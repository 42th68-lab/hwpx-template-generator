import {requestJson,generatedFileBytes} from './upload-limits.js';
import {DOCUMENT_LAYOUT_VERSION,savedDocumentTitle} from './settings-model.js';
import {allForms,getForm,saveForm,deleteForm,setCloud,backupDocument,importBackup,cleanDocument} from './template-store.js';
export function checkedCloudState(local,remote) {
  if(remote.version!==local.version)throw new Error('다른 기기에서 온라인 양식이 변경되었습니다. 온라인 최신본을 불러온 뒤 수정해 주세요.');
  return {...local,isPublic:remote.isPublic};
}
export function initializeLibrary({snapshot,onLoad,onReset,canSave=()=>true}) {
  const $=id=>document.getElementById(id), status=$('library-status');
  const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
  let activeId=null, sharingId=null, publicPage=0, searchVersion=0;
  const report=error=>{status.textContent=error.message || '양식을 처리하지 못했습니다.';};
  const action=callback=>async event=>{
    const trigger=event?.currentTarget,button=trigger?.tagName==='BUTTON'?trigger:null;
    if(button?.dataset.busy)return;
    if(button){button.dataset.busy='true';button.disabled=true;button.setAttribute('aria-busy','true');}
    try{await callback();}catch(error){report(error);}
    finally{if(button){delete button.dataset.busy;button.disabled=button.id==='save-template'?!canSave():false;button.removeAttribute('aria-busy');}}
  };
  const button=(label,callback)=>{const el=node('button',label,'secondary-button');el.type='button';el.addEventListener('click',action(callback));return el;};
  function download(blob,name) {const url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function api(input) {return requestJson('/api/library',{method:input.op==='list'?'GET':'POST',headers:input.op==='list'?{}:{'Content-Type':'application/json'},...(input.op==='list'?{}:{body:JSON.stringify(input)})});}
  async function generate(item) {
    const result=await requestJson('/api/hwpx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:item.settings,title:savedDocumentTitle(item),confirmed:true})});
    return {fileLayoutVersion:result.layoutVersion,file:new Blob([generatedFileBytes(result)],{type:'application/hwp+zip'}),fileName:result.fileName};
  }
  async function openShare(id) {
    let item=await getForm(id); if(!item)throw new Error('양식을 찾을 수 없습니다.');
    if(item.cloud){try{const {item:remote}=await api({op:'get',id:item.cloud.id,token:item.cloud.token});item=await setCloud(id,checkedCloudState(item.cloud,remote));}catch(error){if(error.status===404)item=await setCloud(id,null);else throw error;}}
    sharingId=id;$('share-document-name').textContent=item.title;$('share-consent').checked=item.cloud?.isPublic===true;
    $('share-anonymous').checked=item.cloud?.isAnonymous!==false;$('share-author').value=item.cloud?.authorName || '';
    $('share-author').disabled=$('share-anonymous').checked;$('share-requirements').checked=item.cloud?.includeRequirements===true;
    $('share-status').textContent='';$('share-dialog').showModal();
  }
  async function renderSaved() {
    const query=$('saved-search').value.trim().toLocaleLowerCase();
    const items=(await allForms()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).filter(item=>[item.title,...item.settings.requiredItems].join(' ').toLocaleLowerCase().includes(query));
    const list=$('saved-templates');list.replaceChildren();
    if(!items.length){list.append(node('p',query?'검색 결과가 없습니다.':'저장된 양식이 없습니다. 설정을 확정한 뒤 ‘내 양식에 저장’을 눌러 주세요.'));return;}
    for(const item of items){
      const card=node('article',undefined,'template-card');card.append(node('h3',item.title),node('p',new Date(item.updatedAt).toLocaleString('ko-KR')+(item.cloud?.isPublic?' · 공개 중':item.cloud?' · 비공개 온라인 보관':' · 내 브라우저 보관')));
      const actions=node('div',undefined,'library-toolbar');
      actions.append(button('불러오기',async()=>{activeId=item.id;onLoad(item);status.textContent=`‘${item.title}’을 불러왔습니다. 수정 후 저장하면 같은 양식을 갱신합니다.`;}));
      actions.append(button('HWPX 내려받기',async()=>{let current=await getForm(item.id);if(!current.file || current.fileLayoutVersion!==DOCUMENT_LAYOUT_VERSION){const file=await generate(current);current=await saveForm({...current,...file});}download(current.file,current.fileName);}));
      actions.append(button('복사',async()=>{const copy=await saveForm({...item,id:undefined,title:item.title.slice(0,74)+' 복사본',settings:{...item.settings,documentTitle:savedDocumentTitle(item)},file:null,fileName:null});activeId=copy.id;await renderSaved();onLoad(copy);status.textContent='내 양식으로 복사했습니다. 원본은 바뀌지 않습니다.';}));
      actions.append(button('온라인 보관·공개 설정',()=>openShare(item.id)));
      if(item.cloud)actions.append(button('온라인 최신본 불러오기',async()=>{const {item:remote}=await api({op:'get',id:item.cloud.id,token:item.cloud.token});const restored=await saveForm({...cleanDocument(remote),id:item.id,file:null,cloudHistory:remote.history});await setCloud(item.id,{...item.cloud,version:remote.version,isPublic:remote.isPublic,isAnonymous:remote.isAnonymous,authorName:remote.authorName,includeRequirements:remote.includeRequirements});activeId=item.id;onLoad(restored);await renderSaved();status.textContent='온라인에 보관한 최신 설정과 수정 이력을 불러왔습니다.';}));
      if(item.cloud?.isPublic) actions.append(button('공유 링크 복사',async()=>{await navigator.clipboard.writeText(`${location.origin}/?template=${item.cloud.id}`);status.textContent='공개 양식 링크를 복사했습니다.';}));
      actions.append(button('삭제',async()=>{if(!window.confirm(`‘${item.title}’을 삭제할까요? 이 브라우저의 저장본과 온라인 보관본이 함께 삭제됩니다.`))return;if(item.cloud)await api({op:'delete',id:item.cloud.id,token:item.cloud.token});await deleteForm(item.id);if(activeId===item.id)activeId=null;await renderSaved();status.textContent='양식을 삭제했습니다.';}));
      card.append(actions);
      if(item.history.length){const details=node('details'),summary=node('summary',`수정 이력 ${item.history.length}개`);details.append(summary);for(const entry of [...item.history].reverse()){const row=node('div',undefined,'library-toolbar');row.append(node('span',`${new Date(entry.at).toLocaleString('ko-KR')} · ${entry.title}`),button('이 버전 불러오기',()=>{activeId=item.id;onLoad(entry);status.textContent='이전 설정을 불러왔습니다. 확인 후 저장하면 복원됩니다.';}));details.append(row);}card.append(details);}
      list.append(card);
    }
  }
  async function searchPublic() {
    const version=++searchVersion;$('public-status').textContent='공개 양식을 찾고 있습니다.';
    const url=new URL('/api/library',location.origin);url.searchParams.set('op','list');url.searchParams.set('q',$('public-search').value.trim());url.searchParams.set('page',publicPage);
    try{
      const result=await requestJson(url);if(version!==searchVersion)return;
      $('public-status').textContent=result.items.length?`${publicPage+1}페이지 · ${result.items.length}개`:'공개된 양식이 없습니다.';
      $('public-previous').disabled=publicPage===0;$('public-next').disabled=!result.hasMore;
      const list=$('public-templates');list.replaceChildren();
      for(const raw of result.items){const item={...raw,...cleanDocument(raw)};const card=node('article',undefined,'template-card');card.append(node('h3',item.title),node('p',item.isAnonymous?'익명':item.authorName || '이름 미입력'),node('p',item.settings.requiredItems.join(' · ')));const actions=node('div',undefined,'library-toolbar');
        actions.append(button('내 양식으로 복사',async()=>{const copy=await saveForm({...item,id:undefined,file:null});activeId=copy.id;await renderSaved();onLoad(copy);status.textContent='공개 양식을 내 양식으로 복사했습니다. 수정해도 공개 원본은 바뀌지 않습니다.';}));
        actions.append(button('HWPX 내려받기',async()=>{const result=await generate(item);download(result.file,result.fileName);}));card.append(actions);list.append(card);}
    }catch(error){if(version===searchVersion){$('public-status').textContent=error.message;$('public-templates').replaceChildren();$('public-next').disabled=true;}}
  }
  $('save-template').addEventListener('click',action(async()=>{const item=await saveForm({...snapshot(),id:activeId});activeId=item.id;await renderSaved();status.textContent=`‘${item.title}’을 이 브라우저에 저장했습니다.`;}));
  $('new-template').addEventListener('click',()=>{activeId=null;onReset();status.textContent='새 양식을 시작합니다.';});
  $('saved-search').addEventListener('input',action(renderSaved));
  $('backup-templates').addEventListener('click',action(async()=>{const items=await allForms();download(new Blob([JSON.stringify(backupDocument(items),null,2)],{type:'application/json'}),'한폼_양식_백업.json');status.textContent='백업을 내려받았습니다. 다른 컴퓨터에서는 ‘백업 가져오기’를 사용하세요.';}));
  $('import-templates').addEventListener('change',action(async()=>{const file=$('import-templates').files[0];if(!file)return;try{if(file.size>20000000)throw new Error('백업 파일은 20MB 이하로 선택해 주세요.');let raw;try{raw=JSON.parse(await file.text());}catch{throw new Error('백업 JSON을 읽을 수 없습니다.');}const count=await importBackup(raw);await renderSaved();status.textContent=`${count}개 양식을 가져왔습니다. HWPX는 내려받을 때 다시 생성합니다.`;}finally{$('import-templates').value='';}}));
  $('share-anonymous').addEventListener('change',()=>{$('share-author').disabled=$('share-anonymous').checked;});
  $('share-cancel').addEventListener('click',()=>$('share-dialog').close());
  $('share-form').addEventListener('submit',async event=>{event.preventDefault();const button=$('share-save');button.disabled=true;try{const item=await getForm(sharingId);if(!item)throw new Error('양식을 찾을 수 없습니다.');
    const authorName=$('share-author').value.trim(),isAnonymous=$('share-anonymous').checked,publish=$('share-consent').checked;if(publish&&!isAnonymous&&!authorName)throw new Error('공개할 이름을 입력하거나 익명을 선택해 주세요.');
    const result=await api({op:'save',...(item.cloud?{id:item.cloud.id,token:item.cloud.token,version:item.cloud.version}:{}),payload:{...cleanDocument(item),storageConsent:true,publish,includeRequirements:$('share-requirements').checked,isAnonymous,authorName}});
    await setCloud(item.id,{id:result.item.id,token:result.token || item.cloud.token,version:result.item.version,isPublic:publish,isAnonymous,authorName,includeRequirements:$('share-requirements').checked});
    await renderSaved();$('share-dialog').close();status.textContent='온라인 보관과 공개 설정을 저장했습니다.';if($('public-library').open)await searchPublic();
  }catch(error){$('share-status').textContent=error.message;}finally{button.disabled=false;}});
  $('public-search-form').addEventListener('submit',event=>{event.preventDefault();publicPage=0;searchPublic();});
  $('public-previous').addEventListener('click',()=>{publicPage=Math.max(0,publicPage-1);searchPublic();});
  $('public-next').addEventListener('click',()=>{publicPage++;searchPublic();});
  $('public-library').addEventListener('toggle',()=>{if($('public-library').open)searchPublic();});
  document.querySelector('a[href="#public-library"]')?.addEventListener('click',()=>{$('public-library').open=true;});
  renderSaved().catch(report);
  const sharedId=new URL(location.href).searchParams.get('template');
  if(sharedId)api({op:'get',id:sharedId}).then(({item})=>{cleanDocument(item);activeId=null;onLoad(item);status.textContent='공유 양식을 열었습니다. 내 양식에 저장하면 별도로 수정할 수 있습니다.';}).catch(report);
}
