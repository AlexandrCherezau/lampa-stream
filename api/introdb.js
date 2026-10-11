// Fixed-host metadata relay: IntroDB does not allow arbitrary browser origins.
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });
  const input = new URL(req.url, "http://localhost").searchParams;
  const imdb = input.get("imdb_id") || "";
  const movie = input.get("is_movie") === "true";
  const season = input.get("season") || "";
  const episode = input.get("episode") || "";
  if (!/^tt\d{5,12}$/.test(imdb) || (!movie && (!/^\d{1,3}$/.test(season) || !/^[1-9]\d{0,3}$/.test(episode)))) {
    return res.status(400).json({ error: "Invalid media identifiers" });
  }
  const query = new URLSearchParams({ imdb_id: imdb });
  if (movie) query.set("is_movie", "true");
  else { query.set("season", season); query.set("episode", episode); }
  try {
    const upstream = await fetch(`https://api.introdb.app/segments?${query}`, { signal: AbortSignal.timeout(4000) });
    if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Metadata unavailable" });
    const data = await upstream.json();
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
    return res.status(200).json(data);
  } catch {
    return res.status(502).json({ error: "Metadata unavailable" });
  }
}
