import { useState, useEffect, useRef, useCallback } from "react";

// The hook itself — one instance per consumer component (NOT inside a map or a
// conditional: the hook count must be stable across renders). Prefer the
// <ProgressiveGrid> wrapper below, which owns a stable instance per list.
export function useProgressiveList(total, step = 24) {
  const [count, setCount] = useState(() => Math.min(step, total));
  const sentinelRef = useRef(null);

  // A new/shorter list starts small again.
  useEffect(() => {
    setCount((c) => Math.min(step, total));
  }, [total, step]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || count >= total) return;
    if (typeof IntersectionObserver === "undefined") {
      setCount(total); // no IO (very old browser) — just show everything
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setCount((c) => Math.min(total, c + step));
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [count, total, step]);

  const reset = useCallback(() => setCount(Math.min(step, total)), [step, total]);
  return { count, sentinelRef, reset };
}

// A cards-grid that mounts `step` items at a time and reveals more as the
// viewer scrolls. The hook lives in this component, so each grid owns exactly
// one stable instance no matter how the parent re-renders.
//
//   <ProgressiveGrid items={items} step={24} className="cards-grid">
//     {(visible) => visible.map(renderCard)}
//   </ProgressiveGrid>
export default function ProgressiveGrid({ items, step = 24, className = "cards-grid", children }) {
  const { count, sentinelRef } = useProgressiveList(items.length, step);
  const visible = items.slice(0, count);
  return (
    <div className={className}>
      {children(visible)}
      <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
    </div>
  );
}
