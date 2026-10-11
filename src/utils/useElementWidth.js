import { useLayoutEffect, useRef, useState } from "react";

// Measure the CSS width of a box so an image inside it can request the TMDB rung
// that actually fits (see posterSize/stillSize in utils/api.js).
//
// Measuring beats mirroring the CSS in JS: card slots come from
// `repeat(auto-fill, minmax(150px, 1fr))` — a genuinely fluid number that also
// shifts with `body.compact-mode` and four mobile breakpoints — and a stale copy
// of those rules would silently start requesting the wrong size.
//
// One ResizeObserver is shared by every consumer. A grid can hold 50+ cards and
// per-instance observers would mean 50+ observer objects, each with its own
// callback the browser has to schedule; one observer watching 50 elements
// delivers them in a single batched callback instead.
const subs = new WeakMap(); // element → setWidth
let ro = null;

function observe(el, cb) {
  if (typeof ResizeObserver === "undefined") return () => {};
  if (!ro) {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const fn = subs.get(entry.target);
        if (!fn) continue;
        const w = Math.round(
          entry.contentRect ? entry.contentRect.width : entry.target.clientWidth,
        );
        // Ignore a collapse to 0 (element detached or in a hidden subtree) so we
        // keep serving the last good size instead of dropping to the fallback.
        if (w > 0) fn(w);
      }
    });
  }
  subs.set(el, cb);
  ro.observe(el);
  return () => {
    subs.delete(el);
    ro.observe && ro.unobserve(el);
  };
}

export default function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  // F7 fix (series lag): a layout effect, not a plain effect, because React
  // flushes the state update it schedules before the browser paints. The old
  // code also did `const w = el.clientWidth; if (w > 0) setWidth(w);` here, which
  // for a 24-episode season grid means 24 layout-effect reads + 24 setWidth
  // calls + a second reconciliation before paint — visible as the "series page
  // hitches when first opened" symptom. The synchronous read was redundant:
  // the shared ResizeObserver below fires its first callback synchronously
  // after observe(), inside the same frame, with the same value. We drop the
  // read entirely and let the observer catch the initial size on its first
  // tick. Trade-off: a one-frame window where the very first paint could show
  // the fallback-size src before the observer callback lands. Browsers don't
  // paint the image before the request returns, so a re-render that picks the
  // right size before the image decodes swaps the src cleanly — no flash.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, setWidth);
  }, []);

  return [ref, width];
}
