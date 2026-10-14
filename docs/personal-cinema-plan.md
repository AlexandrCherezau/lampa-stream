# Персональное кино: завершено, 2026-10-14

Все три функции обязательны: продолжение на другом устройстве с точной позицией, выбранной озвучкой и субтитрами; ежемесячный персональный киноитог с временем/фильмами/жанрами/собственными оценками и экспортом красивой карточки; пять подходящих фильмов по настроению, лимиту времени и компании. Цель не считается завершённой до проверки всех пунктов в production. Существующая главная сохраняет только четыре заказанные подборки; новые функции получают самостоятельные разделы.

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

## Финальное состояние и доказательства

Все три функции реализованы и проверены в исходном объёме. Подробная карта — `docs/personal-cinema-verification-2026-10-14.json`; actual catalogue proof — `docs/personal-cinema-live-catalogue-2026-10-14.json`. Критерии выше сохраняются без сужения. Независимое review не выявило оставшихся обязательных блокеров/P1/P2.

Private Vercel Blob заменил недоступный production Redis без платного плана. Authority/TTL/revoke проверяются на fresh reads; conditional writes используют HEAD ETag с expected JSON guards до/после HEAD и bounded jitter retry. Concurrent SDK, pairing/bootstrap/clear/revoke прошли. Closing registry собирает актуальные checkpoint/session до единственного pagehide flush; failed outbox не опережает текущую позицию. Background cadence 300s/120s сохраняет локальную точность и приоритетные события.

Full Node 78/78 PASS, 0skip; build PASS. Production OnlinePlayer movie/TV cross-device 6/6 PASS через настоящий Blob: точная позиция, UI seek/pause/close, voice, subtitles ON/OFF, near-end и native completion. HLS/metadata — fixtures. Киноитог проверен analytics/month/DST/genre union/personal ratings/legacy, actual cloud sync, настоящий PNG/download/File share; показанные QA2h не выдаются за личные данные пользователя. Физический Safari/OSshare не испытывались; API/File contract подтверждён.

Последний runtime `d89b981c528b6d00301479d930b67a5d0ecd2b56`, frontend `dpl_89FfHiwpu9uoraM6DSnBwBq89rhN` READY/main alias, повторно подтверждён CLI. API/client/player не менялись после production6/6; последние UI изменения — склонения счётчиков и DOM movie ID. Документационные commits позднее runtime не требуют повторной выкладки.

Пользователь предоставил легитимный token, прежний blocker401 снят. Настоящий production chooser `напряжённое / до120 / вдвоём` без mocks выдал пять released distinct IDs с runtime93–109, нужными жанрами, detail/discover200; poster navigation и0JSerrors. Свежий телефон без ключа получил его через защищённую UI привязку и owner approval, прочитал actual movie550 HTTP200, выполнил такой же actual chooser; revoke401,0JSerrors. Первые два телефонных прогона выявили ошибку только временного QA сценария чтения native Response.status; финальный исправленный сценарий PASS. Значение токена не хранится в Git, документах или evidence.

Прежний параллельный HTTP client smoke однажды не подтвердил rewind; причина не доказана, финальный isolated smoke PASS28.9s. Этот факт сохранён в evidence. Family — строгий genre/certification фильтр; остальные company choices — бонус ранжирования. Неподходящие фильмы не используются для заполнения shortfall.

Обязательного следующего шага нет. `scripts/check-production-tonight.mjs` остаётся воспроизводимой live проверкой с приватным environment `TONIGHT_SMOKE_TMDB_TOKEN`, без interception и без вывода сырых Playwright ошибок/headers. Проверка не требует сохранять токен в исходниках. При новых runtime изменениях выбирать проверки по затронутому поведению.
