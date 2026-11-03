// "When will I finish if I press play now?" — shown on the home page and on the
// movie page. The clock ticks by whole minutes so a page re-renders only when
// the displayed time can actually change.
import { useEffect, useState } from "react";

const wholeMinute = () => Math.floor(Date.now() / 60000) * 60000;

export function useMinuteClock() {
  const [now, setNow] = useState(wholeMinute);
  useEffect(() => {
    const timer = setInterval(() => setNow(wholeMinute()), 15000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export const clockAfter = (minutes, now = Date.now()) =>
  new Date(now + minutes * 60000).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

export function formatRuntime(minutes) {
  const total = Math.round(minutes);
  if (total < 60) return `${total} мин`;
  const rest = total % 60;
  return `${Math.floor(total / 60)} ч${rest ? ` ${rest} мин` : ""}`;
}

// Minutes left of a title, given its runtime and a watched percentage.
export const minutesLeft = (runtime, pct = 0) =>
  Math.max(1, Math.ceil(runtime * (1 - Math.min(pct, 100) / 100)));
