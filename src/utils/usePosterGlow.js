// The colour of the light behind the home page posters, taken from the poster
// itself. Falls back to null (the neutral glow in CSS) when the image cannot be
// read, so a failed or tainted image never breaks the page.
import { useEffect, useState } from "react";
import { imgUrl } from "./api";

const glowCache = new Map();

function dominantHue(img) {
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 18;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 12, 18);
  const { data } = ctx.getImageData(0, 0, 12, 18);
  let r = 0, g = 0, b = 0, weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
    const w = spread * spread + 1; // Vivid pixels decide the colour, not grey ones.
    r += data[i] * w;
    g += data[i + 1] * w;
    b += data[i + 2] * w;
    weight += w;
  }
  r /= weight; g /= weight; b /= weight;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 8) return null;
  const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${Math.round(hue * 60)} 62% 40%)`;
}

export default function usePosterGlow(posterPath) {
  const [glow, setGlow] = useState(() => glowCache.get(posterPath) ?? null);
  useEffect(() => {
    if (!posterPath) { setGlow(null); return undefined; }
    if (glowCache.has(posterPath)) { setGlow(glowCache.get(posterPath)); return undefined; }
    let live = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      let color = null;
      try { color = dominantHue(img); } catch { /* unreadable image: neutral glow */ }
      glowCache.set(posterPath, color);
      if (live) setGlow(color);
    };
    img.onerror = () => { if (live) setGlow(null); };
    img.src = imgUrl(posterPath, "w92");
    return () => { live = false; };
  }, [posterPath]);
  return glow;
}
