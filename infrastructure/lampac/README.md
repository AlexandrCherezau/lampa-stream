# Lampac source host

Source host is an independent Node API plus Lampac NextGen `1.81.0` and hidden Chromium. The Vercel deployment runs them together in a custom container; Lampac and Chrome DevTools Protocol listen only on loopback. The container image has already been built remotely with the provider-module cache prewarmed. At runtime that cache and browser profile are copied to ephemeral storage, so restarts can require a fresh browser session.

The production source host is `https://lampa-source-host.vercel.app` (READY deployment `dpl_8spgCHP2jHu7xABfaNDKLTD4YtG2`); its Cloudflare media Worker is `https://lampa-source-media.ocr-gemini-proxy.workers.dev`. The frontend is READY at `dpl_7FUZhCKsUnNGKAvPwj6iMX5E2ybd`. The project also includes a local Docker Compose setup. From the repository root:

```sh
./infrastructure/lampac/setup.sh
cd infrastructure/lampac
SOURCE_PUBLIC_ORIGIN=https://sources.example.com SOURCE_API_KEY='<same private key as the site gateway>' docker compose up -d
curl -fsS 'http://127.0.0.1:9120/healthz'
```

Setup creates random Lampac passwords and an HMAC secret only when their files do not exist, stores them under `infrastructure/lampac/data/` with mode `0600`, and does not overwrite them on later runs. Those files are excluded from git. Run setup as the deployment user (UID `1000`, matching the image's Node process). Lampac and CDP have no host ports; only the Node API is published on loopback. Put HTTPS in front of it, for example:

```caddy
sources.example.com {
  reverse_proxy 127.0.0.1:9120
}
```

## Vercel container

The source-host project uses `infrastructure/lampac/vercel.json` and `Dockerfile.vercel`. The service config routes requests to the `sources` container service. Vercel's project setting **Settings → Functions → Default Regions** must also select Frankfurt (`fra1`); setting `regions` in `vercel.json` alone did not move the container. Keep this project and domain separate from the frontend project.

Set these server-side project environment values:

```text
SOURCE_HOST_SECRET=<persistent random string, at least 32 bytes>
SOURCE_API_KEY=<private key shared with the site gateway>
SOURCE_PUBLIC_ORIGIN=https://<source-host-domain>
```

Use the same `SOURCE_HOST_SECRET` and `SOURCE_API_KEY` across all instances and redeployments. The startup script derives the Lampac AES key from the host secret; do not configure a separate key or expose either secret in browser code. On the frontend server, set `SOURCE_HOST_URL` to the source-host HTTPS origin and `SOURCE_API_KEY` to the same private key. The client receives only opaque, signed candidate and media identifiers; Lampac's internal URLs remain private.

The Node API starts before the engine. Metadata requests trigger Lampac and its hidden browser, with a bounded readiness wait; media-only requests can run without starting them. `/healthz` only confirms Node is responding. Check Lampac readiness and real media playback separately. Vercel may scale idle containers to zero, so the first search after a cold start can take longer.

## Optional Cloudflare media relay

Direct binary streams sent by Vercel can hit its response-size limit. The optional Worker in `workers-api/source-media-worker.mjs` streams direct CDN files without routing their bytes through the Vercel response. It obtains the validated target via `GET /v1/media-route?token=...` using `Authorization: Bearer <SOURCE_API_KEY>`. For resources that still need Lampac, it calls `GET /v1/media?token=...` with `x-source-relay-key: <SOURCE_API_KEY>`; configure `SOURCE_MEDIA_RELAY_URL` in the source-host project to the Worker URL to enable this private relay path.

The Worker accepts an opaque token, never a caller-supplied upstream URL. Keep `SOURCE_HOST_URL` and `SOURCE_API_KEY` private in Worker settings. Redirected direct downloads fall back through Node's validated transport so DNS checks and cross-origin header handling remain in force. A large binary that redirects may therefore still traverse Vercel.

The Worker is deployed at `https://lampa-source-media.ocr-gemini-proxy.workers.dev` and connected to the Vercel source host. The frontend production deployment uses the new source host; its existing Collaps source remains available as an explicit fallback. No Cloudflare Workers Paid plan has been purchased. The Worker uses the free plan, whose published limits are 10 ms CPU per request and 100,000 requests per day; usage above those limits may require a paid plan ([official limits](https://developers.cloudflare.com/workers/platform/limits/)).

The checked-in config is `workers-api/source-media.wrangler.toml`. From the repository root, deploy it and set the key without putting its value in shell history:

```sh
npx wrangler deploy --config workers-api/source-media.wrangler.toml
npx wrangler secret put SOURCE_API_KEY --config workers-api/source-media.wrangler.toml
```

Paste the value when Wrangler prompts. The Worker also needs `SOURCE_HOST_URL` set to the source host origin in its vars. In the source-host Vercel project, set `SOURCE_MEDIA_RELAY_URL` to the Worker URL; set the same private `SOURCE_API_KEY` in both environments. Never expose the key in frontend variables. The current public Worker endpoint is `https://lampa-source-media.ocr-gemini-proxy.workers.dev`.

## Проверенное состояние источников

Для Fight Club/Vibix 1080p и BB/Vibix подтверждены декодирование FFmpeg и seek на 60-й секунде; BB/Vibix также прошёл браузерные проверки кадра и меню. Скрытые браузерные проверки декодировали кадры BB S1E1 и Haikyuu S1E14/S3E1; AniSkip вернул тайминги, кнопку «Пропустить опенинг» на S3E1 удалось нажать. Таймаут на 90-й секунде относится только к BB-кандидату ZetflixDB, а не к BB/Vibix. TMDB использовал test fixtures, без реального API-токена. Актуально прошли source-host 22/22, Worker 8/8 и Playwright 13/13 (43 всего), client assertions и build. Изолированная публикационная копия отдельно прошла 22/22.

ZetflixDB для фильма свежо разрешается и возвращает HLS, но сегмент через Worker завершается 502 из-за upstream 5xx. Кандидат BB/ZetflixDB также завершился таймаутом на 90-й секунде; это не относится к проверенному BB/Vibix. Адаптер перед запросом обновляет точные выбранные озвучку и серию и не использует просроченный снимок. Zetflix недоступен из-за неразрешимого upstream-хоста. Добавлена узкая finite-VOD защита: источник отбрасывается, если заявленная длительность меньше половины ожидаемой. Для Fight Club (TMDB fixture id 550, 139 минут; без реального API token) backend передал `runtimeMinutes=139`; исходный VeoVeo после отказа ZetflixDB дал поток 8349 секунд, 17 декодированных кадров и успешный seek на 60-й секунде с новыми кадрами. Это подтверждает этот фильм и кандидат, но не защиту для неизвестной длительности и live/direct потоков. Повторная проверка S3E1 после последнего развёртывания также прошла: AniMedia, 1470 секунд, декодированные кадры и кнопка пропуска опенинга.

Для локальной проверки конфигурации запустите `node scripts/check-lampac-infrastructure.mjs`. Она проверяет allowlist модулей, JSON, закреплённые образы и закрытые порты Lampac/CDP; она не запускает Docker и не подтверждает воспроизведение. Полный план текущих проверок находится в [source-host plan](../../docs/source-host-plan.md).
