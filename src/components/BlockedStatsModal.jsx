import { useEffect } from "react";
import { CloseIcon, ShieldBlockIcon } from "./Icons";

/**
 * Modal showing which ad/tracker domains were blocked during the current session
 * and the all-time total blocked count.
 */
export default function BlockedStatsModal({
  sessionDomains,
  sessionTotal,
  alltimeTotal,
  onClose,
}) {
  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="blocked-modal-overlay" onClick={onClose}>
      <div className="blocked-modal" onClick={(e) => e.stopPropagation()}>
        <div className="blocked-modal-header">
          <div className="blocked-modal-title">
            <ShieldBlockIcon size={15} />
            Заблокированная реклама и трекеры
          </div>
          <button
            className="blocked-modal-close"
            onClick={onClose}
            title="Закрыть"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="blocked-modal-subtitle">
          {sessionTotal > 0
            ? `За этот сеанс заблокировано запросов рекламы и трекеров: ${sessionTotal}`
            : "Запустите просмотр, чтобы увидеть заблокированную рекламу и трекеры."}
        </div>

        <div className="blocked-modal-list">
          {sessionDomains.length === 0 ? (
            <div className="blocked-modal-empty">
              Пока ничего не заблокировано. Запустите просмотр, чтобы начать.
            </div>
          ) : (
            sessionDomains.map(([domain, count]) => (
              <div key={domain} className="blocked-modal-row">
                <span className="blocked-modal-domain">{domain}</span>
                <span className="blocked-modal-count">
                  {count.toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="blocked-modal-footer">
          <ShieldBlockIcon size={13} />
          Всего:&nbsp;
          <strong>
            {alltimeTotal.toLocaleString()} запросов рекламы и трекеров
          </strong>
          &nbsp;заблокировано
        </div>
      </div>
    </div>
  );
}
