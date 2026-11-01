import { createApiHandler } from "../server.mjs";

const handle = createApiHandler();
function route(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("route");
  if (action && ["config", "inputs", "analyze", "hwpx", "library", "check-document"].includes(action)) {
    url.pathname = `/api/${action}`;
    url.searchParams.delete("route");
    request = new Request(url, request);
  }
  return handle(request);
}
export const GET = route;
export const POST = route;
