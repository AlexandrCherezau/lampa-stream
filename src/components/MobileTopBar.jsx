// Mobile-only slim top bar: Back + page title + Search + Settings.
// Hidden on desktop (CSS display:none unless ≤768px) where the left sidebar
// already has these. On phone the sidebar collapses to a bottom dock of nav
// tabs, so Back/Search/Settings need a reachable home — this is it. Settings
// in particular was stranded on mobile (hidden in .sidebar-bottom with no
// replacement).
import { memo } from "react";
import { BackIcon, SearchIcon, SettingsIcon } from "./Icons";

const TITLES = {
  home: "Главная",
  discover: "Каталог",
  together: "Смотрим вместе",
  history: "Библиотека",
  downloads: "Загрузки",
  settings: "Настройки",
};

// memo: App re-renders on every playback progress tick; this bar is pure prop
// work and its props are stable callbacks, so the shallow compare bails out.
const MobileTopBar = memo(function MobileTopBar({ page, canGoBack, onBack, onSearch, onSettings }) {
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
      <button className="mobile-topbar-btn" onClick={onSettings} aria-label="Настройки">
        <SettingsIcon />
      </button>
    </div>
  );
});

export default MobileTopBar;
