import { useState, useRef, useEffect, memo } from "react";
import { imgUrl } from "../utils/api";
import {
  StreambertLogo,
  HomeIcon,
  SearchIcon,
  HistoryIcon,
  FilmIcon,
  UsersIcon,
  SettingsIcon,
  DownloadsQueueIcon,
  DevicesIcon,
  RecapIcon,
  TonightIcon,
  QuitIcon,
  BackIcon,
  HelpIcon,
} from "./Icons";

// memo: App re-renders on every playback progress tick (5 s during a film) and
// on every download IPC event; the sidebar maps the whole saved list to poster
// <img>s and must not re-render with it. Props are stable (useCallback/useMemo
// in App), so the shallow compare bails out.
const Sidebar = memo(function Sidebar({
  page,
  onNavigate,
  onSearch,
  savedList,
  activeDownloads,
  onReorderSaved,
  onRemoveSaved,
  canGoBack,
  onBack,
  onShowShortcuts,
}) {
  const [dragOver, setDragOver] = useState(null);
  const dragItem = useRef(null);
  const dragNode = useRef(null);

  const [tooltip, setTooltip] = useState(null); // { title, y }
  const [contextMenu, setContextMenu] = useState(null); // { item, x, y }

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, []);

  const handleContextMenu = (e, item) => {
    e.preventDefault();
    e.stopPropagation();
    setTooltip(null);
    setContextMenu({ item, x: e.clientX, y: e.clientY });
  };

  const handleDragStart = (e, index) => {
    dragItem.current = index;
    dragNode.current = e.currentTarget;
    setTimeout(() => {
      if (dragNode.current) dragNode.current.style.opacity = "0.4";
    }, 0);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    if (dragNode.current) dragNode.current.style.opacity = "1";
    dragItem.current = null;
    dragNode.current = null;
    setDragOver(null);
  };

  const handleDragEnter = (e, index) => {
    if (dragItem.current === index) return;
    setDragOver(index);
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    const fromIndex = dragItem.current;
    if (fromIndex === null || fromIndex === dropIndex) return;

    const newList = [...savedList];
    const [moved] = newList.splice(fromIndex, 1);
    newList.splice(dropIndex, 0, moved);

    const newOrder = newList.map((item) => `${item.media_type}_${item.id}`);
    onReorderSaved(newOrder);
    setDragOver(null);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleMouseEnter = (e, title) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ title, y: rect.top + rect.height / 2 });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <div className="sidebar">
      <div
        className="sidebar-logo"
        onClick={() => onNavigate("home")}
        title="Streambert"
        style={{ position: "relative" }}
      >
        <StreambertLogo />
      </div>

      {canGoBack && (
        <SideBtn onClick={onBack} icon={<BackIcon />} label="Назад (Ctrl+Z)" className="sidebar-back" />
      )}

      <SideBtn onClick={onSearch} icon={<SearchIcon />} label="Поиск  (⌘F)" className="sidebar-search" />
      <SideBtn
        active={page === "home"}
        onClick={() => onNavigate("home")}
        icon={<HomeIcon />}
        label="Главная"
      />
      <SideBtn
        active={page === "discover"}
        onClick={() => onNavigate("discover")}
        icon={<FilmIcon />}
        label="Каталог"
      />
      <SideBtn
        active={page === "together"}
        onClick={() => onNavigate("together")}
        icon={<UsersIcon />}
        label="Смотрим вместе"
      />
      <SideBtn
        active={page === "history"}
        onClick={() => onNavigate("history")}
        icon={<HistoryIcon />}
        label="Библиотека и история"
      />
      <SideBtn
        active={page === "downloads"}
        onClick={() => onNavigate("downloads")}
        icon={<DownloadsQueueIcon />}
        label="Загрузки"
        badge={activeDownloads > 0 ? activeDownloads : null}
      />

      <div className="sidebar-sep sidebar-feature-sep" />
      <SideBtn className="sidebar-feature-nav" active={page === "tonight"} onClick={() => onNavigate("tonight")} icon={<TonightIcon />} label="На вечер" />
      <SideBtn className="sidebar-feature-nav" active={page === "recap"} onClick={() => onNavigate("recap")} icon={<RecapIcon />} label="Итоги месяца" />
      <SideBtn className="sidebar-feature-nav" active={page === "devices"} onClick={() => onNavigate("devices")} icon={<DevicesIcon />} label="Устройства" />

      <div className="sidebar-sep" />

      <div className="sidebar-saved">
        {savedList.map((item, index) => {
          const key = `${item.media_type}_${item.id}`;
          const title = item.title || item.name;
          return (
            <div
              key={key}
              className={`saved-thumb${dragOver === index ? " drag-over" : ""}`}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={handleDragEnd}
              onDragEnter={(e) => handleDragEnter(e, index)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
              onClick={() =>
                onNavigate(item.media_type === "tv" ? "tv" : "movie", item)
              }
              onContextMenu={(e) => handleContextMenu(e, item)}
              onMouseEnter={(e) => handleMouseEnter(e, title)}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: "grab", position: "relative" }}
            >
              {item.poster_path ? (
                <img src={imgUrl(item.poster_path, "w92")} alt={title} loading="lazy" />
              ) : (
                <div className="no-img">
                  <FilmIcon />
                </div>
              )}
              {dragOver === index && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 3,
                    background: "var(--accent, #e50914)",
                    borderRadius: 2,
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {tooltip && (
        <div className="saved-thumb-tooltip" style={{ top: tooltip.y }}>
          {tooltip.title}
        </div>
      )}

      {contextMenu && (
        <div
          className="sidebar-context-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 9999,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="sidebar-context-menu-item"
            onClick={() => {
              onRemoveSaved && onRemoveSaved(contextMenu.item);
              setContextMenu(null);
            }}
          >
            Remove
          </div>
        </div>
      )}

      <div className="sidebar-bottom">
        <SideBtn
          onClick={onShowShortcuts}
          icon={<HelpIcon />}
          label="Помощь и сочетания клавиш (?)"
        />
        <SideBtn
          active={page === "settings"}
          onClick={() => onNavigate("settings")}
          icon={<SettingsIcon />}
          label="Настройки"
        />
        <button
          className="sidebar-btn"
          onClick={() => window.electron?.quitApp?.()}
          title="Выйти из приложения"
          style={{ color: "#e53e3e", marginTop: 4 }}
        >
          <QuitIcon />
          <span className="tooltip">Выйти из приложения</span>
        </button>
      </div>
    </div>
  );
});

function SideBtn({ active, onClick, icon, label, badge, className = "" }) {
  return (
    <button
      className={`sidebar-btn ${active ? "active" : ""} ${className}`}
      onClick={onClick}
      style={{ position: "relative" }}
    >
      {icon}
      <span className="tooltip">{label}</span>
      {badge && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            background: "var(--red)",
            color: "white",
            fontSize: 10,
            fontWeight: 700,
            lineHeight: "16px",
            textAlign: "center",
            padding: "0 4px",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export default Sidebar;
