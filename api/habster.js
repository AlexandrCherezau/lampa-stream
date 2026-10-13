const ORIGIN = "https://habster.sbs";
const BODY_LIMIT = 1024 * 1024;
export const maxDuration = 30;

function positiveId(value) {
  return ["string", "number"].includes(typeof value) && /^[1-9]\d*$/.test(String(value))
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function normalizeHabsterCard(card, info) {
  const id = positiveId(card?.kp_id);
  const type = card?.type === "film" ? "movie" : card?.type === "series" ? "tv" : null;
  if (!id || !type || positiveId(info?.kinopoiskId) !== id
    || !/^tt\d{5,12}$/.test(info?.imdbId || "")
    || (type === "movie" ? info?.type !== "FILM" : !["TV_SERIES", "MINI_SERIES", "TV_SHOW"].includes(info?.type))) return null;
  const title = info.nameRu || info.nameOriginal || info.nameEn;
  if (typeof title !== "string" || !title.trim() || title.length > 300) return null;
  return { kinopoisk_id: id, imdb_id: info.imdbId, media_type: type,
    [type === "movie" ? "title" : "name"]: title.trim(), catalogSource: "habster" };
}

async function readJson(path, signal) {
  signal.throwIfAborted();
  const upstream = await fetch(new URL(path, ORIGIN), {
    headers: { accept: "application/json" }, redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!upstream.ok || !/^application\/json\b/i.test(upstream.headers.get("content-type") || "")
    || Number(upstream.headers.get("content-length")) > BODY_LIMIT || !upstream.body) {
    await upstream.body?.cancel();
    throw new Error("Catalog unavailable");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("Catalog response too large");
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  const params = new URL(req.url, "http://localhost").searchParams;
  if (params.get("feed") !== "popular" || (params.get("page") ?? "1") !== "1"
    || params.getAll("feed").length !== 1 || params.getAll("page").length > 1
    || [...params.keys()].some((key) => key !== "feed" && key !== "page")) {
    return res.status(400).json({ error: "INVALID_CATALOG_REQUEST", message: "Неверная подборка Habster" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", onClose);
  try {
    const popular = await readJson("/popular.php", controller.signal);
    if (!Array.isArray(popular) || popular.length > 20) throw new Error("Invalid catalog response");
    const seen = new Set();
    const cards = popular.filter((card) => {
      const id = positiveId(card?.kp_id);
      if (!id || !["film", "series"].includes(card.type) || seen.has(id)) return false;
      seen.add(id);
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
          const info = await readJson(`/getinfo.php?kp_id=${Number(cards[index].kp_id)}`, controller.signal);
          results[index] = normalizeHabsterCard(cards[index], info);
        } catch {
          controller.signal.throwIfAborted();
          failures++;
        }
      }
    }));
    controller.signal.throwIfAborted();
    if (cards.length && failures === cards.length) throw new Error("Metadata unavailable");
    const mapped = results.filter(Boolean);
    if (!failures) res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ page: 1, total_pages: 1, results: mapped, unmapped: popular.length - mapped.length });
  } catch {
    if (!res.destroyed && !res.writableEnded) return res.status(controller.signal.aborted ? 504 : 502).json({
      error: controller.signal.aborted ? "HABSTER_TIMEOUT" : "HABSTER_UNAVAILABLE",
      message: controller.signal.aborted ? "Habster не ответил вовремя" : "Подборка Habster временно недоступна",
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    res.off("close", onClose);
  }
}
