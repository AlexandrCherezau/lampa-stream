# Lampac source host

Source host is an independent Node API plus Lampac NextGen `1.81.0` and hidden Chromium. The Vercel deployment runs them together in a custom container; Lampac and Chrome DevTools Protocol listen only on loopback. The container image has already been built remotely with the provider-module cache prewarmed. At runtime that cache and browser profile are copied to ephemeral storage, so restarts can require a fresh browser session.

The production source host is `https://lampa-source-host.vercel.app` (READY deployment `dpl_4zUWJ6XPj2veu7NJgHmFY9oNZk5v`); its Cloudflare media Worker is `https://lampa-source-media.ocr-gemini-proxy.workers.dev`. The frontend is READY at `dpl_8fSyqBLRy66LfA1agDxyTVvK5At3`. The project also includes a local Docker Compose setup. From the repository root:

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

Ранее для Fight Club/Vibix 1080p и BB/Vibix подтверждены декодирование FFmpeg и seek на 60-й секунде; BB/Vibix также прошёл браузерные проверки кадра и меню. Haikyuu S1E14 прошёл воспроизведение и seek в скрытом браузере. После обновления клиента правильный S3E1 прошёл облачное воспроизведение через Kodik/AniLibria.TV 720p, seek и ручной пропуск опенинга; Filmix остаётся непроверенным. TMDB использовал test fixtures, без реального API-токена. После последних изменений прошли source-host 23/23 в рабочей и публикационной копиях, client assertions и `git diff --check`. После исправления автовыбора заново прошли Playwright 14/14, client assertions, проверка синтаксиса и build. Worker 8/8 проходил раньше; Worker в последнем деплое не менялся.

Свежий ZetflixDB для фильма разрешается и возвращает HLS, но повторные root/segment запросы в облаке завершались `404` или `502`. Кандидат BB/ZetflixDB также завершился таймаутом на 90-й секунде; это не относится к проверенному BB/Vibix. Адаптер перед запросом обновляет точные выбранные озвучку и серию и не использует просроченный снимок. Zetflix выдаёт озвучки, но три проверенных варианта Haikyuu S1E14 вернули `MEDIA_UNAVAILABLE`; воспроизведение в облаке не подтверждено. Добавлена узкая finite-VOD защита: источник отбрасывается, если заявленная длительность меньше половины ожидаемой. Для Fight Club (TMDB fixture id 550, 139 минут; без реального API token) backend передал `runtimeMinutes=139`; исходный VeoVeo после отказа ZetflixDB дал поток 8349 секунд, 17 декодированных кадров и успешный seek на 60-й секунде с новыми кадрами. Это подтверждает этот фильм и кандидат, но не защиту для неизвестной длительности и live/direct потоков. Предыдущая проверка S3E1 доказывала декодирование и кнопку пропуска, но не правильность сезона: AniMedia фактически вернул `s=1`. Теперь явный другой сезон отбрасывается; для следующих сезонов без `s` требуется выбранный сезонный endpoint.

Для локальной проверки конфигурации запустите `node scripts/check-lampac-infrastructure.mjs`. Она проверяет allowlist модулей, JSON, закреплённые образы и закрытые порты Lampac/CDP; она не запускает Docker и не подтверждает воспроизведение. Полный план текущих проверок находится в [source-host plan](../../docs/source-host-plan.md).


Исправлен фильтр аниме: обычные русскоязычные источники теперь участвуют вместе с аниме-провайдерами. Для Haikyuu S1E14 через облачный Vibix/Onibaku подтверждены 720p, декодированный кадр и seek на 60-й секунде. Phantom и Collaps работали в локальной проверке, но облачный decode завершился 5xx; они не считаются подтверждённо работающими. Выбор серии проверяет и `e`, и заявленный `s`, в том числе при обновлении ZetflixDB; старые зашифрованные кандидаты с противоречащим сезоном также отклоняются. Явная заглушка «Заблокировано правообладателем!» исключается из озвучек и resolve. Без маркировки сезона корневой список считается первым сезоном; раздельным сезонным каталогам требуется отдельное сопоставление.

Проверка ZetflixDB на одном локальном процессе дала root/leaf/TS `200` как с полными заголовками, так и с разрешённым набором приложения, без cookie. В облаке свежий resolve может завершиться `200`, но повторный root/segment — `404` или `502` через оба маршрута. Привязка к IP/сессии остаётся гипотезой, а не установленным фактом; расширение набора заголовков и переключение Worker/Node не подтверждены как исправление. Для «Начала» Filmix выдал помеченную заглушку длительностью 3652 секунды вместо ожидаемых 148 минут. Её явная метка теперь отбрасывается, но проверка длительности прямых файлов без такой метки остаётся ограничением: текущая защита длительности относится к конечным HLS VOD.


Первый браузерный S3E1 после исправления сезона дошёл до Filmix/AniLibria (файл 2985 секунд), но seek сбросился к началу. После обновления клиента свежий S3E1 прошёл через Kodik/AniLibria.TV 720p: длительность 1467 секунд, 15 кадров до seek, перемотка на 60-ю секунду с новыми кадрами и нажатие «Пропустить опенинг». AniSkip 32935/1 и IntroDB ответили 200; backend указал season=3, episode=1. Видео и тайминги реальные, TMDB — fixtures. Это подтверждает данный кандидат Kodik, но не исправляет Filmix. Свежий поиск «Начала» после деплоя вернул 42 кандидата без Filmix-заглушки; реальные decode/seek этих 42 кандидатов не подтверждены.


Свежий браузерный S1E14 после этого деплоя прошёл воспроизведение AniMedia (1470 секунд, 16 кадров) и seek на минуту; AniSkip `20583/14` ответил `200`, но в выбранной точке кнопка пропуска не была видна. Метаданные TMDB в этой проверке — fixtures, видео и запросы меток реальные.


Автовыбор больше не исключает весь провайдер после ошибки одной озвучки. Неудачные кандидаты учитываются отдельно; уже найденные провайдеры перебираются по очереди, затем проверяются их другие озвучки. Браузерный тест с реальными кадрами прошёл цепочку 503 → битый HLS → рабочая озвучка того же провайдера и seek на 60-ю секунду. Это проверка механизма на fixtures, а не подтверждение доступности всех внешних источников.


После деплоя исправления качества повторная скрытая браузерная проверка «Начала» прошла через VeoVeo / «Оригинал» auto: 8888 секунд, 152 кадра, seek на 60,51 секунды с 135 новыми кадрами; ошибок HTTP или media error в этой попытке не было. Это подтверждает этот кандидат, но не все озвучки VeoVeo. TMDB использовал fixtures; видео было реальным. Парная проверка ранее выданного ZetflixDB дала плейлист, затем 502 следующего ресурса через Node и Worker; позднее сам root вернул 502. Устойчивое воспроизведение ZetflixDB не подтверждено.
