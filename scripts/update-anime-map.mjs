// Keep only facts needed for TMDB season/cour -> MAL episode matching.
// Source: https://github.com/Fribb/anime-lists, accessed 2026-10-07.
import { writeFile } from "node:fs/promises";

const response = await fetch("https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json", { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Anime mapping download failed: ${response.status}`);
const groups = new Map();
for (const entry of await response.json()) {
  const tv = entry.themoviedb_id?.tv;
  const season = entry.season?.tmdb;
  const mal = entry.mal_id;
  const offset = entry.episode_offset?.tmdb ?? 0;
  if (entry.type === "MOVIE" || ![tv, season, mal, offset].every(Number.isInteger) ||
      tv <= 0 || season < 0 || mal <= 0 || offset < 0) continue;
  const key = `${tv}:${season}`;
  if (!groups.has(key)) groups.set(key, new Map());
  groups.get(key).set(`${offset}:${mal}`, [offset, mal]);
}
if (groups.size < 1000) throw new Error("Incomplete anime mapping dataset");
const result = Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => [
  key, [...entries.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
]));
await writeFile(new URL("../src/utils/anime-season-map.json", import.meta.url), JSON.stringify(result) + "\n");
console.log(`Updated ${groups.size} anime season mappings`);
