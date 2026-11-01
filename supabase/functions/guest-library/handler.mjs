const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const BUCKET = 'hanform-shared';
class Problem extends Error { constructor(message, status = 422) { super(message); this.status = status; } }
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2,'0')).join('');
const token = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2,'0')).join('');
const view = (row, owns=false) => ({ id: row.id, title: row.title, requirements: owns || row.include_requirements ? row.requirements : '', includeRequirements:row.include_requirements, settings: row.settings, authorName: row.is_anonymous ? '' : row.author_name, isAnonymous: row.is_anonymous, isPublic: row.is_public, fileName: row.file_name, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,...(owns?{history:row.history}:{}) });
export function createLibraryHandler({ env, fetchImpl = fetch }) {
  const base = env.SUPABASE_URL;
  const secrets = JSON.parse(env.SUPABASE_SECRET_KEYS || '{}');
  const adminKey = secrets.default || env.SUPABASE_SERVICE_ROLE_KEY;
  const publishable = Object.values(JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS || '{}'));
  if (env.SUPABASE_ANON_KEY) publishable.push(env.SUPABASE_ANON_KEY);
  async function call(path, { method = 'GET', body, headers = {}, rawResponse = false } = {}) {
    const response = await fetchImpl(base + path, { method, headers: { apikey: adminKey, ...(adminKey?.startsWith('eyJ') ? { Authorization: `Bearer ${adminKey}` } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Problem('공유 저장소를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502);
    if(rawResponse)return response;
    if (response.status === 204) return null;
    return response.headers.get('content-type')?.includes('json') ? response.json() : response.arrayBuffer();
  }
  const rows = query => call('/rest/v1/guest_templates?' + new URLSearchParams(query));
  const eraseFile = path => call('/storage/v1/object/' + BUCKET, { method: 'DELETE', body: { prefixes: [path] }, headers: { 'Content-Type': 'application/json' } });
  return async request => {
    try {
      if (request.method !== 'POST') throw new Problem('지원하지 않는 요청입니다.',405);
      if (!publishable.includes(request.headers.get('apikey'))) throw new Problem('올바른 연결 키가 필요합니다.',401);
      if (Number(request.headers.get('content-length')) > 65536) throw new Problem('입력이 너무 큽니다.',413);
      const raw = await request.text(); if (new TextEncoder().encode(raw).length > 65536) throw new Problem('입력이 너무 큽니다.',413);
      let input; try { input = JSON.parse(raw); } catch { throw new Problem('JSON을 확인해 주세요.',400); }
      if(!input || typeof input!=='object' || Array.isArray(input))throw new Problem('요청 형식이 올바르지 않습니다.',400);
      const { op, id } = input;
      if (op === 'list') {
        const query = typeof input.q === 'string' ? input.q.trim().slice(0,80) : '';
        const page = Number.isInteger(Number(input.page)) ? Math.max(0, Math.min(249, Number(input.page))) : 0;
        const filters = { is_public: 'eq.true', order: 'updated_at.desc,id.asc', limit: '21', offset: String(page*20), select: 'id,title,requirements,include_requirements,settings,author_name,is_anonymous,is_public,file_name,version,created_at,updated_at' };
        if (query) filters.search_text = 'ilike.%' + query.replace(/[\\%_*]/g, char => '\\' + char) + '%';
        const found = await rows(filters);
        return Response.json({ items: found.slice(0,20).map(row=>view(row)), hasMore: found.length > 20, page }, { headers: { 'Cache-Control':'no-store' } });
      }
      if (id != null && !UUID.test(id)) throw new Problem('양식 주소가 올바르지 않습니다.');
      const current = id ? (await rows({ id: 'eq.' + id, limit:'1' }))[0] : null;
      const owns = current && typeof input.token === 'string' && TOKEN.test(input.token) && await digest(input.token) === current.manage_hash;
      if (['get','download'].includes(op)) {
        if (!current || (!current.is_public && !owns)) throw new Problem('양식을 찾을 수 없습니다.',404);
        if (op === 'get') return Response.json({ item: view(current,owns) }, { headers: { 'Cache-Control':'no-store' } });
        const bytes = new Uint8Array(await call('/storage/v1/object/authenticated/' + BUCKET + '/' + current.file_path));
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        return Response.json({ fileBase64: btoa(binary), fileName: current.file_name }, { headers: { 'Cache-Control':'no-store' } });
      }
      if (['unpublish','delete'].includes(op)) {
        if (!owns) throw new Problem('이 양식을 관리할 수 없습니다.',403);
        if (op === 'delete') {
          await call('/rest/v1/guest_templates?' + new URLSearchParams({id:'eq.'+id,manage_hash:'eq.'+current.manage_hash}), {method:'DELETE'});
          await eraseFile(current.file_path);
          return Response.json({ deleted: true });
        }
        const updated = await call('/rest/v1/guest_templates?' + new URLSearchParams({id:'eq.'+id,manage_hash:'eq.'+current.manage_hash,version:'eq.'+current.version}), {method:'PATCH',body:{is_public:false,version:current.version+1,updated_at:new Date().toISOString()},headers:{'Content-Type':'application/json',Prefer:'return=representation'}});
        if (!updated.length) throw new Problem('다른 곳에서 변경되었습니다. 목록을 새로고침해 주세요.',409);
        return Response.json({item:view(updated[0],true)});
      }
      if (op !== 'save') throw new Problem('지원하지 않는 요청입니다.',400);
      if (id && !owns) throw new Problem('이 양식을 관리할 수 없습니다.',403);
      if (id && input.version !== current.version) throw new Problem('다른 곳에서 변경되었습니다. 다시 불러와 주세요.',409);
      const payload = input.payload;
      if (!payload || payload.storageConsent !== true || typeof payload.publish !== 'boolean') throw new Problem('온라인 보관 동의를 확인해 주세요.');
      if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 80) throw new Problem('양식 이름은 80자 이내로 입력해 주세요.');
      if (typeof payload.requirements !== 'string' || payload.requirements.length > 500) throw new Problem('입력 조건을 확인해 주세요.');
      if (typeof payload.authorName !== 'string' || payload.authorName.length > 40 || typeof payload.isAnonymous !== 'boolean') throw new Problem('공개 이름을 확인해 주세요.');
      if (!id) {
        const counted=await call('/rest/v1/guest_templates?select=id&limit=1',{headers:{Prefer:'count=exact'},rawResponse:true});
        const total=Number(counted.headers.get('content-range')?.split('/')[1]);
        if(!Number.isFinite(total))throw new Problem('공유 저장소 용량을 확인하지 못했습니다.',502);
        if(total>=5000)throw new Problem('공유 저장소가 가득 찼습니다. 내 양식 보관과 내려받기는 계속 이용할 수 있습니다.',429);
      }
      // Fixed trusted endpoint: callers cannot submit arbitrary files or fetch arbitrary URLs.
      const generatedResponse = await fetchImpl('https://hanform.vercel.app/api/hwpx', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:payload.settings,title:payload.title,confirmed:true}),signal:AbortSignal.timeout(20000)});
      const generated = await generatedResponse.json();
      if (!generatedResponse.ok) throw new Problem(generated.error || '문서 설정이 올바르지 않습니다.');
      const applied=generated.appliedSettings;
      const cleanSettings={schemaVersion:1,paper:applied.paper,marginsMm:applied.marginsMm,fontFamily:applied.fontFamily,fontSizePt:applied.fontSizePt,lineSpacing:applied.lineSpacing,requiredItems:applied.requiredItems,documentOptions:applied.documentOptions || {coverPage:false,contentsPage:false,tableItems:[]}};
      for(const key of ['headerFooterMm','columns','alignment','limits','sectionStyles','typography','documentTitle'])if(applied[key]!=null)cleanSettings[key]=applied[key];
      if (typeof generated.fileBase64 !== 'string' || generated.fileBase64.length > 2666668) throw new Problem('생성 파일이 너무 큽니다.',413);
      const bytes = Uint8Array.from(atob(generated.fileBase64), c=>c.charCodeAt(0));
      const itemId = id || crypto.randomUUID(), managementToken = id ? null : token();
      const version = (current?.version || 0) + 1, filePath = `${itemId}/${crypto.randomUUID()}.hwpx`;
      await call('/storage/v1/object/' + BUCKET + '/' + filePath, { method:'POST', body:bytes, headers:{'Content-Type':'application/hwp+zip','x-upsert':'false'} });
      const now = new Date().toISOString();
      const data = { title:payload.title.trim(), requirements:payload.requirements, include_requirements:payload.includeRequirements===true, settings:cleanSettings, author_name:payload.isAnonymous ? '' : payload.authorName.trim(), is_anonymous:payload.isAnonymous, is_public:payload.publish, file_path:filePath, file_name:generated.fileName, version, updated_at:now, search_text:[payload.title,payload.isAnonymous?'':payload.authorName,...cleanSettings.requiredItems].join(' '), history:[...(current?.history || []),...(current?[{at:current.updated_at,title:current.title,requirements:current.requirements,settings:current.settings}]:[])].slice(-10) };
      let updated;
      try {
        if (current) updated = await call('/rest/v1/guest_templates?' + new URLSearchParams({id:'eq.'+id,manage_hash:'eq.'+current.manage_hash,version:'eq.'+current.version}),{method:'PATCH',body:data,headers:{'Content-Type':'application/json',Prefer:'return=representation'}});
        else updated = await call('/rest/v1/guest_templates',{method:'POST',body:{...data,id:itemId,manage_hash:await digest(managementToken),created_at:now},headers:{'Content-Type':'application/json',Prefer:'return=representation'}});
        if (!updated.length) throw new Problem('다른 곳에서 변경되었습니다. 다시 불러와 주세요.',409);
      } catch (error) { await eraseFile(filePath).catch(()=>{}); throw error; }
      if (current) await eraseFile(current.file_path).catch(()=>{});
      return Response.json({item:view(updated[0],true),...(managementToken?{token:managementToken}:{})},{headers:{'Cache-Control':'no-store'}});
    } catch (error) {
      const status = error instanceof Problem ? error.status : 500;
      return Response.json({error: status===500?'공유 처리 중 오류가 발생했습니다.':error.message},{status,headers:{'Cache-Control':'no-store'}});
    }
  };
}
