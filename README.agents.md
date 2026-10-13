# Lampa-Stream / Streambert — память проекта

## Корень и запуск

Рабочий Git-корень: `/mnt/nvme/camera/lampa-stream-vercel/source-development`.
Origin: `AlexandrCherezau/lampa-stream`, ветка `main`. Соседняя `src` не является актуальным исходным деревом.
Стек: React/Vite, существующий OnlinePlayer с hls.js/dash.js, Electron; веб API в `api/`, самостоятельный Node source-host в `source-host/`.
`npm run build`; `npm run web:serve`; `node --test source-host/tests/*.test.mjs`; `PLAYWRIGHT_CHROMIUM=/usr/bin/google-chrome-stable npx playwright test tests/habster-native.spec.js tests/player.spec.js`.
Отдельных lint/typecheck scripts нет. Индекс codebase-memory для этого рабочего корня отсутствует; подтверждать карту исходниками и rg.

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
