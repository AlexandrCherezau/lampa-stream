# Habster catalog and playback

The inspected [kinopoisk-free userscript](https://github.com/murckich/kinopoisk-free/blob/8562b04c6f1d82cc213de791632b9208bbd99733/kinopoisk-free.user.js#L61-L72) replaces the Kinopoisk domain with one of six mirrors while preserving the film/series ID. It does not contain a video catalog or a direct stream resolver. Its default mirror is Habster. The upstream code is Apache-2.0; no userscript code or external scripts were copied into this application.

Habster's current homepage reads `/popular.php`; metadata comes from `/getinfo.php?kp_id=<id>`, search from `/search.php?q=<query>`, and related titles from `/film_parts.php?kp_id=<id>`. The integration adds the popular collection only. Its API permits fixed HTTPS paths, at most 20 cards and four concurrent metadata requests, bounds responses to 1 MiB, cancels disconnected requests and enforces a 20-second deadline. It validates KP IDs, IMDb IDs and movie/TV type rather than returning arbitrary upstream fields or URLs.

The browser reuses the existing catalog row and TMDB credential. Each card maps by exact IMDb ID to one result in the correct movie/TV bucket. Missing or ambiguous matches are omitted with a partial-collection notice. KP IDs never become TMDB IDs. Successful complete upstream responses may be cached for five minutes; partial upstream failures and request failures are refreshed. A 30-second deadline covers queued TMDB mapping too. Habster provenance survives selection, history, saved items and reload.

`source-host/providers/habster.mjs` reads the matching `/film/<KP>` or `/series/<KP>` page and extracts the current Collaps embed from data literals without executing JavaScript. It accepts only the evidenced `https://api.initem.ws/embed/kp/<KP>` origin/path, refreshes on resolve and requires exact TV season/episode coordinates. Media and subtitles use the existing signed, public-only transport and direct Node delivery; no native-engine private-network or credential privileges are granted to this provider.

The current pages also offer Alloha, Turbo, GetClit, optional Kodik and TurkPlayer. Those providers were not added without a verified direct playback path. One `Habster · Collaps` candidate exposes HLS auto quality and the manifest's audio tracks; separate duplicate voice candidates are not fabricated. The embed's validated audio names pass through resolve to the existing audio menu, replacing opaque labels such as `rus0`; labels clear on a new source and restore on a failed manual-switch rollback.

## Verification

- Source-host: 49 tests passed, including public-only delivery, sealed references after restart, engine bypass and exact TV coordinates.
- Habster/CUB browser fixtures: 9 passed; Habster's final client change additionally passed its four browser fixtures. Build, existing player checks and SSE gateway checks passed.
- API and client self-checks cover normalization, fixed routes, concurrency, response limits, deadlines, cancellation, exact IDs, cache scope and partial-response retries.
- Audio-name forwarding passed a RED-to-GREEN client regression and an existing decoded-playback/manual-switch rollback browser test.
- Live API check: 200 in 1.171 seconds; 14 popular entries yielded 11 validated IMDb/KP cards, with three omitted.
- Live adapter checks: KP 328 returned HLS/master/child/MPEG-TS segment with 200 and a 228-minute playlist. KP 5494049 returned the matching Spider-Man title and a 145-minute playlist. KP 464963 returned season 1, episode 1; exact episode references also passed fixture tests.

## Production verification

Both production deployments reached READY at commit `f444c1f18f6788c1dde5113c4549cb1a3ace371f`:

- Frontend `dpl_BrN4mPWeXaxC5oyJHTQMobgeeZyY`: https://lampa-stream-six.vercel.app.
- Backend `dpl_8Yy4hBejwU7mYHks6g96ksGS3vLm`: https://lampa-source-host.vercel.app.

The public browser selected Spider-Man: Brand New Day from the real Habster popular collection (KP 5494049 / IMDb tt22084616 / matching TMDB 969681). Default Habster Collaps playback started in 3.905 seconds and decoded 29 frames at 1280×720, readyState 4, with a 8700.629-second duration. Seeking to 60 seconds decoded 134 frames on the same source. The audio menu exposed seven studio/language labels. Selecting Red Head Sound fetched its actual audio playlist and segment with 200; playback reached 63 seconds and 207 frames without a media error, and decoded audio bytes increased from 21,186 to 59,028. This is one observed startup time, not a speed guarantee.

See `habster-production-verification-2026-10-13.json`. Catalog, source discovery, resolve, video, subtitles and audio delivery were real public requests. Matching TMDB IMDb mapping/details/posters were fixtures for this one title; other TMDB mappings returned empty. The test used an existing client-session flag. Login and real credential-backed TMDB mapping were not tested. Whole-film playback, every catalog entry, every audio track/quality and Habster search are outside this verification scope. External embed domains and CDN availability can change.
