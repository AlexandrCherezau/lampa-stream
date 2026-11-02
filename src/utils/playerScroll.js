// Where playing should scroll the player to. On a phone (same query as the phone
// layout in global.css) it is pinned under the top bar; on desktop it is centred.
const PHONE_LAYOUT = "(max-width: 768px), (max-width: 1024px) and (max-height: 500px) and (pointer: coarse)";

export const playerScrollBlock = () => (window.matchMedia(PHONE_LAYOUT).matches ? "start" : "center");
