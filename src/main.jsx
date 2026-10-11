import React from "react";
import ReactDOM from "react-dom/client";
// Web shim: defines window.electron via fetch() when running outside Electron
// (in Electron, preload.js already set it, so the shim no-ops). Imported before
// App so App's secureGet/tmdbProxyGet calls resolve to the web API.
import "./web/shim";
import { ensureSiteGate } from "./web/gate";
import App from "./App";
import "./styles/global.css";

// Web only: gate on the site password before mounting the app. On desktop this
// resolves immediately (no VITE_SITE_PWD_HASH → no gate).
ensureSiteGate().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});

// ── Service worker (web production builds only) ──────────────────────────────
// Cached shell + hashed assets + stale-while-revalidate TMDB metadata: repeat
// visits paint before the network answers. Never registered in dev (it would
// serve stale modules) or in Electron (the app already ships local assets, and
// __webShim is the marker the shim sets for browser builds).
if (import.meta.env.PROD && window.__webShim && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW is a progressive enhancement — ignore failures (private mode etc.) */
    });
  });
}
