# Lampa-Stream / Streambert — память проекта

## Корень и запуск

Рабочий Git-корень: `/mnt/nvme/camera/lampa-stream-vercel/source-development`.
Origin: `AlexandrCherezau/lampa-stream`, ветка `main`. Соседняя `src` не является актуальным исходным деревом.
Стек: React/Vite, существующий OnlinePlayer с hls.js/dash.js, Electron; веб API в `api/`, самостоятельный Node source-host в `source-host/`.
`npm run build`; `npm run web:serve`; `node --test source-host/tests/*.test.mjs`; `PLAYWRIGHT_CHROMIUM=/usr/bin/google-chrome-stable npx playwright test tests/habster-native.spec.js tests/player.spec.js`.
Отдельных lint/typecheck scripts нет. Индекс codebase-memory создан для этого рабочего корня 2026-10-13: fast, 7629 nodes/11128 edges; частичные parse gaps вне изменяемых модулей, tests читать напрямую. Подтверждать карту исходниками и проверками.

## Текущая задача и критерии

Habster Alloha должен воспроизводиться внутри существующего OnlinePlayer без iframe: реальные 360–2160p, озвучки, перемотка, прогресс, история и resume. Сначала запускается Habster, остальные источники появляются в фоне. Выкладка production Vercel разрешена пользователем.
План: разобрать публичный протокол → подключить через существующий provider/media/client → проверить регрессии → выложить backend и frontend → проверить реальное UHD и сохранение позиции → записать evidence.

## Решения и границы

`source-host/providers/alloha-protocol.mjs`: разбор публичных bootstrap/Borth/bundle guard, POST bnsi с обязательными пустыми audio/subtitle, короткий анонимный WebSocket. Скачанный JS не исполняется; Chromium и новые зависимости не нужны.
`habster.mjs`: Alloha первый для фильма, Collaps запасной; фактические озвучки отдельными sealed candidates; shared cache до 8 фильмов/45 секунд, загрузка до 20 секунд. Native Alloha TV не добавлялся; существующий Collaps TV сохраняет точную серию.
`transport.mjs`: POST до 64 KiB; public DNS pinning; чувствительные CDN headers не следуют на другой origin. `media.mjs` шифрует их в обычных media tokens и сохраняет ограничения у HLS children. Alloha и Collaps идут по Node, поскольку Worker не передаёт эти headers. Resolve Alloha до 30 секунд, Collaps до 8 секунд.
`api/source-host.js` принимает только media URL собственного source-host. Старый embed contract удалён с сервера, шлюза и клиента.
`OnlinePlayer.jsx`: существующие HLS controls; 3832×1600 распознаётся как cinematic 4K; выбор 2160p сохраняется при смене Alloha озвучки. Старт остаётся 720p для скорости.

## Проверки на 2026-10-13

68/68 source-host tests прошли; проверки gateway native/SSE, source-host-client, player и Habster client прошли. Frontend agent проверил 23 уникальных browser cases; native fixture проверяет controls/seek/history/reload, не реальное UHD.
Свежий прямой Node provider/transport: KP5494049 master 200 3832×1600, variant 200, segment 206; KP10355286 master 200 3840×2160, variant 200, segment 206. Основная и HDrezka озвучки проверены. Исследователь отдельно проверил KP7104903 3840×1604.
Один и тот же header snapshot после закрытия WS работал спустя 321 секунду, включая ранее незапрошенный последний сегмент. Полный фильм не проверен. Provider пока выбирает первый опубликованный URL каждой пары ` or `; backup CDN не испытывался при отказе первого.

## Production и следующий шаг

