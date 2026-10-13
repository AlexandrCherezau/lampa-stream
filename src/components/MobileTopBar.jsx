// Mobile-only slim top bar: Back + page title + Search + Settings.
// Hidden on desktop (CSS display:none unless ≤768px) where the left sidebar
// already has these. On phone the sidebar collapses to a bottom dock of nav
// tabs, so Back/Search/Settings need a reachable home — this is it. Settings
// in particular was stranded on mobile (hidden in .sidebar-bottom with no
// replacement).
import { memo, useEffect, useRef, useState } from "react";
import { BackIcon, DevicesIcon, MoreIcon, RecapIcon, SearchIcon, SettingsIcon, TonightIcon } from "./Icons";

const TITLES = {
  home: "Главная",
  discover: "Каталог",
  together: "Смотрим вместе",
  history: "Библиотека",
  downloads: "Загрузки",
  devices: "Устройства",
  recap: "Итоги месяца",
  tonight: "На вечер",
  settings: "Настройки",
};

const MORE_PAGES = [
  { page: "tonight", label: "На вечер", Icon: TonightIcon },
  { page: "recap", label: "Итоги месяца", Icon: RecapIcon },
  { page: "devices", label: "Устройства", Icon: DevicesIcon },
];

// memo: App re-renders on every playback progress tick; this bar is pure prop
// work and its props are stable callbacks, so the shallow compare bails out.
const MobileTopBar = memo(function MobileTopBar({ page, canGoBack, onBack, onSearch, onSettings, onNavigate }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const closeOutside = (event) => { if (!moreRef.current?.contains(event.target)) setMoreOpen(false); };
    const closeEscape = (event) => { if (event.key === "Escape") setMoreOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [moreOpen]);
  return (
    <div className="mobile-topbar">
      <button
        className="mobile-topbar-btn"
        onClick={onBack}
        disabled={!canGoBack}
        aria-label="Назад"
      >
        <BackIcon />
      </button>
      <div className="mobile-topbar-title">{TITLES[page] || ""}</div>
      <button className="mobile-topbar-btn" onClick={onSearch} aria-label="Поиск">
        <SearchIcon />
      </button>
      <div className="mobile-more" ref={moreRef}>
        <button className={`mobile-topbar-btn${moreOpen ? " is-open" : ""}`} onClick={() => setMoreOpen((open) => !open)} aria-label="Ещё разделы" aria-haspopup="menu" aria-expanded={moreOpen}>
          <MoreIcon />
        </button>
        {moreOpen && <div className="mobile-more-menu" role="menu" aria-label="Персональное кино">
          {MORE_PAGES.map(({ page: target, label, Icon }) => <button key={target} className={`mobile-more-item${page === target ? " active" : ""}`} role="menuitem" onClick={() => { setMoreOpen(false); onNavigate(target); }}>
            <Icon size={19} /><span>{label}</span>
          </button>)}
        </div>}
      </div>
      <button className="mobile-topbar-btn" onClick={onSettings} aria-label="Настройки">
        <SettingsIcon />
      </button>
    </div>
  );
});

export default MobileTopBar;
