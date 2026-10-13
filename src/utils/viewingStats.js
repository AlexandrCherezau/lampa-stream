const dayFormatter = (timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timestampOf = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const unwrap = (record) => record?.deleted ? null : record?.value ?? record;

export function unionViewingIntervals(intervals = []) {
  const sorted = intervals.filter((part) => Number.isFinite(part?.start) && Number.isFinite(part?.end) && part.end > part.start)
    .map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const part of sorted) {
    const previous = merged.at(-1);
    if (previous && part.start <= previous.end) previous.end = Math.max(previous.end, part.end);
    else merged.push(part);
  }
  return merged;
}

function localDateParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function midnightInZone(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const p = localDateParts(result, timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    result += target - represented;
  }
  return result;
}

function dateKey(timestamp, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(timestamp);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function recapMonthRange(month, timeZone = 'Europe/Minsk') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Некорректный месяц');
  const [year, number] = month.split('-').map(Number);
  if (year < 1970 || year > 2200) throw new Error('Некорректный год');
  return { start: midnightInZone(year, number, 1, timeZone), end: midnightInZone(number === 12 ? year + 1 : year, number === 12 ? 1 : number + 1, 1, timeZone) };
}

function contentKey(item = {}, fallback = '') {
  const type = item.type || item.media_type;
  return Number.isSafeInteger(Number(item.id)) ? `${type === 'tv' ? 'tv' : 'movie'}_${item.id}` : fallback;
}

function sessionsOf(data) {
  return Object.values(data.sessions || {}).map(unwrap).filter(Boolean);
}

function clipped(intervals, start, end) {
  return unionViewingIntervals(intervals.map((part) => ({ start: Math.max(start, part.start), end: Math.min(end, part.end) })));
}

const totalMs = (parts) => parts.reduce((sum, part) => sum + part.end - part.start, 0);
const PERSONAS = { 27: 'Мастер тёмных историй', 35: 'На светлой стороне кино', 18: 'Охотник за историями', 878: 'За пределами Земли', 12: 'Навстречу приключениям', 28: 'Всегда в движении', 10749: 'Чувства крупным планом', 16: 'Открываешь новые вселенные', 99: 'Ищешь настоящие истории', 53: 'Держишь интригу до титров', 9648: 'Разгадываешь каждый кадр', 80: 'Идёшь по следу истории', 10751: 'Собираешь близких у экрана' };

export function listRecapMonths(data = {}, timeZone = 'Europe/Minsk', now = Date.now()) {
  const months = new Set([dateKey(now, timeZone).slice(0, 7)]);
  for (const session of sessionsOf(data)) {
    for (const part of session.segments || []) {
      if (timestampOf(part.start)) months.add(dateKey(part.start, timeZone).slice(0, 7));
      if (timestampOf(part.end)) months.add(dateKey(part.end - 1, timeZone).slice(0, 7));
    }
    if (timestampOf(session.completedAt)) months.add(dateKey(session.completedAt, timeZone).slice(0, 7));
  }
  for (const record of Object.values(data.ratings || data.library?.ratings || {})) {
    const rating = unwrap(record);
    const at = timestampOf(rating?.ratedAt || record?.updatedAt);
    if (at) months.add(dateKey(at, timeZone).slice(0, 7));
  }
  return [...months].sort().reverse().slice(0, 24);
}

