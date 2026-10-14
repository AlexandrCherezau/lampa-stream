# Персональное кино: проверка заблокирована, 2026-10-14

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

## Текущее состояние и доказательства

Три функции реализованы; подробная актуальная карта проверок и ограничений хранится в `docs/personal-cinema-verification-2026-10-14.json` и разделе «Персональное кино» в README.agents.md. Исходные критерии выше сохраняются полностью.

Private Vercel Blob заменил недоступный production Redis без перехода на платный план. Авторитетное состояние хранится в private profile JSON с fresh auth/TTL и conditional writes. HEAD ETag с expected JSON guards до/после HEAD защищает гонки чтения/записи; bounded jitter retry исправляет временные SDK conflicts. Реальные concurrent SDK/PATCH/pair/bootstrap/clear/revoke проверки прошли. Closing registry собирает свежие checkpoint/session до единственного pagehide flush; старые failed outbox не опережают текущую позицию. Background cloud cadence300s/120s сохраняет приоритетные события и локальную точность.

Full Node78/78PASS,0skip; buildPASS. Production profile runtime4f172b0 READY:6/6 OnlinePlayer movie/TV cross-device cases через actualVercelBlob с metadata/HLS fixtures; production GUI pairing/token/rating/recap/PNG/fixture chooserPASS; isolated actualHTTP client transfer/rewind/clear/revokePASS28.9s. Первый конкурентный production client run не прошёл rewind; причина не доказана, успешный rerun не выдаётся за исправление runtime. Физический Safari/OSshare не испытывались; PNG File Web Share contract подтверждён. Настоящие source/media не проверялись заново в рамках профильной QA.

Киноитог основан на фактических wall-time playback intervals: паузы/buffering/seeks исключаются, пересечения и повторная доставка учитываются один раз. Проверены month/DST, movie/episode counts, genre union, собственные оценки, legacy/empty states. Скачанный PNG1200x1500 визуально осмотрен с длинными названиями; последняя полировка1b1c01e исправляет русские формы1/2/5 в UI/canvas, local UI/PNG/buildPASS. Frontend1b1c01e/dpl_H3ZM6FqtR3NDs9Rw9qFWGBGZkxZFREADY/mainalias;deployedUI/PNGPass сfixtureстатистикой,0pageerrors.

«На вечер» проверяет full metadata runtime/release/mood/anime/watched/age/unique и честный shortfall, отмена защищает от устаревших результатов. Companypair/friends/solo — бонус жанровому ранжированию, family — строгая family/certification граница. Пять подходящих фильмов в GUI/unit проверены на тестовом каталоге. Реальный authenticated TMDB и чтение настоящего каталога свежим связанным телефоном ещё не подтверждены; запрос без действующего токена401. Не заменять этот критерий fixture proof и не отмечать цельcomplete.

Финальный frontend runtime `d89b981c528b6d00301479d930b67a5d0ecd2b56`, deployment `dpl_89FfHiwpu9uoraM6DSnBwBq89rhN` READY/main alias. DOM movie ID добавлен для точной проверки; парные названия не мешают верификатору. Изолированные CLI/Chrome success, detail-network-failure и navigation-failure regressions прошли, fake token в stdout/stderr отсутствует. Deployed Tonight fixture UI подтвердил пять distinct IDs и poster navigation без JS ошибок. API/client/players прежние; ранее выполненная облачная QA остаётся применимой. Actual TMDB probe401, authenticated sample не выполнен.

Следующий обязательный шаг: выполнить `TONIGHT_SMOKE_TMDB_TOKEN=... PRODUCTION_ORIGIN=https://lampa-stream-six.vercel.app node scripts/check-production-tonight.mjs` с легитимным владельческим токеном, затем проверить actual catalogue на свежем связанном телефоне. Значение задаётся приватным environment, не в Git/README/чат. Скрипт без interception/metadata mocks проверяет настоящий deployed chooser, пять distinct IDs и actual runtime/release/mood, poster navigation; записывает только безопасные поля. После трёх последовательных проходов с тем же blocker цель получила статус blocked. Полный объём сохраняется; проверка возобновляется при появлении легитимного доступа к каталогу.
