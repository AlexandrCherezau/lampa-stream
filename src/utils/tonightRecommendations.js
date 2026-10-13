export const MOODS = [
  { id: 'relaxed', label: 'Полегче', description: 'Тёплая история без тяжёлых тем', genres: [35, 10751] },
  { id: 'tension', label: 'Напряжённое', description: 'Интрига и мурашки', genres: [53, 9648, 80] },
  { id: 'laugh', label: 'Посмеяться', description: 'Комедия для хорошего вечера', genres: [35] },
  { id: 'thoughtful', label: 'Подумать', description: 'История, которую захочется обсудить', genres: [18, 99, 878] },
  { id: 'adventure', label: 'Приключения', description: 'Путешествия и новые миры', genres: [12, 28, 14] },
  { id: 'romance', label: 'Романтика', description: 'Чувства крупным планом', genres: [10749] },
];
export const COMPANIES = [
  { id: 'solo', label: 'Один', genres: [18, 99, 9648] },
  { id: 'pair', label: 'Вдвоём', genres: [10749, 18, 9648] },
  { id: 'friends', label: 'С друзьями', genres: [35, 28, 12] },
  { id: 'family', label: 'С детьми', genres: [10751, 16, 12] },
];
const cancelled = (signal) => { if (signal?.aborted) throw signal.reason || new DOMException('Отменено', 'AbortError'); };
const anime = (item) => item.genres?.some((genre) => genre.id === 16) && (item.original_language === 'ja' || item.origin_country?.includes('JP') || item.production_countries?.some((country) => country.iso_3166_1 === 'JP'));

async function defaultLoad(path, apiKey, signal) {
  const { tmdbFetch } = await import('./api.js');
  cancelled(signal);
  return tmdbFetch(path, apiKey, { signal });
}

async function knownAge(item, country) {
  const { certToMinAge } = await import('./ageRating.js');
  for (const code of [...new Set([country, 'US'])]) {
    const releases = item.release_dates?.results?.find((entry) => entry.iso_3166_1 === code)?.release_dates || [];
    const candidates = [...releases.filter((entry) => entry.type === 3), ...releases.filter((entry) => entry.type !== 3)];
    for (const entry of candidates) {
      const cert = String(entry.certification || '').trim();
      if (!cert || /^(nr|unrated|not rated)$/i.test(cert)) continue;
      const minAge = certToMinAge(cert, code);
      if (minAge != null) return { minAge, cert };
    }
  }
  return { minAge: null, cert: null };
}

export async function recommendTonight({ mood = 'tension', maxMinutes = 120, company = 'pair', apiKey, history = [], watched = {}, hideAnime = false,
  ageLimit = null, ratingCountry = 'US', signal, excludeIds = [], load = defaultLoad, ageFor = knownAge, now = Date.now() } = {}) {
  const selectedMood = MOODS.find((value) => value.id === mood);
  const selectedCompany = COMPANIES.find((value) => value.id === company);
  if (!selectedMood || !selectedCompany) throw new Error('Выберите настроение и компанию');
  const limit = maxMinutes == null || maxMinutes === '' || maxMinutes === 'unlimited' || maxMinutes === Infinity || Number(maxMinutes) === 0 ? Infinity : Number(maxMinutes);
  if (!Number.isFinite(limit) && limit !== Infinity || limit <= 0) throw new Error('Некорректный лимит времени');
  if (load === defaultLoad && !apiKey) throw new Error('Сначала подключите каталог фильмов');
  const cutoff = new Date(now).toISOString().slice(0, 10);
  const excluded = new Set([...excludeIds].map(Number));
  for (const item of history) if (item.media_type !== 'tv' && item.type !== 'tv') excluded.add(Number(item.id));
  for (const [key, value] of Object.entries(watched)) if (value && /^movie_\d+$/.test(key)) excluded.add(Number(key.slice(6)));
  const effectiveAge = company === 'family' ? Math.min(12, ageLimit == null || ageLimit === '' ? 12 : Number(ageLimit)) : ageLimit == null || ageLimit === '' ? null : Number(ageLimit);
  const seen = new Set(), matched = [];
  let detailFailures = 0;
  for (let page = 1; page <= 4 && matched.length < 5; page++) {
    cancelled(signal);
    const query = new URLSearchParams({ page: String(page), sort_by: 'popularity.desc', include_adult: 'false', include_video: 'false', 'primary_release_date.lte': cutoff,
      'with_runtime.gte': '40', 'vote_count.gte': '50', with_genres: company === 'family' ? '10751' : selectedMood.genres.join('|') });
    if (limit !== Infinity) query.set('with_runtime.lte', String(limit));
    if (mood === 'relaxed') query.set('without_genres', '27,53,10752');
    const found = await load(`/discover/movie?${query}`, apiKey, signal);
    cancelled(signal);
    const candidates = (found.results || []).filter((item) => {
      const id = Number(item.id);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || excluded.has(id)) return false;
      seen.add(id); return true;
    }).slice(0, 20);
    for (let offset = 0; offset < candidates.length && matched.length < 5; offset += 4) {
      const batch = await Promise.all(candidates.slice(offset, offset + 4).map(async (candidate) => {
        cancelled(signal);
        let item;
        try { item = await load(`/movie/${candidate.id}?append_to_response=release_dates`, apiKey, signal); }
        catch (failure) { cancelled(signal); if (failure.name === 'AbortError') throw failure; detailFailures++; return null; }
        cancelled(signal);
        if (Number(item.id) !== Number(candidate.id) || item.adult || !Number.isFinite(item.runtime) || item.runtime < 40 || item.runtime > limit || !/^\d{4}-\d{2}-\d{2}$/.test(item.release_date || '') || item.release_date > cutoff) return null;
        const genres = (item.genres || []).map((genre) => genre.id);
        if (!selectedMood.genres.some((id) => genres.includes(id)) || mood === 'relaxed' && [27, 53, 10752].some((id) => genres.includes(id)) || hideAnime && anime(item)) return null;
        if (company === 'family' && !genres.includes(10751)) return null;
        const age = effectiveAge == null ? { minAge: null, cert: null } : await ageFor(item, ratingCountry);
        cancelled(signal);
        if (effectiveAge != null && (age.minAge == null || age.minAge > effectiveAge)) return null;
        const companyMatch = selectedCompany.genres.filter((id) => genres.includes(id)).length;
        const score = Math.min(10, Number(item.vote_average) || 0) + companyMatch * 0.6 + Math.min(0.5, Math.log10(Math.max(1, Number(item.vote_count) || 1)) / 10);
        return { ...item, media_type: 'movie', minAge: age.minAge, certification: age.cert, matchReason: `${selectedMood.label} · ${item.runtime} мин · ${selectedCompany.label.toLowerCase()}`, matchScore: score };
      }));
      matched.push(...batch.filter(Boolean));
      cancelled(signal);
    }
    if (page >= Number(found.total_pages || 1)) break;
  }
  if (!matched.length && detailFailures) throw new Error('Не удалось проверить фильмы. Попробуйте ещё раз.');
  return { items: matched.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5), shortfall: matched.length < 5 };
}
