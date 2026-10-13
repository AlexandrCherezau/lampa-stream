import { normalizeHabsterCard } from "./habster.js";

const SOLR_ORIGIN = "https://zsolr3.zonasearch.com";
const METADATA_ORIGIN = "https://habster.sbs";
const PAGE_SIZE = 20;
const BODY_LIMIT = 1024 * 1024;
export const maxDuration = 30;

const normalizedName = (value) => typeof value === "string" && value.length <= 300
  ? value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";

function validMovie(doc) {
  return doc && ["number", "string"].includes(typeof doc.id) && /^[1-9]\d*$/.test(String(doc.id))
    && Number.isSafeInteger(Number(doc.id)) && String(Number(doc.id)) === String(doc.id)
    && doc.serial === false && doc.adult === false
    && Number.isSafeInteger(doc.year) && doc.year >= 1880 && doc.year <= 2200
    && [doc.name_rus, doc.name_original].some((name) => normalizedName(name));
}

export function normalizeZonaCard(doc, info) {
  if (!validMovie(doc) || info?.year !== doc.year || info?.kinopoiskId !== Number(doc.id)
    || typeof info?.imdbId !== "string" || info.imdbId !== info.imdbId.trim()
    || ![info?.nameRu, info?.nameOriginal, info?.nameEn].some((name) => {
      const normalized = normalizedName(name);
      return normalized && [doc.name_rus, doc.name_original].some((alias) => normalizedName(alias) === normalized);
    })) return null;
  const card = normalizeHabsterCard({ kp_id: doc.id, type: "film" }, info);
  return card ? { ...card, catalogSource: "zona" } : null;
}

async function readJson(url, signal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  bounded.throwIfAborted();
  const upstream = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: bounded });
  if (!upstream.ok || !/^application\/json\b/i.test(upstream.headers.get("content-type") || "")
    || Number(upstream.headers.get("content-length")) > BODY_LIMIT || !upstream.body) {
    await upstream.body?.cancel();
    throw new Error("Catalog unavailable");
  }
  const reader = upstream.body.getReader();
  const abort = () => { reader.cancel(bounded.reason).catch(() => {}); };
  bounded.addEventListener("abort", abort, { once: true });
  try {
    bounded.throwIfAborted();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      bounded.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) throw new Error("Catalog response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    bounded.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  const params = new URL(req.url, "http://localhost").searchParams;
  const page = params.get("page") ?? "1";
  if (params.get("feed") !== "popular" || !/^[1-9]\d{0,4}$/.test(page) || Number(page) > 10_000
    || params.getAll("feed").length !== 1 || params.getAll("page").length > 1
    || [...params.keys()].some((key) => key !== "feed" && key !== "page")) {
    return res.status(400).json({ error: "INVALID_CATALOG_REQUEST", message: "Неверная подборка Zona" });
  }
  const start = (Number(page) - 1) * PAGE_SIZE;
  const target = new URL("/solr/movie/select/", SOLR_ORIGIN);
  target.search = new URLSearchParams({ q: "serial:false AND adult:false", sort: "popularity desc",
    rows: String(PAGE_SIZE), start: String(start), wt: "json", fl: "id,name_rus,name_original,year,serial,adult" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", onClose);
  try {
    const data = await readJson(target, controller.signal);
    const docs = data?.response?.docs;
    const total = data?.response?.numFound;
    if (!Array.isArray(docs) || docs.length > PAGE_SIZE || !Number.isSafeInteger(total) || total < docs.length
      || data.response.start !== start) throw new Error("Invalid catalog response");
    const seen = new Set();
    const cards = docs.filter((doc) => {
      if (!validMovie(doc) || seen.has(Number(doc.id))) return false;
      seen.add(Number(doc.id));
      return true;
    });
    const results = Array(cards.length).fill(null);
    let cursor = 0;
    let failures = 0;
    await Promise.all(Array.from({ length: Math.min(4, cards.length) }, async () => {
      while (cursor < cards.length) {
        controller.signal.throwIfAborted();
        const index = cursor++;
        try {
          const info = await readJson(new URL(`/getinfo.php?kp_id=${Number(cards[index].id)}`, METADATA_ORIGIN), controller.signal);
          results[index] = normalizeZonaCard(cards[index], info);
        } catch {
          controller.signal.throwIfAborted();
          failures++;
        }
      }
    }));
    controller.signal.throwIfAborted();
    if (cards.length && failures === cards.length) throw new Error("Metadata unavailable");
    const mapped = results.filter(Boolean);
    if (!failures && mapped.length === docs.length) {
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    }
    return res.status(200).json({ page: Number(page), total_pages: Math.max(1, Math.min(10_000, Math.ceil(total / PAGE_SIZE))),
      results: mapped, unmapped: docs.length - mapped.length });
  } catch {
    if (!res.destroyed && !res.writableEnded) return res.status(controller.signal.aborted ? 504 : 502).json({
      error: controller.signal.aborted ? "ZONA_TIMEOUT" : "ZONA_UNAVAILABLE",
      message: controller.signal.aborted ? "Zona не ответила вовремя" : "Подборка Zona временно недоступна",
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    res.off("close", onClose);
  }
}
