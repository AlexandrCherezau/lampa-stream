import { useCallback, useEffect, useRef, useState } from "react";
import { COMPANIES, MOODS, recommendTonight } from "../utils/tonightRecommendations";
import { getAgeLimitSetting, getRatingCountry } from "../utils/ageRating";
import { hideAnimeEnabled, imgUrl } from "../utils/api";
import { storage } from "../utils/storage";

const TIME_OPTIONS = [{ id: 90, label: "До 90 минут" }, { id: 120, label: "До 2 часов" }, { id: 180, label: "До 3 часов" }, { id: null, label: "Без лимита" }];
const today = new Date().toISOString().slice(0, 10);
const runtimeOf = (item) => Number(item.runtimeMinutes ?? item.runtime ?? item.mediaRuntime);
const dateOf = (item) => item.release_date || item.first_air_date || "";

export default function TonightPage({ apiKey, history = [], watched = {}, onSelect }) {
  const [mood, setMood] = useState(MOODS[0]?.id || "adventure");
  const [maxMinutes, setMaxMinutes] = useState(120);
  const [company, setCompany] = useState(COMPANIES[0]?.id || "solo");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [excluded, setExcluded] = useState([]);
  const controllerRef = useRef(null);
  const requestIdRef = useRef(0);
  const cancel = useCallback(() => { controllerRef.current?.abort(); controllerRef.current = null; setLoading(false); setResult(null); setError(""); setExcluded([]); }, []);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const choose = useCallback(async (excludeIds = []) => {
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    setExcluded(excludeIds); setLoading(true); setError(""); setResult(null);
    try {
      const response = await recommendTonight({ mood, maxMinutes, company, apiKey, history, watched, hideAnime: hideAnimeEnabled(), ageLimit: getAgeLimitSetting(storage), ratingCountry: getRatingCountry(storage), signal: controller.signal, excludeIds });
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      const items = (response?.items || []).filter((item) => item?.id && item.media_type !== "tv" && item.title && dateOf(item) && dateOf(item) <= today && Number.isFinite(runtimeOf(item)) && runtimeOf(item) > 0 && (maxMinutes == null || runtimeOf(item) <= maxMinutes));
      setResult({ ...response, items, shortfall: response?.shortfall || items.length < 5 });
      if (!items.length) setError("Не нашлось пяти фильмов с подходящей длительностью и доступными данными. Попробуй другое настроение или время.");
    } catch (failure) {
      if (failure?.name !== "AbortError" && !controller.signal.aborted && requestIdRef.current === requestId) setError(failure?.message || "Не удалось подобрать фильмы. Проверь соединение и попробуй ещё раз.");
    } finally { if (requestIdRef.current === requestId) setLoading(false); }
  }, [mood, maxMinutes, company, apiKey, history, watched]);

  const onReroll = () => choose([...excluded, ...(result?.items || []).map((item) => item.id)]);
  const moodLabel = MOODS.find((choice) => choice.id === mood)?.label || "твоё настроение";
  return <main className="personal-page tonight-page">
    <header className="personal-page-head"><div><h1>Что смотрим?</h1><p>Пять фильмов, которые подходят твоему настроению, времени и компании.</p></div></header>
    <section className="tonight-chooser">
      <h2 className="tonight-chooser-title">Настроить подборку</h2>
      <fieldset className="tonight-field"><legend>Какого ощущения хочется?</legend><div className="tonight-options tonight-moods">{MOODS.map((choice) => <button type="button" key={choice.id} className={`tonight-option${mood === choice.id ? " is-active" : ""}`} aria-pressed={mood === choice.id} onClick={() => { cancel(); setMood(choice.id); }}>{choice.label}</button>)}</div></fieldset>
      <div className="tonight-prefs"><fieldset className="tonight-field"><legend>Сколько есть времени?</legend><div className="tonight-options">{TIME_OPTIONS.map((option) => <button type="button" key={String(option.id)} className={`tonight-pill${maxMinutes === option.id ? " is-active" : ""}`} aria-pressed={maxMinutes === option.id} onClick={() => { cancel(); setMaxMinutes(option.id); }}>{option.label}</button>)}</div></fieldset>
        <fieldset className="tonight-field"><legend>С кем смотришь?</legend><div className="tonight-options">{COMPANIES.map((choice) => <button type="button" key={choice.id} className={`tonight-pill${company === choice.id ? " is-active" : ""}`} aria-pressed={company === choice.id} onClick={() => { cancel(); setCompany(choice.id); }}>{choice.label}</button>)}</div></fieldset></div>
      <div className="tonight-submit-row"><p>Сейчас выбираем: <strong>{moodLabel.toLocaleLowerCase("ru-RU")}</strong> · {TIME_OPTIONS.find((option) => option.id === maxMinutes)?.label.toLowerCase()} · {COMPANIES.find((choice) => choice.id === company)?.label.toLowerCase()}</p><div>{loading && <button className="btn btn-ghost" onClick={cancel}>Отменить</button>}<button className="btn btn-primary tonight-submit" disabled={loading || !apiKey} onClick={() => choose([])}>{loading ? <><span className="tonight-spinner"/>Ищем истории…</> : result ? "Подобрать заново" : "Найти пять фильмов"}</button></div></div>
      {!apiKey && <p className="tonight-inline-error">Для подбора нужен подключённый каталог фильмов.</p>}
    </section>
    {(error || (result?.shortfall && result.items.length > 0)) && <div className="tonight-feedback" role="status">{error || `Подходящих фильмов нашлось ${result.items.length}. Мы оставили только варианты, проходящие твои фильтры.`}</div>}
    {result?.items?.length > 0 && <section className="tonight-results" aria-live="polite"><div className="tonight-results-heading"><h2>Пять историй на сегодня</h2><button className="btn btn-secondary" onClick={onReroll} disabled={loading}>Другие варианты <span aria-hidden="true">↻</span></button></div>
      <div className="tonight-film-grid">{result.items.map((item, index) => <article className="tonight-film" data-movie-id={item.id} key={`${item.id}-${index}`}><button type="button" className="tonight-film-poster" onClick={() => onSelect({ ...item, media_type: "movie" })} aria-label={`Открыть ${item.title}`}><span className="tonight-film-index">0{index + 1}</span>{item.poster_path ? <img src={imgUrl(item.poster_path, "w342")} loading="lazy" alt=""/> : <span className="tonight-poster-fallback">КИНО</span>}<span className="tonight-poster-play">▶</span></button><div className="tonight-film-copy"><div className="tonight-film-meta"><span>{String(dateOf(item)).slice(0, 4)}</span><span>{runtimeOf(item)} мин</span>{item.vote_average > 0 && <span>★ {Number(item.vote_average).toFixed(1)}</span>}</div><h3>{item.title}</h3><p>{item.matchReason || item.reason || `Подходит под настроение «${moodLabel.toLowerCase()}»`}</p><button type="button" className="tonight-film-open" onClick={() => onSelect({ ...item, media_type: "movie" })}>О фильме <span>↗</span></button></div></article>)}</div>
      <p className="tonight-result-footnote">Подборка проверяет дату выхода, фактический хронометраж, возрастные ограничения и скрытое аниме. Уже просмотренные фильмы исключаются.</p>
    </section>}
  </main>;
}
