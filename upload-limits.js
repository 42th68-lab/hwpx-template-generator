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
