// ── Home Page Layout Utilities ────────────────────────────────────────────────
// Shared between SettingsPage (editing) and HomePage (reading).

import { storage } from "./storage";

export const HOME_ROWS = [
  { id: "continue", label: "Продолжить просмотр" },
  { id: "recommended", label: "Recommended for You" },
  { id: "trendingMovies", label: "Trending Movies" },
  { id: "trendingTV", label: "Trending Series" },
  { id: "topRated", label: "Top Rated" },
];

const DEFAULT_ROW_ORDER = HOME_ROWS.map((r) => r.id);

function normalizeHomeOrder(order) {
  const knownIds = new Set(HOME_ROWS.map((row) => row.id));
  const savedIds = Array.isArray(order)
    ? [...new Set(order.filter((id) => knownIds.has(id)))]
    : [];
  const missingIds = DEFAULT_ROW_ORDER.filter((id) => !savedIds.includes(id));

  return savedIds.includes("continue")
    ? [...savedIds, ...missingIds]
    : ["continue", ...savedIds, ...missingIds.filter((id) => id !== "continue")];
}

export function loadHomeLayout() {
  const savedOrder = storage.get("homeRowOrder");
  const savedVisible = storage.get("homeRowVisible");
  const order = normalizeHomeOrder(savedOrder);
  const visible = Object.fromEntries(
    HOME_ROWS.map(({ id }) => [
      id,
      typeof savedVisible?.[id] === "boolean" ? savedVisible[id] : true,
    ]),
  );

  return { order, visible };
}

export function saveHomeLayout(order, visible) {
  const normalizedOrder = normalizeHomeOrder(order);
  const normalizedVisible = Object.fromEntries(
    HOME_ROWS.map(({ id }) => [
      id,
      typeof visible?.[id] === "boolean" ? visible[id] : true,
    ]),
  );
  storage.set("homeRowOrder", normalizedOrder);
  storage.set("homeRowVisible", normalizedVisible);
}

/** "carousel" (default) | "list" */
export function loadHomeViewMode() {
  return storage.get("homeViewMode") || "carousel";
}

export function saveHomeViewMode(mode) {
  storage.set("homeViewMode", mode);
}

export function loadStartPage() {
  return storage.get("startPage") || "home";
}
