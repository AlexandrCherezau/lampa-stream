# Персональное кино: активная цель, 2026-10-14

Все три функции обязательны: продолжение на другом устройстве с точной позицией, выбранной озвучкой и субтитрами; ежемесячный персональный киноитог с временем/фильмами/жанрами/собственными оценками и экспортом красивой карточки; пять подходящих фильмов по настроению, лимиту времени и компании. Цель остаётся активной до проверки всех пунктов в production. Существующая главная сохраняет только четыре заказанные подборки; новые функции получают самостоятельные разделы.

## Критерии готовности

- Два независимых browser contexts (desktop и телефон) связаны через настоящую облачную API. Точная позиция сохраняется при паузе/закрытии и восстанавливается с допуском до 1 секунды; выбранные source voice и субтитры, в том числе выключенные, восстанавливаются по устойчивым идентификаторам/языку/названию, не по ссылкам или временным индексам. Фильм и серия проверяются отдельно. Свежий телефон получает каталог без повторного ручного ввода TMDB token через защищённую привязку.
- Cloud данные переживают новый serverless instance; offline очередь не стирает более свежий прогресс другого устройства, rewind сохраняется; записи идемпотентны; секреты и media URLs не включаются в историю, статистику, логи и изображения. Отзыв устройства и одноразовая/ограниченная по времени привязка проверены. Локальный просмотр работает без облака.
- Watch time учитывает фактическое воспроизведение, исключает паузу, buffering, initial resume, перемотки и пропуски; повторная доставка и пересекающиеся устройства не удваивают время. Киноитог выбирает месяц и показывает завершённые фильмы/серии, активность, любимые жанры и личные оценки; пустые и legacy данные отображаются честно. Реальный PNG экспортируется и проверяется; mobile share использует файл, desktop скачивание работает.
- «На вечер»: настроение, до 90/120/180 минут/без лимита, один/вдвоём/друзья/с детьми. Пять уникальных выпущенных фильмов проходят проверку actual runtime и выбранных ограничений; просмотренные, скрытое аниме и возрастные ограничения учитываются. Отмена/смена фильтров не показывает устаревший результат. Ошибки и отсутствие достаточного числа подходящих фильмов не маскируются неподходящими вариантами.
- Responsive desktop/mobile, клавиатура, reduced motion; реальные UI flows, meaningful unit/API tests, native-player регрессии, build и независимое review. Vercel production READY и live проверка всех трёх функций с безопасными QA профилями; README/evidence обновляются. Нет новых платных сервисов.

## План и владельцы

1. Parent: контракт и архитектура, profile browser client/репликация local state, чистая аналитика и recommendation engine, credentials/environment/deployment, интеграция и итоговая проверка.
2. Backend agent: защищённая profile API и Redis persistence/atomic merge, device pairing/revocation, server/API маршруты и тесты.
3. Frontend agent: три новых экрана, sidebar/mobile navigation/App wiring, device UX, личные оценки, киноитог и PNG/share; UI использует существующий визуальный язык с выразительными story-карточками.
4. Player agent: playback checkpoint/preferences restoration, source selection, recording real playback intervals и native regressions. Parent владеет shared browser profile module; player/UI получают его API, не редактируют его параллельно.
5. После интеграции: QA двух устройств и export/chooser, review, production и полная requirement-by-requirement audit.

## Проверенная база

Git root source-development, main. Upstash Redis REST URL/TOKEN существуют в production frontend environment (проверены только имена, значения не читались). Используем существующий serverless Redis; api/room.js уже применяет native fetch. Storage локальный streambert_ prefix. Source-host и Worker медиа не меняем ради профиля. Graph project lampa-stream-vercel, generation 2026-10-13T17:19:47Z; OnlinePlayer/Settings/Home изменились с индекса — читать source. Tests/ scripts исключены из graph и читаются напрямую.

## Дизайн

