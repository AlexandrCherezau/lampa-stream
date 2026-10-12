import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { SERIAL_FRAME_DOCUMENT_SCRIPT } from "../infrastructure/lampac/patch-zetflix-diagnostics.mjs";
const expression = `(${SERIAL_FRAME_DOCUMENT_SCRIPT})()`;

const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<iframe id="blank"></iframe>
    <iframe id="srcdoc" srcdoc="<p>Player</p>"></iframe>
    <iframe id="sandbox" sandbox="allow-scripts" srcdoc="<p>Opaque player</p>"></iframe>
    <iframe id="changed-base" srcdoc="<base href='https://different.example/'>"></iframe>
    <iframe id="data" src="data:text/html,Player"></iframe>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/player`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  assert.equal(await page.mainFrame().evaluate(expression), url);
  for (const id of ["blank", "srcdoc"]) {
    const frame = await (await page.$(`#${id}`)).contentFrame();
    assert.equal(await frame.evaluate(expression), url, `${id} must preserve its verified inherited document`);
  }
  for (const id of ["sandbox", "changed-base", "data"]) {
    const frame = await (await page.$(`#${id}`)).contentFrame();
    assert.equal(await frame.evaluate(expression), null, `${id} must not borrow a parent document`);
  }
  const blankPage = await browser.newPage();
  assert.equal(await blankPage.evaluate(expression), null, "an unproven top-level blank page must be rejected");
  console.log("Zetflix frame provenance: HTTP and inherited frames accepted; opaque, changed-base, data and top-level blank frames rejected");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
