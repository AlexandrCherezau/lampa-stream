// Renders the home-screen icons and iPhone launch screens into public/app-icons
// with the same Bebas Neue the site uses. Run by hand when the brand changes:
//   PLAYWRIGHT_CHROMIUM=<chrome> node scripts/generate-app-icons.mjs
// Needs ImageMagick. A new iPhone size goes into IPHONE_SCREENS; print the tags with --tags and
// paste them into index.html (tests/app-icons.test.mjs checks they match).
import { execFileSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

export const BACKGROUND = "#0b0c0d";

// Logical points and pixel ratio, newest first.
export const IPHONE_SCREENS = [
  { width: 440, height: 956, ratio: 3 }, // 16/17 Pro Max
  { width: 430, height: 932, ratio: 3 }, // 14/15 Pro Max, 15/16 Plus
  { width: 428, height: 926, ratio: 3 }, // 12/13 Pro Max, 14 Plus
  { width: 420, height: 912, ratio: 3 }, // Air
  { width: 414, height: 896, ratio: 3 }, // XS Max, 11 Pro Max
  { width: 414, height: 896, ratio: 2 }, // XR, 11
  { width: 402, height: 874, ratio: 3 }, // 16/17 Pro, 17
  { width: 393, height: 852, ratio: 3 }, // 14/15 Pro, 15, 16
  { width: 390, height: 844, ratio: 3 }, // 12, 13, 14
  { width: 375, height: 812, ratio: 3 }, // X, XS, 11 Pro, 12/13 mini
  { width: 375, height: 667, ratio: 2 }, // SE, 8
];

const OUT_DIR = new URL("../public/app-icons/", import.meta.url);

const startupFile = ({ width, height, ratio }, landscape) => {
  const [w, h] = landscape ? [height, width] : [width, height];
  return `startup-${w * ratio}x${h * ratio}.png`;
};

function startupTags() {
  return IPHONE_SCREENS.flatMap((screen) =>
    ["portrait", "landscape"].map((orientation) => {
      const media = `(device-width: ${screen.width}px) and (device-height: ${screen.height}px) and (-webkit-device-pixel-ratio: ${screen.ratio}) and (orientation: ${orientation})`;
      return `<link rel="apple-touch-startup-image" media="${media}" href="/app-icons/${startupFile(screen, orientation === "landscape")}" />`;
    }),
  ).join("\n");
}

const pageStyle = (font) => `
  @font-face { font-family: Bebas; src: url(data:font/woff2;base64,${font}); }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 100vw; height: 100vh; overflow: hidden; background: ${BACKGROUND};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: Bebas;
  }
  .glow { position: absolute; inset: 0; background: radial-gradient(circle at 50% 50%, rgba(63, 224, 161, .26), transparent 62%); }
  .mark {
    position: relative; line-height: .8; padding-top: .07em;
    background: linear-gradient(170deg, #7df5c4 8%, #3fe0a1 42%, #0f9468 96%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .word { position: relative; color: #f0f0f0; letter-spacing: .22em; margin-right: -.22em; }
`;

// `scale` is the share of the shorter side the N takes; maskable icons need
// the smaller one because launchers crop them to any shape.
const iconHtml = (font, scale) => `<style>${pageStyle(font)}
  .mark { font-size: ${scale * 100}vmin; }</style><div class="glow"></div><div class="mark">N</div>`;

const startupHtml = (font) => `<style>${pageStyle(font)}
  .glow { background: radial-gradient(circle at 50% 50%, rgba(63, 224, 161, .16), transparent 46vmin); }
  .mark { font-size: 34vmin; }
  .word { font-size: 8vmin; margin-top: 3vmin; }</style>
  <div class="glow"></div><div class="mark">N</div><div class="word">Nahflix</div>`;

async function render(browser, html, width, height, file) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: new URL(file, OUT_DIR).pathname });
  await page.close();
  // Opaque and paletted: iOS wants no alpha, and a dark gradient fits in 256
  // colours at about a tenth of the size.
  const path = new URL(file, OUT_DIR).pathname;
  execFileSync("magick", [path, "-alpha", "off", "+dither", "-colors", "256", "-strip", `PNG8:${path}`]);
}

async function main() {
  if (process.argv.includes("--tags")) {
    console.log(startupTags());
    return;
  }
  const font = (await readFile(new URL("../src/styles/fonts/bebas-neue-regular.woff2", import.meta.url))).toString("base64");
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  try {
    await render(browser, iconHtml(font, 0.86), 180, 180, "apple-touch-icon.png");
    await render(browser, iconHtml(font, 0.86), 192, 192, "icon-192.png");
    await render(browser, iconHtml(font, 0.86), 512, 512, "icon-512.png");
    await render(browser, iconHtml(font, 0.62), 512, 512, "icon-maskable-512.png");
    await render(browser, iconHtml(font, 0.92), 64, 64, "favicon-64.png");
    for (const screen of IPHONE_SCREENS) {
      const { width, height, ratio } = screen;
      await render(browser, startupHtml(font), width * ratio, height * ratio, startupFile(screen, false));
      await render(browser, startupHtml(font), height * ratio, width * ratio, startupFile(screen, true));
    }
  } finally {
    await browser.close();
  }
}

await main();