export function buildMonthlyRecap(data = {}, { month, timeZone = 'Europe/Minsk', now = Date.now() } = {}) {
  month ||= dateKey(now, timeZone).slice(0, 7);
  const { start, end } = recapMonthRange(month, timeZone);
  const sessions = sessionsOf(data);
  const allParts = [];
  const perTitle = new Map();
  const completedMovies = new Set();
  const completedEpisodes = new Set();
  for (const session of sessions) {
    const parts = clipped(session.segments || [], start, end);
    allParts.push(...parts);
    if (parts.length) {
      const key = contentKey(session.item, session.progressKey);
      const title = perTitle.get(key) || { item: session.item || {}, parts: [] };
      title.parts.push(...parts);
      perTitle.set(key, title);
    }
    if (timestampOf(session.completedAt) >= start && timestampOf(session.completedAt) < end) {
      if (session.item?.type === 'tv' || session.item?.media_type === 'tv') completedEpisodes.add(session.progressKey);
      else completedMovies.add(contentKey(session.item, session.progressKey));
    }
  }
  const intervals = unionViewingIntervals(allParts);
  const genreTotals = new Map();
  const genreEvents = [];
  let titleIndex = 0;
  for (const { item, parts } of perTitle.values()) {
    const genres = [...new Map((item.genres || []).filter((genre) => genre && Number.isInteger(genre.id) && genre.name).map((genre) => [genre.id, genre])).values()];
    for (const part of unionViewingIntervals(parts)) {
      genreEvents.push({ at: part.start, id: titleIndex, genres }, { at: part.end, id: titleIndex, genres: null });
    }
    titleIndex++;
  }
  genreEvents.sort((a, b) => a.at - b.at);
  const active = new Map();
  let previousTime = 0;
  for (const event of genreEvents) {
    const elapsed = event.at - previousTime;
    if (elapsed > 0 && active.size) for (const genres of active.values()) for (const genre of genres) {
      const entry = genreTotals.get(genre.id) || { id: genre.id, name: genre.name, watchMs: 0 };
      entry.watchMs += elapsed / active.size / genres.length;
      genreTotals.set(genre.id, entry);
    }
    if (event.genres) active.set(event.id, event.genres);
    else active.delete(event.id);
    previousTime = event.at;
  }
  const genreMs = [...genreTotals.values()].reduce((sum, genre) => sum + genre.watchMs, 0);
  const genres = [...genreTotals.values()].sort((a, b) => b.watchMs - a.watchMs).map((genre) => ({ ...genre, share: genreMs ? genre.watchMs / genreMs : 0 }));
  const topRatings = Object.values(data.ratings || data.library?.ratings || {}).map((record) => {
    const rating = unwrap(record);
    return rating && { ...rating, ratedAt: timestampOf(rating.ratedAt || record.updatedAt) };
  }).filter((rating) => rating && rating.score >= 1 && rating.score <= 10 && rating.ratedAt >= start && rating.ratedAt < end)
    .sort((a, b) => b.score - a.score || b.ratedAt - a.ratedAt).slice(0, 5);
  const days = [];
  for (let timestamp = start; timestamp < end;) {
    const day = dateKey(timestamp, timeZone);
    const [year, number, date] = day.split('-').map(Number);
    const next = midnightInZone(year, number, date + 1, timeZone);
    days.push({ day, watchMs: totalMs(clipped(intervals, timestamp, next)) });
    timestamp = next;
  }
  const watchMs = totalMs(intervals);
  const trackedTimes = sessions.flatMap((session) => (session.segments || []).map((part) => part.start)).filter(Number.isFinite);
  const trackedSince = trackedTimes.length ? trackedTimes.reduce((min, value) => Math.min(min, value), Infinity) : timestampOf(data.recordingStartedAt) || now;
  const recordedKeys = new Set(sessions.map((session) => session.progressKey));
  const legacyEntries = (data.history || data.legacy?.history || []).filter((item) => {
    const key = contentKey(item);
    const progressKey = item.media_type === 'tv' || item.type === 'tv' ? `${key}_s${item.season}e${item.episode}` : key;
    return !recordedKeys.has(progressKey);
  }).length;
  return { month, label: new Intl.DateTimeFormat('ru-RU', { timeZone, month: 'long', year: 'numeric' }).format(start + 12 * 3600000), watchMs, watchHours: watchMs / 3600000,
    completedMovies: completedMovies.size, completedEpisodes: completedEpisodes.size, activeTitles: perTitle.size,
    genres, genreCoverage: watchMs ? genreMs / watchMs : 0, topRatings, days, coverage: { trackedSince, legacyEntries },
    empty: !watchMs && !completedMovies.size && !completedEpisodes.size && !topRatings.length,
    persona: genres.length ? PERSONAS[genres[0].id] || `Твой жанр — ${genres[0].name.toLowerCase()}` : 'Твой следующий кадр впереди' };
}
