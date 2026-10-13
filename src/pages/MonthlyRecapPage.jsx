import { useMemo, useState, useSyncExternalStore } from "react";
import { buildMonthlyRecap, listRecapMonths } from "../utils/viewingStats";
import { getViewingProfileSnapshot, subscribeViewingProfile } from "../utils/viewingProfile";

const duration = (hours) => {
  const numericHours = Number(hours);
  const totalMinutes = Number.isFinite(numericHours) ? Math.max(0, Math.round(numericHours * 60)) : 0;
  const whole = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return whole ? `${whole} ч${minutes ? ` ${minutes} мин` : ""}` : `${minutes} мин`;
};
const currentMonth = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Minsk", year: "numeric", month: "2-digit" }).formatToParts(Date.now());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}`;
};

function drawRecapCard(recap) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 1500;
  const ctx = canvas.getContext("2d");
  const bg = ctx.createLinearGradient(0, 0, 1200, 1500);
  bg.addColorStop(0, "#12101b"); bg.addColorStop(.58, "#08080b"); bg.addColorStop(1, "#240c18");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 1200, 1500);
  ctx.fillStyle = "#ff314f"; ctx.fillRect(0, 0, 18, 1500);
  ctx.globalAlpha = .16; ctx.fillStyle = "#9270ff"; ctx.beginPath(); ctx.arc(1040, 210, 300, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = "#ff314f"; ctx.font = "600 24px 'DM Sans', sans-serif"; ctx.fillText("STREAMBERT · ЛИЧНЫЕ ИТОГИ", 88, 106);
  ctx.fillStyle = "#f5f4ef"; ctx.font = "64px 'Bebas Neue', sans-serif"; ctx.fillText(recap.label.toLocaleUpperCase("ru-RU"), 84, 205);
  ctx.fillStyle = "#bdb9c7"; ctx.font = "30px 'DM Sans', sans-serif"; ctx.fillText(recap.persona, 90, 265, 980);
  ctx.fillStyle = "#ff314f"; ctx.font = "164px 'Bebas Neue', sans-serif"; ctx.fillText(duration(recap.watchHours), 74, 500);
  ctx.fillStyle = "#c5c1cc"; ctx.font = "28px 'DM Sans', sans-serif"; ctx.fillText("проведено за просмотром", 92, 555);
  ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(90, 620); ctx.lineTo(1110, 620); ctx.stroke();
  const stats = [[String(recap.completedMovies), "фильмов"], [String(recap.completedEpisodes), "серий"], [String(recap.activeTitles), "историй"]];
  stats.forEach(([value, label], index) => { const x = 98 + index * 355; ctx.fillStyle = "#f5f4ef"; ctx.font = "86px 'Bebas Neue', sans-serif"; ctx.fillText(value, x, 755); ctx.fillStyle = "#aaa6b2"; ctx.font = "25px 'DM Sans', sans-serif"; ctx.fillText(label, x, 800); });
  ctx.fillStyle = "#f5f4ef"; ctx.font = "42px 'Bebas Neue', sans-serif"; ctx.fillText("ЖАНРЫ ЭТОГО МЕСЯЦА", 90, 920);
  const genres = recap.genres.slice(0, 4);
  genres.forEach((genre, index) => {
    const y = 1000 + index * 75; ctx.fillStyle = index === 0 ? "#ffd45a" : "#e8e5ec"; ctx.font = "30px 'DM Sans', sans-serif"; ctx.fillText(genre.name, 94, y);
    ctx.fillStyle = "rgba(255,255,255,.11)"; ctx.fillRect(490, y - 26, 500, 14); ctx.fillStyle = index === 0 ? "#ff314f" : "#9270ff"; ctx.fillRect(490, y - 26, Math.max(10, 500 * genre.share), 14);
    ctx.fillStyle = "#aaa6b2"; ctx.font = "22px 'DM Sans', sans-serif"; ctx.fillText(`${Math.round(genre.share * 100)}%`, 1020, y);
  });
  if (recap.topRatings.length) {
    ctx.fillStyle = "#f5f4ef"; ctx.font = "38px 'Bebas Neue', sans-serif"; ctx.fillText("ТВОИ ФАВОРИТЫ", 90, 1320);
    const truncate = (value, maxWidth) => {
      let title = String(value || "Фильм");
      if (ctx.measureText(title).width <= maxWidth) return title;
      while (title.length > 1 && ctx.measureText(`${title}…`).width > maxWidth) title = title.slice(0, -1);
      return `${title.trimEnd()}…`;
    };
    ctx.font = "25px 'DM Sans', sans-serif";
    recap.topRatings.slice(0, 3).forEach(({ score, item }, index) => {
      const y = 1365 + index * 42;
      ctx.fillStyle = index === 0 ? "#ffd45a" : "#d0cbd5";
      ctx.textAlign = "left";
      ctx.fillText(truncate(item?.title || item?.name || "Фильм", 840), 94, y, 840);
      ctx.textAlign = "right";
      ctx.fillStyle = "#ffd45a";
      ctx.fillText(`${score}/10`, 1104, y, 150);
    });
    ctx.textAlign = "left";
  } else {
    ctx.fillStyle = "#77727e"; ctx.font = "24px 'DM Sans', sans-serif"; ctx.fillText(recap.empty ? "В этом месяце ещё нет записанных просмотров" : "Оцени фильмы, чтобы собрать личный топ", 92, 1388);
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось подготовить изображение")), "image/png"));
}

export default function MonthlyRecapPage({ history = [] }) {
  const snapshot = useSyncExternalStore(subscribeViewingProfile, getViewingProfileSnapshot, getViewingProfileSnapshot);
  const [month, setMonth] = useState(currentMonth);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const data = useMemo(() => ({ ...(snapshot.data || {}), history }), [snapshot.data, history]);
  const months = useMemo(() => listRecapMonths(data), [data]);
  const recap = useMemo(() => buildMonthlyRecap(data, { month }), [data, month]);
  const maxDayMs = Math.max(1, ...recap.days.map((day) => day.watchMs));

  const exportCard = async (share) => {
    setExporting(true); setMessage("");
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const blob = await drawRecapCard(recap);
      const file = new File([blob], `streambert-${month}.png`, { type: "image/png" });
      if (share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Итоги · ${recap.label}`, text: "Мой киномесяц в Streambert" });
        setMessage("Карточка отправлена");
      } else {
        const url = URL.createObjectURL(blob); const link = document.createElement("a");
        link.href = url; link.download = file.name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("PNG сохранён на устройство");
      }
    } catch (error) { if (error?.name !== "AbortError") setMessage(error?.message || "Экспорт не удался"); }
    finally { setExporting(false); }
  };

  return <main className="personal-page recap-page">
    <header className="personal-page-head recap-head">
      <div><div className="personal-eyebrow">ТВОЙ МЕСЯЦ В КАДРАХ</div><h1>Киноитоги</h1><p>Небольшая история о том, что ты смотрел и что запомнилось.</p></div>
      <label className="recap-month">Месяц<select value={month} onChange={(event) => setMonth(event.target.value)}>{months.map((value) => <option value={value} key={value}>{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(new Date(`${value}-15T12:00:00`))}</option>)}</select></label>
    </header>
    <div className="recap-status" data-status={snapshot.status}><span className="recap-status-dot" />{snapshot.status === "ready" ? "Синхронизация включена" : snapshot.status === "offline" ? "Офлайн · локальная история доступна" : snapshot.status === "local" ? "Локально · синхронизация не включена" : snapshot.status === "error" ? "Синхронизация требует внимания" : "Личные данные обновляются"}</div>
    <section className="recap-story" aria-label={`Итоги за ${recap.label}`}>
      <div className="recap-story-orbit" aria-hidden="true" />
      <div className="recap-story-top"><span>STREAMBERT / {month.replace("-", " · ")}</span><span>01 — 04</span></div>
      <div className="recap-story-main"><span className="recap-kicker">ТВОЯ КИНОИСТОРИЯ</span><h2>{recap.persona}</h2><div className="recap-watch">{duration(recap.watchHours)}</div><p>реального времени просмотра</p></div>
      <div className="recap-stat-grid"><div><strong>{recap.completedMovies}</strong><span>фильмов завершено</span></div><div><strong>{recap.completedEpisodes}</strong><span>серий завершено</span></div><div><strong>{recap.activeTitles}</strong><span>историй включено</span></div></div>
      <div className="recap-filmstrip" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} />)}</div>
    </section>
    <section className="recap-grid">
      <article className="recap-panel recap-genres"><div className="recap-panel-heading"><div><span className="personal-eyebrow">САУНДТРЕК МЕСЯЦА</span><h2>Жанры в твоём ритме</h2></div><span className="recap-panel-index">02</span></div>
        {recap.genres.length ? <><div className="recap-genre-list">{recap.genres.slice(0, 6).map((genre, index) => <div className="recap-genre" key={genre.id}><div><span className={`recap-genre-rank rank-${index}`}>0{index + 1}</span><strong>{genre.name}</strong><span>{Math.round(genre.share * 100)}%</span></div><div className="recap-meter"><i style={{ width: `${Math.max(3, genre.share * 100)}%` }} /></div></div>)}</div>{recap.genreCoverage > 0 && recap.genreCoverage < 1 && <p className="recap-empty-note">Жанр известен для {Math.round(recap.genreCoverage * 100)}% времени просмотра.</p>}</> : <p className="recap-empty-note">Жанры появятся после первых просмотров.</p>}
      </article>
      <article className="recap-panel recap-ratings"><div className="recap-panel-heading"><div><span className="personal-eyebrow">ЛИЧНЫЙ ТОП</span><h2>Что зацепило</h2></div><span className="recap-panel-index">03</span></div>
        {recap.topRatings.length ? <ol className="recap-rating-list">{recap.topRatings.map(({ score, item }, index) => <li key={`${item?.type || item?.media_type}-${item?.id}-${index}`}><span className="recap-rating-number">{String(index + 1).padStart(2, "0")}</span><span className="recap-rating-title">{item?.title || item?.name || "Без названия"}<small>{item?.type === "tv" || item?.media_type === "tv" ? "Сериал" : "Фильм"}</small></span><strong>{score}<small>/10</small></strong></li>)}</ol> : <p className="recap-empty-note">Оцени фильм или сериал от 1 до 10 — здесь появятся твои фавориты.</p>}
      </article>
    </section>
    <section className="recap-activity"><div className="recap-panel-heading"><div><span className="personal-eyebrow">ПО ДНЯМ</span><h2>Ритм месяца</h2></div><span className="recap-panel-index">04</span></div><div className="recap-day-chart" role="img" aria-label="Время просмотра по дням месяца">{recap.days.map((day) => <div className={`recap-day${day.watchMs > 0 ? " has-watch" : ""}`} key={day.day} title={`${new Date(`${day.day}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}: ${duration(day.watchMs / 3600000)}`}><i style={{ height: `${day.watchMs ? Math.max(5, day.watchMs / maxDayMs * 100) : 3}%` }} /><span>{day.day.slice(-2)}</span></div>)}</div><div className="recap-chart-legend"><span><i/>Минуты реального просмотра</span><span>{recap.days.filter((day) => day.watchMs > 0).length} активных дней</span></div></section>
    <section className={`recap-coverage${recap.empty ? " is-empty" : ""}`}><div className="recap-coverage-mark">✳</div><div><strong>{recap.empty ? "История только начинается" : "Собрано из твоих просмотров"}</strong><p>{recap.coverage.legacyEntries ? `В библиотеке ещё ${recap.coverage.legacyEntries} старых записей. Статистика учитывает фактические просмотры с ${new Date(recap.coverage.trackedSince).toLocaleDateString("ru-RU")}; прежняя история не содержит точного времени просмотра.` : "Учитывается фактическое время воспроизведения. Старые записи без точного тайминга не превращаются в выдуманные часы."}</p></div></section>
    <footer className="recap-export"><div><strong>Забери этот месяц с собой</strong><span>{message || "Карточка готовится из твоих данных и остаётся на твоём устройстве."}</span></div><div><button className="btn btn-secondary" disabled={exporting} onClick={() => exportCard(false)}>{exporting ? "Готовим…" : "Скачать PNG"}</button><button className="btn btn-primary" disabled={exporting} onClick={() => exportCard(true)}>Поделиться</button></div></footer>
  </main>;
}
