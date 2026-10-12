# Один сервер источников на Cloudflare

> Текущая политика: бюджет $0, только бесплатные тарифы. Этот платный вариант
> сохранён как историческая подготовка и не входит в действующий план.
> Не запускать Containers, не подключать Workers Paid и не включать платные add-ons.
> Сайт и backend остаются на Vercel; фактический тариф аккаунта и остаток квот
> нужно проверить отдельно, наличие READY deployment не доказывает бесплатность.

Подготовленная конфигурация: `workers-api/source-host-container.wrangler.json`.
Это ещё не развёрнутый сервер. Сайт продолжает использовать Vercel.

Один именованный Durable Object принимает API и media-запросы и направляет их
в один контейнер (`max_instances: 1`). Используется существующий Dockerfile
с Node, Lampac и скрытым Chromium, без нового SDK. Внешний порт только 9120;
нативный движок остаётся на loopback. Секреты передаются при запуске процесса.
Dockerfile-specific ignore исключает из контекста сборки остальные файлы,
включая локальные credentials. Worker не буферизует видео и не задаёт старый
`SOURCE_MEDIA_RELAY_URL`, поэтому HLS-сегменты проходят через этот же сервер.

Контейнер засыпает через 10 минут без активности. Перезапуск может изменить
исходящий IP и сделать прежние ссылки недействующими. Cloudflare не обещает
фиксированный исходящий IP; уменьшение CDN 404 ещё нужно проверить настоящим
воспроизведением и перемоткой. Один экземпляр также ограничивает пропускную
способность; масштабирование нельзя включать до проверки provider affinity.

## Запуск после восстановления доступа и выбора бюджета

Cloudflare требует Workers Paid ($5/мес плюс контейнер, трафик и Durable Object).
`standard-1` — 4 GiB RAM, 0,5 vCPU, 8 GB disk. RAM и disk оплачиваются за время
работы, CPU — за фактическое использование; `max_instances: 1` не ограничивает
счёт деньгами. Платный тариф автоматически не подключается.

Из корня репозитория, после проверки аккаунта через `wrangler whoami`:

```sh
wrangler secret put SOURCE_HOST_SECRET --config workers-api/source-host-container.wrangler.json
wrangler secret put SOURCE_API_KEY --config workers-api/source-host-container.wrangler.json
wrangler deploy --config workers-api/source-host-container.wrangler.json
```

Секреты должны соответствовать существующему private gateway; не вставлять их
в Git, аргументы команд или логи. Перед запуском проверить `SOURCE_PUBLIC_ORIGIN`
по фактическому Workers subdomain аккаунта. Docker Engine необходим для сборки.

Проверки до смены production gateway: healthz, свежие discover/resolve,
совпадение `x-source-instance` для resolve/playlist/segments, реальные кадры,
перемотка русского фильма, сериала и аниме, повтор после сна.
Zetflix/ZetflixDB исключены из нового поиска по текущей задаче.
Только после этого заменить backend URL сайта; сохранить Vercel для отката.

Локальные проверки Worker:

```sh
node --test workers-api/source-host-container.test.mjs
```

Проверки нового Worker прошли 8/8; вместе с существующим media Worker — 20/20.
Wrangler 4.149.0 принял конфигурацию и сгенерировал binding types.
`wrangler deploy --dry-run --containers-rollout none` успешно собрал Worker
(4,85 KiB; gzip 1,59 KiB), без загрузки в Cloudflare и без сборки контейнера.
Они используют заглушку native DurableObject API; не доказывают работоспособность
Cloudflare VM, Chromium или внешнего CDN. Локальный Docker build пока не выполнен:
текущий пользователь не имеет доступа к Docker socket.

Документация: [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[цены](https://developers.cloudflare.com/containers/platform/pricing/).
