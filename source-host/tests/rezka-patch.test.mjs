import assert from "node:assert/strict";
import { test } from "node:test";
import { patchRezkaApi } from "../../infrastructure/lampac/patch-rezka-api.mjs";

test("Rezka API patch keeps the native request and guards against source drift", () => {
  const source = `before
        var root = await httpHydra.Post<Dictionary<string, object>>(
            uri,
            data,
            safety: safety,
            cookieContainer: cookieContainer,
            newheaders: HeadersModel.JoinReadOnly(base_headers, defaultHeaders)
        );
        if (root == null) return null;
        string url = root.ContainsKey("url") ? root["url"]?.ToString() : null;`;
  const patched = patchRezkaApi(source);
  assert.equal(patchRezkaApi(patched), patched, "applying twice must not duplicate requests");
  assert(patched.endsWith(source.slice(source.indexOf("        if (root == null)"))), "native stream decoding stays intact");
  for (const path of ["/ajax/get_cdn_series/", "/engine/ajax/get_cdn_series/", "/ajax/get_cdn_series.php", "/engine/ajax/get_cdn_series.php"]) assert(patched.includes(`"${path}"`));
  assert(patched.includes("if (hasStream || accessDenied) break;"));
  assert(patched.includes("uri, data, safety: safety, cookieContainer: cookieContainer"));
  assert.throws(() => patchRezkaApi(source + source), /anchor mismatch/);
  assert.throws(() => patchRezkaApi(source.replace("Post<", "Get<")), /anchor mismatch/);
});
