const MAX_ALT_TITLES = 12;
const MAX_NAME_LENGTH = 300;
// The source host searches only the first few names, so Russian-catalogue spellings go first.
const COUNTRY_RANK = { RU: 0, UA: 1, BY: 1, KZ: 1, US: 2, GB: 2 };

// TMDB answers /movie/{id}/alternative_titles with `titles` and /tv/{id}/alternative_titles with `results`.
export function alternativeTitleNames(data, mainNames = []) {
  const entries = Array.isArray(data?.titles) ? data.titles : Array.isArray(data?.results) ? data.results : [];
  const seen = new Set(mainNames.filter((name) => typeof name === "string").map((name) => name.trim().toLowerCase()));
  return entries
    .map((entry, index) => ({ name: typeof entry?.title === "string" ? entry.title.trim() : "", rank: COUNTRY_RANK[entry?.iso_3166_1] ?? 3, index }))
    .filter(({ name }) => name && name.length <= MAX_NAME_LENGTH)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ name }) => name)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ALT_TITLES);
}
