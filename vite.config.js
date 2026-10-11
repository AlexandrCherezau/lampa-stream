import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isDist = process.env.ELECTRON_DIST === "1";
  return {
    plugins: [react()],
    // base="./" для Electron (относительные пути работают в file://); base="/"
    // для Vercel/web — иначе ассеты резолвятся в /movie/.../assets/... при прямом
    // URL фильма, и SPA-роуты отдают HTML вместо JS, и экран белый.
    base: isDist ? "./" : "/",
    // Use the FULL hls.js build (not hls.light). Collaps HLS streams carry the
    // Russian dubs as alternate audio renditions (#EXT-X-MEDIA AUDIO groups), and
    // hls.light does NOT include alternate-audio support — so the light build
    // played video-only (no Russian dub) for any content that falls back to HLS
    // (e.g. movies for which Collaps no longer ships a DASH URL). The full build
    // is larger, but it's a dynamically-imported chunk (loaded only when HLS is
    // actually used) and is what makes the Russian dubs work on the HLS path.
    resolve: {
      alias: {
        "hls.js": "hls.js/dist/hls.mjs",
      },
    },
    build: {
      minify: "terser",
      terserOptions: {
        compress: {
          // Strip logging from every production bundle, web included. The web
          // build used to keep console.* (isDist was only true for Electron),
          // which shipped dead string payloads and made the player log on every
          // segment. Keep console.error/warn so real failures stay diagnosable.
          drop_console: ["log", "info", "debug", "trace"],
          drop_debugger: true,
          pure_funcs: isDist ? ["console.error", "console.warn"] : [],
        },
      },
      rollupOptions: {
        output: {
          // Only react is chunked manually. The pages are all reached through
          // lazy(() => import(...)) in App.jsx, so Rollup already emits one
          // chunk per page from the dynamic-import boundary. Listing them here
          // as well used to make the ENTRY chunk statically import the movie and
          // settings chunks (they had become the home of shared modules), so the
          // built index.html eagerly modulepreloaded ~256 KB of movie/settings
          // JS on first paint — code the home page never runs.
          manualChunks: {
            react: ["react", "react-dom"],
          },
        },
      },
    },
  };
});
