// A titled horizontal row of cards. Native scrolling (and swipe on a phone), with
// arrows for a mouse. `ranked` draws the big outlined place numbers.
import { Children, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons";

export default function PosterRow({ title, wide = false, ranked = false, controls = null, children }) {
  const trackRef = useRef(null);
  const [ends, setEnds] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const start = track.scrollLeft < 4;
    const end = track.scrollLeft + track.clientWidth > track.scrollWidth - 4;
    setEnds((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [measure, children]);

  const scroll = (direction) => {
    const track = trackRef.current;
    track?.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section className={`poster-row${wide ? " poster-row--wide" : ""}${ranked ? " poster-row--ranked" : ""}`} aria-label={title}>
      <div className="poster-row__head">
        <h2 className="section-title">{title}</h2>
        {controls}
        <div className="poster-row__arrows">
          <button type="button" className="poster-row__arrow" aria-label={`${title}: назад`} disabled={ends.start} onClick={() => scroll(-1)}><ChevronLeftIcon /></button>
          <button type="button" className="poster-row__arrow" aria-label={`${title}: дальше`} disabled={ends.end} onClick={() => scroll(1)}><ChevronRightIcon /></button>
        </div>
      </div>
      <div className="poster-row__track" ref={trackRef} onScroll={measure}>
        {Children.map(children, (child, index) => (
          <div className="poster-row__slot">
            {ranked && index < 10 && <span className="poster-row__rank" aria-hidden="true">{index + 1}</span>}
            {child}
          </div>
        ))}
      </div>
    </section>
  );
}