Основа: чёрный фон существующего Streambert, киноитог как последовательность четырёх/пяти ярких персональных story-карточек с большой типографикой и графикой киноплёнки, нейтральный остальной chrome. Цвета: экран #08080a, текст #f5f4ef, киновишня #ff314f, фиолетовый #9270ff, тёплый свет #ffd45a, холодный свет #55c8df. DM Sans для интерфейса, Bebas Neue для цифр при поддержке; кириллица читаемым системным/существующим шрифтом. Никаких случайных статов/демо под видом личных данных.
Референс: [официальные Итоги Яндекс Музыки](https://www.yandex.ru/support/music/ru/collection/result_of_year) — личные любимые жанры/контент и сценарий воспоминания; branding/assets не копируются.

## Реализация и доказательства на текущем шаге

Реализованы profile API/Redis atomic merge, browser outbox, привязка с подтверждением и переносом каталога, точные player checkpoints/preferences, интервалы фактического просмотра, личные оценки, три самостоятельных UI-раздела, PNG/Web Share и подбор с проверкой полных TMDB metadata. Главная не менялась. В production добавлен только PROFILE_DATA_SECRET (sensitive); используются уже существующие Redis variables, значения секретов не публиковались. Функции выложены в frontend runtime01ff200, но облачный профиль заблокирован недоступным прежним Redis; новая приватная Blob реализация выполняется.

Независимое ревью выявило и проверило исправления сроков Redis, гонок revoke/approval, expiresAt, долговечной идемпотентности очистки, устаревшей очереди после очистки, очистки legacy native maps и границ аккаунта. Настройка истории отключает новые checkpoint/session записи; очистка watch data сбрасывает облачные и локальные просмотры, сохраняя избранное/оценки.

Последняя интегрированная QA-сборка PASS; полный Node suite с настоящими Redis и HTTP — 42/42 PASS. Финальный единый Playwright с PLAYER_PROFILE_LIVE=1 — 45/45 PASS. Первоначально красные genuine-native-ended проверки читали старую незавершённую сессию вместо новой с completedAt. Тест исправлен на новый sessionId; профильный набор 6/6 PASS, включая обе movie/TV native-ended проверки. Единый финальный прогон всех45 сценариев прошёл.

Отдельный CLI GUI-проверочный прогон связал два независимых desktop/mobile contexts через настоящий локальный Redis-backed HTTP: свежий телефон без TMDB key получил каталог, личная оценка 9 и детерминированные 2 часа fixture-статистики совпали на экранах; PNG скачан/визуально осмотрен; пять фильмов прошли фильтры по fixture metadata, JS ошибок нет. Web Share API получил настоящий PNG File с проверенной сигнатурой, Enter и reduced-motion проверены. Native OS share sheet не открывался. Счётчики/metadata этого GUI-прогона тестовые, не выдавать их за личную статистику пользователя или живой TMDB подбор.

Пакет frontend deployment подготовляется `/tmp/personal-frontend-prepare.mjs`: включает новые runtime-файлы, без tests/docs/secrets и без source-host redeploy. Перед отправкой пересоздать request после финального commit. Production feature smoke и живой подбор по настоящему каталогу ещё обязательны; цель остаётся активной.

## Рабочее облачное хранилище: текущая реализация

Production READY dpl_Fss15NfSCgEKJrdwetAwL5AmfyrR с runtime01ff200; CJS/native-import исправление подтверждено JSON401 от GET. POSTprofile503 и старый room502(fetchfailed) показывают, что существующий Redis недоступен. Создание нового free Upstash требует browser terms; Cloudflare не авторизован. Не объявлять backend готовым по именам environment variables.

Создан private Vercel Blob store_Koat9ngjtdgTC2hS fra1 толькоproduction. Реальный private CRUD/CAS probe прошёл, устаревший ETag отвергнут, QA blob удалён. Hobby подтверждён; без платных планов. @vercel/blob2.8.1 server-only. Новая backend реализация сохраняет весь контракт через fresh-read/CAS per-profileJSON, immutable locators и durable rate buckets; caller auth/TTL проверяются в каждой попытке CAS. Client снижает только background cloud traffic:300s запись/120s GET; локальная точность и приоритетные pause/close/prefs/library/completion/clear сохраняются. Новая очередь устраняет close-in-flight race через валидированный superseding receipt+clientSeq, не предположительную revision. Нужны новые concurrency/real Blob/native-player проверки перед новым production READY.

Production UI export/recap/chooser fixture smoke PASS: два viewport, три оценки, PNG1200x1500 с длинной строкой и5 валидных fixture фильмов,0JS errors; PNG осмотрен. Живой TMDB и настоящее облачное продолжение после Blob реализации ещё остаются обязательными. Цель активна.

## Текущая проверка закрытия и хранилища

В независимом ревью воспроизведён расход keepalive-резерва несколькими pagehide listeners: session-only flush опережал точный checkpoint. Chrome подтвердил, что capture:true на Window не обеспечивает нужный порядок. Теперь каждый плеер регистрирует один синхронный closing callback в profile store; глобальный pagehide/hidden handler сначала захватывает позицию и сессию, затем отправляет один пакет. Hidden/pause сохраняют 20KiB резерв, React cleanup использует обычный fetch. В пакете первым идёт свежий checkpoint и относящаяся к нему сессия. Проверка большой кириллической очереди, трёх удержанных pause, hidden и pagehide99.987 прошла; client37/37 и Vite build PASS. Проверяется настоящее navigation unload→phone resume для фильма и серии.

Последний полный Blob browser run:39PASS, профильные6 не завершены из-за pair/claim503. Raw SDK воспроизвёл конфликт conditional put при быстрых последовательных записях даже после свежего get; задержка1.5s дала9 успешных CAS. Это отдельное поведение Blob, исправление через ограниченный backoff проверяется backend agent; unconditional overwrite не допускается. Без нового успешного полного pairing flow не выкладывать.

Живой production TMDB discover без пользовательского каталожного токена ответил401. Fixture подборы доказывают фильтры и интерфейс, но не заменяют живой authenticated sample. Новая Blob версия пока не опубликована; цель остаётся активной.

## Готовность обновления перед публикацией

SDK fix подтверждён: get JSON и его ETag могут расходиться с версией условной записи; put использует HEAD ETag и проверяет неизменность ожидаемого JSON до/после HEAD. expectedValue передаётся через весь wrapper; race tests проверяют concurrent update/revoke/clear/rate. Generic SDK conflict повторяется через fresh-read/CAS с jitter, без unconditional overwrite. Три одновременных настоящих SDK PATCH сохранили все три checkpoint. Полный real SDK pairing/bootstrap/PATCH/clear/revoke PASS после финального fix.

Последний closing fix: после успеха новой паузы state.batch мог отсутствовать, хотя старые неудачные outbox оставались. Приоритетный запрос ошибочно повторял старый пакет первым; после unload следующий пакет не выполнялся. Теперь keepalive/priority с отсутствующим batch сначала строит пакет из актуальной очереди с ancestry. Новый точный regression PASS; независимое review подтвердило38/38client tests. Torr manual seek обновляет pending resume target, чтобы закрытие не возвращало исходную позицию.

Финальная Node проверка78/78PASS,0skip с настоящими Redis/HTTP/BlobSDK. Vite build PASS. Обычные39browser cases прошли в общем запуске, профильные6/6 прошли отдельно после финальной сборки: OnlinePlayer, movie/TV, desktop→iPhone13 Chromium emulation, настоящие pagehide/navigation about:blank, точная позиция с допуском0.1s относительно реального UI seek, выбранная Alloha voice, subtitleON/OFF, near-end override и genuine completion. Metadata/HLS fixture, profile HTTP и private Blob настоящие. Это45уникальных scenarios, не один зелёный общий прогон. Физический iPhone/Safari/OS share sheet не проверялся. Следующий шаг: frontend-only production deploy и реальные production profile/client/UI проверки; живой authenticated TMDB sample остаётся отдельным отсутствующим доказательством.
