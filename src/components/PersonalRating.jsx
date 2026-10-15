import { useSyncExternalStore } from "react";
import { getPersonalRating, setPersonalRating, subscribeViewingProfile, getViewingProfileSnapshot } from "../utils/viewingProfile";

export default function PersonalRating({ item }) {
  const snapshot = useSyncExternalStore(subscribeViewingProfile, getViewingProfileSnapshot, getViewingProfileSnapshot);
  const key = `${item?.media_type === "tv" ? "tv" : "movie"}_${item?.id}`;
  const rating = getPersonalRating(item);
  const selected = rating?.score ?? null;
  if (!item?.id) return null;
  return (
    <section className="personal-rating" aria-label="Моя оценка">
      <div className="personal-rating-copy">
        <span className="personal-rating-kicker">Моя оценка</span>
        <strong>{selected ? `${selected} / 10` : "Оцени для своих итогов"}</strong>
        <small>{snapshot.status === "offline" ? "Сохранится на этом устройстве и синхронизируется позже" : "Личная оценка видна только в твоих итогах"}</small>
      </div>
      <div className="personal-rating-actions">
        <div className="personal-rating-scale" role="group" aria-label="Оценка от 1 до 10">
          {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
            <button key={`${key}-${score}`} type="button" aria-pressed={selected === score} aria-label={`${score} из 10`} className={selected >= score ? "is-selected" : ""} onClick={() => setPersonalRating(item, score)}>{score}</button>
          ))}
        </div>
        {selected != null && <button type="button" className="personal-rating-clear" onClick={() => setPersonalRating(item, null)}>Убрать оценку</button>}
      </div>
    </section>
  );
}