Frontend: `https://lampa-stream-six.vercel.app`, project `prj_nuMegVCWxU8F0I0In9wDmjzWr02k`.
Backend: `https://lampa-source-host.vercel.app`, project `prj_Bw9k7H9YNyP57jGR97MrrFluZFmC`, team `team_0OdKpV5QAWnuFG0cwbhQUBBx`; container namespace `sources-cub`.
Push не запускает deploy: проекты не связаны с Git. Манифесты собирать из проверенного production file list; backend содержит 16 runtime files, включая новый alloha-protocol.mjs; frontend 99. Backend root Dockerfile/vercel.json берутся из infrastructure/lampac. Не менять namespace, квоты, credentials или Worker для этой задачи.
Задача завершена. Backend runtime commit `3fe71192c2cbc3a40ba77fd0d7fd9ba51d09e981`, deployment `dpl_6Yqz9VhVkkVzvAPudqTLA3c8Q6yS` READY; frontend commit `40a19096e292f4a7903f7b77511582c5109ff1cf`, deployment `dpl_JADWGwsU5quDAGfhEJApGFn7b6Hq` READY. Оба production aliases подтверждены.
Финальная проверка: `docs/habster-own-player-production-verification-2026-10-13.json` GREEN. Реальные discovery/resolve/media без подмены; metadata/session flags — явно указанные QA fixtures. Наш video декодирует 3832×1600, шесть качеств, English voice сохраняет2160p/позицию; реальный seekbar, пауза7500ms, история и reload resume прошли. Замер startup с resume40s: 9889ms.
Найденный startupwatchdog сам снимал раннюю паузу после voice switch. Исправление через явное user pause intent в existing togglePlay; native regression и три прежние startup/failover проверки 4/4, свежая сборка прошла. Metadata и служебная пауза движка не считаются здоровым запуском. После намеренной ранней паузы этот startup timer не перевзводится при resume; engine error handlers остаются.
Следующий шаг при жалобе на позднюю остановку: воспроизвести этот же native stream дольше321 секунд и проверить HTTP/engine errors без signed URLs; полный фильм пока не прогонялся. У upstream встречался bnsi без WSS metadata: неподтверждённый fingerprint fallback не добавлялся. Новых обязательных действий по этой задаче нет. Секреты, signed URLs и header values не писать в Git/логи.

## Активная задача: ускорение запуска

Критерий: сократить настоящий click «Смотреть» → первые декодированные кадры относительно production baseline (~9.9s с resume40s), сохранив Habster первым, 4K/озвучки/точный resume/отмену и фильтрацию неработающего видео. Не засчитывать смену надписи или показ меню за ускорение.
План: безопасная браузерная разбивка времени discovery/resolve/HLS → убрать подтверждённое последовательное ожидание через существующие механизмы → регрессионные проверки → production deployment → тот же сравнительный замер и память. Frontend и QA выделены в независимые native slices; root отвечает за backend, интеграцию и выкладку.

Реализовано: MoviePage в web-mode готовит только Habster metadata при открытии доступного выпущенного фильма; prepareOnly не запускает Lampac, resolve или видеосегменты, отменяется при уходе и ограничен 20s. Обычный запуск присоединяется к существующему 45s title cache. Player/HLS chunks предварительно загружаются при focus/hover «Смотреть». Guard bundle и bnsi POST идут параллельно, guard cache привязан к hashed bundle URL и ограничен одним элементом/10min; title deadline не ждёт shared guard после отмены.
Media probe параллельно проверяет init/key/segment и отменяет оставшиеся проверки при отказе. Уже проверенные VOD playlists переиспользуются 15s, максимум 8 документов по 1MiB; ключ включает exact URL/effective headers/origin/publicOnly, token expiry проверяется до cache. HEAD/Range/live/failed probe не используют эту оптимизацию.
Проверки перед выкладкой: source-host 75/75, source-host-client check, Vite build, новая browser prepare/preload regression и существующие startup watchdog cases прошли. Native fixture с Chrome повторно прошёл после одного transient zero-frame результата. Независимое ревью не нашло блокирующих замечаний; быстрые переходы/отложенный age-rating отдельно браузером не проверялись.
Production baseline на той же странице TMDB969681 с 3s чтения описания и resume40s: 12.77s и 6.76s от click до первого кадра (реальные discovery/resolve/media; только metadata/session QA fixtures). Локальный старый/new замер показал небольшой выигрыш на Collaps fallback; local Alloha CDN отдавал403, поэтому это не доказательство production UHD или полного ускорения.
Следующий шаг: commit/push, authenticated Vercel CLI deploy backend → READY → frontend → READY, повторить production comparison с теми же условиями, записать результат и ограничения. Production IDs выше пока относятся к предыдущей версии.
