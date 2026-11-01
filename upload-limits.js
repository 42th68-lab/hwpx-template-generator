// Decimal bytes, with room below Vercel's 4.5 MB function payload ceiling.
export const UPLOAD_LIMITS = Object.freeze({
  maxFiles: 3,
  maxFileBytes: 3_500_000,
  maxTotalFileBytes: 3_500_000,
  maxRequestBytes: 4_000_000,
  maxGenerationRequestBytes: 64 * 1024,
  maxResponseBytes: 4_000_000,
  maxGeneratedFileBytes: 2_000_000,
});

export function checkUploadLimits(files) {
  if (files.length > UPLOAD_LIMITS.maxFiles) return "참고 파일은 3개까지 첨부할 수 있습니다.";
  if (files.some((file) => file.size > UPLOAD_LIMITS.maxFileBytes)) return "파일 하나의 크기는 3.5MB 이하여야 합니다.";
  if (files.reduce((total, file) => total + file.size, 0) > UPLOAD_LIMITS.maxTotalFileBytes) return "첨부 파일의 합계는 3.5MB 이하여야 합니다. 파일 수나 크기를 줄여 주세요.";
  return null;
}

// Avoid depending on AbortSignal.any/timeout in older browsers.
export function timedRequest(milliseconds, timers = globalThis) {
  const controller = new AbortController();
  let expired = false;
  const timer = timers.setTimeout(() => { expired = true; controller.abort(); }, milliseconds);
  return {controller,signal:controller.signal,expired:()=>expired,finish:()=>timers.clearTimeout(timer)};
}

// Library requests must also finish on a failed network or a non-JSON response.
export async function requestJson(url, init = {}, {fetchImpl = fetch, timers = globalThis, timeoutMs = 60000} = {}) {
  const request=timedRequest(timeoutMs,timers);
  try {
    const response=await fetchImpl(url,{...init,signal:request.signal});
    if(!/application\/json/i.test(response.headers.get('content-type') ?? ''))throw new Error('서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.');
    let result;
    try {result=await response.json();}catch{throw new Error('서버 응답이 올바르지 않습니다. 다시 시도해 주세요.');}
    if(!result || typeof result!=='object' || Array.isArray(result))throw new Error('서버 응답이 올바르지 않습니다.');
    if(!response.ok){const error=new Error(typeof result.error==='string'?result.error:'요청을 처리하지 못했습니다.');error.status=response.status;throw error;}
    return result;
  } catch(error) {
    if(request.expired())throw new Error('요청 시간이 초과되었습니다. 연결을 확인하고 다시 시도해 주세요.');
    if(error instanceof TypeError)throw new Error('서버에 연결하지 못했습니다. 연결을 확인해 주세요.');
    throw error;
  } finally {request.finish();}
}

export function generatedFileBytes(result) {
  const fail=()=>{throw new Error('생성 파일 데이터가 올바르지 않습니다. 다시 생성해 주세요.');};
  const encoded=result?.fileBase64;
  if(typeof encoded!=='string'||!encoded||encoded.length>Math.ceil(UPLOAD_LIMITS.maxGeneratedFileBytes/3)*4||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||result.validation?.passed!==true)fail();
  if(typeof result.fileName!=='string'||!/^.+\.hwpx$/i.test(result.fileName)||/[<>:"/\\|?*\x00-\x1f]/.test(result.fileName))fail();
  let bytes;try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));}catch{fail();}
  if(bytes.length>UPLOAD_LIMITS.maxGeneratedFileBytes||bytes.length<4||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==3||bytes[3]!==4)fail();
  return bytes;
}
