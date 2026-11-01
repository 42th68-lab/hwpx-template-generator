// Explicit live-provider verification. Inputs are sent to the chosen deployment and Gemini.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {basename,resolve,join} from 'node:path';
import JSZip from 'jszip';
import {validateSettings} from '../settings-model.js';
import {validateHwpx,findElement,elements,xmlParser} from '../hwpx-validation.mjs';
const base=process.argv[2];
assert(base&&/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(base),'Pass the approved deployment URL.');
const output=resolve('tmp','gemini-check-'+Date.now()),checks=[],requests=[];
await mkdir(output,{recursive:true});
const check=(value,label)=>{assert(value,label);checks.push(label);};
const config=await (await fetch(new URL('/api/config',base))).json();
check(config.configured&&config.engine==='gemini','Gemini is configured on the deployed server');
check(!/sb_publishable_|AIza/.test(JSON.stringify(config)),'Public configuration contains no provider credentials');
const prompt='A4 세로, 모든 여백 20mm, 글꼴 프리텐다드, 본문은 열한 포인트, 줄 간격 160%. 필수 항목: 연구 목적, 방법, 결과, 결론.';
async function analyze(name,text,file){
 const form=new FormData();form.set('requirements',text);
 if(file)form.append('files',new Blob([await readFile(file)]),basename(file));
 const start=Date.now(),response=await fetch(new URL('/api/analyze',base),{method:'POST',body:form,signal:AbortSignal.timeout(60000)});
 const data=await response.json();await writeFile(join(output,name+'.json'),JSON.stringify(data,null,2));
 requests.push({name,status:response.status,elapsedMs:Date.now()-start,engine:data.analysis?.engine,model:data.analysis?.model});
 check(response.status===200&&data.analysis?.engine==='gemini',name+': real Gemini analysis succeeds without falling back');
 check(!data.analysis.warnings.some(w=>w.type==='analysis'),name+': no provider-failure warning');
 check(validateSettings(data.analysis.settings).length===0,name+': complete document settings are valid');
 return data.analysis.settings;
}
try{
 const settings=await analyze('natural-language',prompt);
 check(settings.fontSizePt===11,'Korean words 열한 포인트 become 11pt through AI extraction');
 check(settings.fontFamily==='프리텐다드'&&settings.paper.size==='A4'&&settings.lineSpacing.value===160,'Natural-language font, paper and spacing match');
 for(const file of process.argv.slice(3)){
   const value=await analyze(basename(file).replace(/\./g,'-'),'',file);
   check(value.paper.size==='A4'&&value.fontSizePt===10&&value.fontFamily==='맑은 고딕'&&value.requiredItems.length===4,basename(file)+': attachment conditions match the synthetic source');
 }
 settings.paper={size:'A5',orientation:'landscape'};settings.marginsMm={top:15,bottom:18,left:22,right:25};settings.fontSizePt=13.5;settings.lineSpacing={value:18.5,unit:'pt'};
 settings.documentOptions={coverPage:true,contentsPage:true,tableItems:['방법']};
 const title='Gemini 연결 완료 검사';
 const response=await fetch(new URL('/api/hwpx',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,title,confirmed:true}),signal:AbortSignal.timeout(60000)});
 const result=await response.json();check(response.status===200,'Edited Gemini settings produce downloadable HWPX bytes');
 const bytes=Buffer.from(result.fileBase64,'base64');check((await validateHwpx(bytes)).passed,'Generated HWPX passes runtime structural validation');
 await writeFile(join(output,'gemini-edited.hwpx'),bytes);
 const zip=await JSZip.loadAsync(bytes),header=xmlParser.parse(await zip.file('Contents/header.xml').async('string')),section=xmlParser.parse(await zip.file('Contents/section0.xml').async('string'));
 check(findElement(header,'charPr','0').attributes['@_height']==='1350','Edited body size is 13.5pt in the file');
 check(findElement(findElement(header,'paraPr','0').children,'lineSpacing').attributes['@_value']==='1850','Edited fixed line spacing is 18.5pt');
 check(findElement(section,'pagePr').attributes['@_landscape']==='NARROWLY'&&Boolean(findElement(section,'tbl')),'Landscape and writing table are present');
 const text=[...elements(section)].filter(e=>e.localName==='t').flatMap(e=>e.children.map(n=>n['#text']||'')).join('\n');
 check(text.includes(title)&&text.includes('목차'),'Title and generated contents list are present');
 const invalid=await fetch(new URL('/api/hwpx',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:{...settings,fontSizePt:-1},title,confirmed:true})});
 check(invalid.status===422,'Invalid edited values still block generation');
 const library=await fetch(new URL('/api/library',base));check(library.ok,'Supabase public-library connection still works');
 const report={base,checkedAt:new Date().toISOString(),passed:true,model:config.model,checks,requests,output};
 await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 await writeFile(join(output,'verification.json'),JSON.stringify({base,checkedAt:new Date().toISOString(),passed:false,checks,requests,error:error.message},null,2));
 throw error;
}
