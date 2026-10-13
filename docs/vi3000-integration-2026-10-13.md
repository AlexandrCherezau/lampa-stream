# CUB / vi3000 integration

The home page now includes the four public CUB collections used by vi3000: currently watched, latest, popular and top movies. Each collection has independent pagination and retry. Existing home collections remain available.

`api/cub.js` requests only four fixed routes on `https://tmdb.cub.best`, validates pages and JSON responses, limits the response body and cancels disconnected or timed-out requests. The browser caches successful pages for five minutes. Cards retain their TMDB ID and movie/TV type; the CUB catalog flag and validated Kinopoisk/IMDb IDs survive selection, bookmarks, history and reload. Pagination preserves CUB's own page count rather than applying TMDB's 500-page limit.

`source-host/providers/vi3000.mjs` reads the anonymous Filmix endpoint and the public vi3000 host registry, then reuses the existing Lampac parser and discovery scheduler. HTML responses are parsed only for structured `data-json`; remote scripts are never executed. The adapter excludes torrent and disabled providers. It supplies separate `vi3000:` source identities and uses the remote plane without waiting for the local Lampac engine. CDNVideoHub is prioritized among registry fallbacks so unavailable providers cannot occupy every discovery slot before it; Filmix remains first and manual source choices remain available.

All vi3000 requests and signed media resources carry `publicOnly`. The transport validates and pins public DNS destinations on every redirect; remote sources cannot inherit the native engine's private-network allowance, credentials, browser preparation or AES unwrapping. The flag survives HLS playlists, keys, segments and subtitle links. Old native sources retain their existing transport behavior.

The signed vi3000 provider namespace retains the existing direct-Node delivery policy for CDNVideoHub, ZetflixDB and movie Zetflix. vi3000 Filmix files also use direct Node delivery; native Filmix and vi3000 HLS delivery retain their existing routing. Client request fields cannot change that policy. Progressive MP4 startup uses the existing bounded 14-second watchdog budget because a real Filmix file required about nine seconds for metadata; HLS keeps its seven-second watchdog and playback already in progress remains protected from startup failover.

The shared discovery gateway marks SSE as `no-store, no-transform`, preventing compression middleware and intermediaries from buffering small discovery events until the search finishes. A real Express/compression regression delivers the first candidate while the upstream is still open, with ordinary JSON caching headers unchanged.

No new application dependencies or subscriptions were added. The public catalog and selected media were accessed anonymously. Movie/TV details still use the application's existing TMDB setup; anonymous vi3000 detail endpoints returned authentication errors and were not treated as a working substitute.

## Validation

- Source-host suite: 43 passing tests, including namespace routing, public-only transport, redirects, signed media inheritance and CDNVideoHub discovery while other provider slots are occupied.
- CUB and smoke browser tests: 13 passing tests, including pagination, retries, mixed movie/TV IDs, provenance persistence and invalid metadata rejection. Full player browser suite: 11 passing tests. Vite build and `scripts/check-player.mjs` passed.
- `scripts/check-cub.mjs` checks fixed routes, normalization, deadlines/body limits, cancellation and cache behavior.
- `scripts/check-source-host-gateway.mjs` checks immediate SSE delivery under compression; three targeted player tests check delayed healthy MP4, bounded MP4 failover and the unchanged HLS deadline.
- Live anonymous HTTP checks returned 20 cards on pages 1 and 2 of all four collections.
- After both startup fixes, the actual application at `http://127.0.0.1:19130` opened CUB movie TMDB 120 / KP 328 / IMDb tt0120737 and played Filmix 720p in 11.102 seconds. It decoded 27 frames at startup and 75 after seeking to 60 seconds, with readyState 4. Only matching TMDB details and posters were fixtures; catalog, discovery, resolve and video delivery were live. See `vi3000-live-verification-2026-10-13.json`.
- Isolated Chromium checks decoded Filmix 720p in 9.301 seconds and CDNVideoHub HLS in 0.622 seconds. See `vi3000-startup-diagnostics-2026-10-13.json`. These are single observations, not speed guarantees.

## Limits

The initial full application run took 66.419 seconds and fell back to CDNVideoHub. A later actual-player trace showed buffered discovery events arriving together at 32.946 seconds and the seven-second watchdog switching away from Filmix before its first frame at 41.961 seconds. Filmix and CDNVideoHub exposed different durations; their editions were not visually compared. A decoded start and one seek do not prove uninterrupted playback, every quality, every voice or the whole catalog.

## Production publication

Both production deployments reached READY with their canonical aliases:

- Frontend: `dpl_FRzS95jkBw1zYptYVyodUhfwrr8Q`, commit `68a737a69cea834a6467e643d700ff81c65e13ca`, https://lampa-stream-six.vercel.app.
- Source backend: `dpl_71zEQUsJzhN8oHyaeot5TgkQ1V2b`, commit `d83ce6f8071f45702a9273762bbe97a855e24378`, https://lampa-source-host.vercel.app.

The first backend attempt failed because the existing `sources` registry repository had reached its image limit; changing the service and matching rewrite to `sources-cub` allowed publication in the same project. Old images and deployments were preserved, with no plan changes or subscriptions added.

The final public browser check selected movie TMDB 120 / KP 328 from the real CUB popular collection and clicked Watch. It decoded CDNVideoHub HLS in 14.105 seconds, with 27 frames, readyState 4 and dimensions 1920×804. Seeking to 60 seconds decoded new frames on the same video source and provider, reaching 31 frames and readyState 4. HLS auto quality adapted to 1280×536 after seeking. Public backend playlists and video segments returned 200. The earlier production check validated pages 1 and 2 of all four collections; the final focused check repeated only popular page 1. See `vi3000-production-verification-2026-10-13.json` for exact scope and retained earlier evidence.

Filmix's external file CDN returned 429 in production, surfaced as a generic Node 502 or earlier relay 429. Direct Node routing did not restore its availability. A temporary 32 MiB open-ended range experiment also failed and was reverted; the published backend retains the original 8 MiB default. The final GREEN claim proves real default vi3000 playback and a same-source seek through CDNVideoHub, not Filmix availability. Matching TMDB details and posters were fixtures and an existing client session was used; login, uninterrupted whole-film playback, other titles, every voice and every quality were not tested.
