// The transport's single request, on fetch: a Worker's node:https rejects pinned lookups.
// The address check still runs before every request; the platform itself refuses private networks.
import { Readable } from "node:stream";

export async function fetchRequestOnce(url, { headers, method, body, signal, timeout }) {
  const deadline = AbortSignal.timeout(timeout);
  const upstream = await fetch(url, {
    method, headers, body: body ?? undefined, redirect: "manual",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const responseHeaders = {};
  for (const [name, value] of upstream.headers) responseHeaders[name] = value;
  const cookies = upstream.headers.getSetCookie?.() || [];
  if (cookies.length) responseHeaders["set-cookie"] = cookies;
  // fetch hands over a decoded body, so the original encoding and length no longer describe it.
  if (responseHeaders["content-encoding"]) {
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
  }
  const response = upstream.body ? Readable.fromWeb(upstream.body) : Readable.from([]);
  response.statusCode = upstream.status;
  response.headers = responseHeaders;
  response.complete = false;
  response.once("end", () => { response.complete = true; });
  return response;
}
