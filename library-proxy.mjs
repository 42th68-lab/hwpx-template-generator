export const sharingConfigured = (env = process.env) => /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL || '') && /^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY || '');
export async function libraryRequest(input, {env = process.env, fetchImpl = fetch} = {}) {
  if (!sharingConfigured(env)) return Response.json({error:'공개 양식 저장소가 연결되지 않았습니다. 내 양식 저장과 파일 백업은 이용할 수 있습니다.'},{status:503});
  const response = await fetchImpl(env.SUPABASE_URL + '/functions/v1/guest-library', {method:'POST',headers:{'Content-Type':'application/json',apikey:env.SUPABASE_PUBLISHABLE_KEY},body:JSON.stringify(input),signal:AbortSignal.timeout(55000)});
  const body = await response.text();
  if (body.length > 4000000 || !response.headers.get('content-type')?.includes('json')) return Response.json({error:'공유 저장소 응답을 읽지 못했습니다.'},{status:502});
  return new Response(body,{status:response.status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'}});
}
