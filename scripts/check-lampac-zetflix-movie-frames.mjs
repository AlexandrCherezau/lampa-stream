import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { SERIAL_FRAME_DOCUMENT_SCRIPT, MOVIE_FRAME_RESOURCES_SCRIPT } from "../infrastructure/lampac/patch-zetflix-diagnostics.mjs";

const manifestPath = "/movie/720.mp4:hls:manifest.m3u8";
const server = createServer((request, response) => {
  if (request.url === manifestPath) {
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "access-control-allow-origin": "*" });
    response.end("#EXTM3U\n#EXT-X-ENDLIST\n");
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(request.url === "/player"
    ? '<iframe id="movie" src="/nested"></iframe>'
    : `<script>fetch(${JSON.stringify(manifestPath)}).then(() => { window.loaded = true; });</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`${origin}/player`, { waitUntil: "networkidle" });
  const movie = await (await page.$("#movie")).contentFrame();
  await movie.waitForFunction("window.loaded === true");
  const resources = (frame) => frame.evaluate(`(${MOVIE_FRAME_RESOURCES_SCRIPT})()`);
  assert.ok(!(await resources(page.mainFrame())).includes(`${origin}${manifestPath}`), "top-page resources cannot see the nested movie manifest");
  assert.ok((await resources(movie)).includes(`${origin}${manifestPath}`));
  const documentUri = await movie.evaluate(`(${SERIAL_FRAME_DOCUMENT_SCRIPT})()`);
  assert.equal(documentUri, `${origin}/nested`, "manifest headers must retain the owning frame document");
  assert.equal(new URL(documentUri).origin, origin);
  console.log("Zetflix movie frames: nested manifest visible only in owning frames; exact document provenance retained");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
