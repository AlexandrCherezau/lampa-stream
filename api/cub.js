const FEEDS = {
  now_playing: "/?sort=now_playing",
  latest: "/?sort=latest",
  fire: "/top/fire/movie",
  hundred: "/top/hundred/movie",
};
const BODY_LIMIT = 1024 * 1024;
export const maxDuration = 15;

export function normalizeCubFeed(data, page) {
  if (!data || !Array.isArray(data.results) || data.page !== page
    || !Number.isSafeInteger(data.total_pages) || data.total_pages < 0) throw new Error("Invalid catalog response");
  const results = data.results.flatMap((card) => {
    if (!card || typeof card !== "object") return [];
    const id = typeof card.id === "number" || (typeof card.id === "string" && String(Number(card.id)) === card.id) ? Number(card.id) : 0;
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    const movie = typeof card.title === "string" && !!card.title.trim();
    const tv = typeof card.name === "string" && !!card.name.trim();
    if (movie === tv || (card.media_type != null && card.media_type !== (movie ? "movie" : "tv"))) return [];
    return [{ ...card, id, media_type: movie ? "movie" : "tv", catalogSource: "vi3000" }];
  });
  return { ...data, results };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  const params = new URL(req.url, "http://localhost").searchParams;
  const feed = params.get("feed");
  const page = params.get("page") ?? "1";
  if (!Object.hasOwn(FEEDS, feed) || !/^[1-9]\d{0,4}$/.test(page) || page !== String(Number(page)) || Number(page) > 10_000
    || params.getAll("feed").length !== 1 || params.getAll("page").length > 1
    || [...params.keys()].some((key) => key !== "feed" && key !== "page")) {
    return res.status(400).json({ error: "INVALID_CATALOG_REQUEST", message: "Неверная лента или страница каталога" });
  }
  const target = new URL(FEEDS[feed], "https://tmdb.cub.best");
  target.searchParams.set("page", page);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", onClose);
  try {
    const upstream = await fetch(target, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!upstream.ok || !/^application\/json\b/i.test(upstream.headers.get("content-type") || "")
      || Number(upstream.headers.get("content-length")) > BODY_LIMIT || !upstream.body) throw new Error("Catalog unavailable");
    const chunks = [];
    let size = 0;
    for await (const chunk of upstream.body) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error("Catalog response too large");
      chunks.push(chunk);
    }
    const data = normalizeCubFeed(JSON.parse(Buffer.concat(chunks).toString("utf8")), Number(page));
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(data);
  } catch {
    if (!res.destroyed && !res.writableEnded) return res.status(controller.signal.aborted ? 504 : 502).json({
      error: controller.signal.aborted ? "CUB_TIMEOUT" : "CUB_UNAVAILABLE",
      message: controller.signal.aborted ? "Каталог CUB не ответил вовремя" : "Каталог CUB временно недоступен",
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
    res.off("close", onClose);
  }
}
