import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");

const pngSize = (publicPath) => {
  const png = readFileSync(new URL(`public${publicPath}`, root));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

test("home-screen tags point at an iOS-sized icon and the manifest", () => {
  const icon = html.match(/rel="apple-touch-icon" href="([^"]+)"/)?.[1];
  assert.deepEqual(pngSize(icon), { width: 180, height: 180 });
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="apple-mobile-web-app-title" content="Nahflix"/);
  assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
});

test("manifest icons exist at the sizes they declare", () => {
  const href = html.match(/rel="manifest" href="([^"]+)"/)?.[1];
  const manifest = JSON.parse(readFileSync(new URL(`public${href}`, root), "utf8"));
  assert.equal(manifest.name, "Nahflix");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(`/app-icons/${icon.src}`), { width, height });
  }
});

test("every launch screen matches the exact pixels of the iPhone it targets", () => {
  // iOS silently shows a blank launch when the image is off by a single pixel.
  const tags = [...html.matchAll(
    /media="\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (portrait|landscape)\)" href="([^"]+)"/g,
  )];
  assert.ok(tags.length >= 22, `only ${tags.length} launch screens`);
  for (const [, deviceWidth, deviceHeight, ratio, orientation, href] of tags) {
    const portrait = { width: deviceWidth * ratio, height: deviceHeight * ratio };
    const expected = orientation === "portrait" ? portrait : { width: portrait.height, height: portrait.width };
    assert.deepEqual(pngSize(href), expected, href);
  }
});
