import { createHash } from "node:crypto";

const ORIGIN = "https://befriend.stravers.live";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const fingerprint = createHash("sha256").update("fingerprint-alloha").digest("hex");

// Anonymous player protocol: regroup characters by bit length, trailing-zero
// count, then the next-prime permutation. Data only; no downloaded JS execution.
export function createAllohaBorth(viewport) {
  if (typeof viewport !== "string" || !viewport.length || viewport.length > 4096) throw new Error("Alloha returned invalid viewport data");
  const size = viewport.length;
  const bits = Math.ceil(Math.log2(size));
  function regroup(text, bucket, reverse) {
    const counts = Array(bits + 1).fill(0);
    for (let index = 0; index < size; index++) counts[bucket(index)]++;
    const groups = Array(bits + 1), used = Array(bits + 1).fill(0);
    let offset = 0;
    for (const index of Array.from({ length: bits + 1 }, (_, i) => reverse ? bits - i : i)) {
      groups[index] = text.slice(offset, offset + counts[index]); offset += counts[index];
    }
    return Array.from({ length: size }, (_, index) => { const group = bucket(index); return groups[group][used[group]++]; }).join("");
  }
  const bitLength = (value) => value ? Math.floor(Math.log2(value)) + 1 : 0;
  const trailingZeros = (value) => { if (!value) return bits; let count = 0; while (!(value & 1)) { count++; value >>= 1; } return count; };
  const grouped = regroup(regroup(viewport, bitLength, true), trailingZeros, false);
  const prime = (value) => { if (value < 2) return false; for (let i = 2; i * i <= value; i++) if (value % i === 0) return false; return true; };
  let modulus = Math.max(2, size + 1);
  while (!prime(modulus)) modulus++;
  const output = Array(size); let position = 0, consumed = 0;
  while (consumed < size) { position = (position + 2) % modulus; if (position < size) output[position] = grouped[consumed++]; }
  return `${fingerprint}|${output.join("")}`;
}

export function parseAllohaBootstrap(html) {
  const viewport = /<meta\b[^>]*\bname=["']viewporti["'][^>]*\bcontent=["']([^"']+)["']/i.exec(html)?.[1];
  const raw = /\bfileList\s*=\s*JSON\.parse\('([^']+)'\)/.exec(html)?.[1];
  let list; try { list = JSON.parse(raw); } catch { throw new Error("Alloha returned invalid movie data"); }
  const id = String(list?.active?.id ?? "");
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Alloha returned invalid movie ID");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => new URL(match[1], ORIGIN));
  const app = scripts.filter((url) => url.origin === ORIGIN && /^\/build\/app\.[a-z0-9]+\.js$/.test(url.pathname) && !url.username && !url.password && !url.hash);
  if (app.length !== 1) throw new Error("Alloha player protocol bundle is unavailable");
  return { movieId: id, bundleUrl: app[0].href, borth: createAllohaBorth(viewport) };
}

export function parseAllohaGuard(bundle) {
  const matches = [...bundle.matchAll(/return\s+\w+\['a'\]\([^;]{0,100},'([A-Za-z0-9]{256,1024})'\)/g)];
  if (matches.length !== 1) throw new Error("Alloha player protocol guard is unavailable");
  return matches[0][1];
}

function urls(raw) {
  if (typeof raw !== "string" || raw.length > 32768) throw new Error("Alloha returned invalid media data");
  return raw.split(" or ").map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Alloha returned an unsupported media URL");
    return url.href;
  });
}

export function parseAllohaSources(data) {
  if (!Array.isArray(data?.hlsSource) || !data.hlsSource.length || data.hlsSource.length > 32) throw new Error("Alloha did not return movie streams");
  const ids = new Set();
  const voices = data.hlsSource.map((voice) => {
    const id = String(voice.audioId ?? "");
    if (!/^\d{1,8}$/.test(id) || ids.has(id) || typeof voice.label !== "string" || !voice.label.trim() || voice.label.length > 300) throw new Error("Alloha returned invalid audio data");
    ids.add(id);
    const qualities = Object.entries(voice.quality || {}).filter(([height]) => /^(360|480|720|1080|1440|2160)$/.test(height))
      .map(([height, value]) => ({ label: `${height}p`, height: Number(height), urls: urls(value) }));
    if (!qualities.length) throw new Error("Alloha did not return supported qualities");
    return { id, name: voice.label.trim(), default: voice.default === true, qualities };
  });
  const subtitles = (Array.isArray(data.tracks) ? data.tracks : []).filter((track) => track.kind === "captions" || track.kind === "subtitles")
    .slice(0, 32).map((track, index) => ({ url: urls(track.src)[0], label: String(track.label || `Субтитры ${index + 1}`).slice(0, 200), language: typeof track.language === "string" ? track.language.slice(0, 32) : null }));
  const ws = new URL(data.pnr);
  if (ws.origin !== ORIGIN.replace("https:", "wss:") || ws.pathname !== "/ws/" || ws.search || ws.hash || ws.username || ws.password
    || typeof data.pnk !== "string" || !data.pnk.length || data.pnk.length > 8192) throw new Error("Alloha returned an unsupported playback session");
  ws.searchParams.set("sid", data.pnk); ws.searchParams.set("v", "2.1"); ws.searchParams.set("t", String(Date.now()));
  return { voices, subtitles, websocketUrl: ws.href };
}

export function openAllohaPlayback(websocketUrl, voice, { signal, WebSocketImpl = WebSocket } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(websocketUrl);
    let finished = false;
    const finish = (error, hash) => { if (finished) return; finished = true; signal?.removeEventListener("abort", abort); clearTimeout(timer); socket.close(); error ? reject(error) : resolve(hash); };
    const abort = () => finish(signal.reason || new Error("Alloha playback was cancelled"));
    const timer = setTimeout(() => finish(new Error("Alloha playback session timed out")), 6000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      if (finished || signal?.aborted) return;
      try { socket.send(JSON.stringify({ type: "playback_start", current_time: 0,
        resolution: String(voice.qualities.some((quality) => quality.height === 720) ? 720 : voice.qualities[0].height),
        track_id: voice.id, speed: 1, subtitle: -1, ts: Date.now() })); }
      catch { finish(new Error("Alloha playback session failed")); }
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > 65536) return finish(new Error("Alloha returned invalid playback data"));
      let data; try { data = JSON.parse(event.data); } catch { return finish(new Error("Alloha returned invalid playback data")); }
      if (data.type === "config_update" && typeof data.edge_hash === "string" && /^[a-zA-Z0-9_-]{16,256}$/.test(data.edge_hash)) finish(null, data.edge_hash);
    });
    socket.addEventListener("error", () => finish(new Error("Alloha playback session failed")));
    socket.addEventListener("close", () => { if (!finished) finish(new Error("Alloha playback session closed without media data")); });
  });
}

export const allohaUserAgent = UA;
