import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "[ZetflixDiag]";
const VIDEODB_QUALITY_MARKER = "[VideoDBQualities]";
export const SERIAL_FRAME_DOCUMENT_SCRIPT = "() => { const href = location.href; if (/^https?:/.test(href)) return href; if (href !== 'about:blank' && href !== 'about:srcdoc') return null; try { const parentUrl = parent.document.URL; const parentOrigin = new URL(parentUrl).origin; return /^https?:/.test(parentUrl) && document.baseURI === parentUrl && globalThis.origin === parentOrigin ? parentUrl : null; } catch { return null; } }";
export const MOVIE_FRAME_RESOURCES_SCRIPT = '() => performance.getEntriesByType("resource").map(r => r.name)';
const replacements = [
  [
    '                string html = hybridCache.TryGetValue($"zetfix:view:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}", out string cachedHtml) ? cachedHtml : null;',
    '                string html = hybridCache.TryGetValue($"zetfix:view:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}", out string cachedHtml) ? cachedHtml : null;',
  ],
  [
    '            string html = await InvokeCache($"zetfix:view:{kinopoisk_id}:{rs}:{proxyManager?.CurrentProxyIp}", 20, async () =>',
    '            string html = await InvokeCache($"zetfix:view:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{rs}:{proxyManager?.CurrentProxyIp}", 20, async () =>',
  ],
  [
    '            string memkey = $"zeflix:gohost:v4:{host}";',
    '            string memkey = $"zeflix:gohost:v5:{host}";',
  ],
  [
    String.raw`                    if (!string.IsNullOrWhiteSpace(ztfhost) && Uri.TryCreate(ztfhost, UriKind.Absolute, out var uri) && Regex.IsMatch(uri.Host, @"^\d+apr\.zet-flix\.online$", RegexOptions.IgnoreCase))`,
    String.raw`                    if (!string.IsNullOrWhiteSpace(ztfhost) && Uri.TryCreate(ztfhost, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) && Regex.IsMatch(uri.Host, @"^(?:[1-9]|[12]\d|3[01])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.zet-flix\.online$", RegexOptions.IgnoreCase))`,
  ],
  [
    '            string ztfhost = await goHost(init.host);\n            string log = $"{HttpContext.Request.Path.Value}\\n\\nstart init\\n";',
    '            string ztfhost = await goHost(init.host);\n            string selectedHost = Uri.TryCreate(ztfhost, UriKind.Absolute, out var selectedHostUri) ? selectedHostUri.DnsSafeHost : string.Empty;\n            Console.WriteLine("[ZetflixDiag] stage=host_selected host=" + selectedHost);\n            string log = $"{HttpContext.Request.Path.Value}\\n\\nstart init\\n";',
  ],
  [
    '            if (serial != 1 && ((content?.movie == true && NeedLiveMovieFallback(content)) || content?.pl == null))\n            {\n                var liveMovie = await CaptureLiveMovie(ztfhost, kinopoisk_id, rs, title, original_title);\n                if (!liveMovie.IsEmpty)\n                {\n                    if (origsource)\n                        return Content(liveMovie.ToJson(), "application/json; charset=utf-8");\n\n                    return ContentTpl(liveMovie);\n                }\n            }',
    '            if (serial != 1 && ((content?.movie == true && NeedLiveMovieFallback(content)) || content?.pl == null))\n            {\n                var liveMovie = await CaptureLiveMovie(ztfhost, kinopoisk_id, rs, title, original_title);\n                if (!liveMovie.IsEmpty)\n                {\n                    if (origsource)\n                        return Content(liveMovie.ToJson(), "application/json; charset=utf-8");\n\n                    return ContentTpl(liveMovie);\n                }\n\n                return OnError();\n            }',
  ],
  [
    '            string memKey = $"zetflix:live_movie:v4:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}";',
    '            string memKey = $"zetflix:live_movie:v5:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}";',
  ],
  [
    '                string result = string.IsNullOrEmpty(PHPSESSID) ? null : await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: headers);\n                if (result != null && !result.StartsWith("<script>(function"))\n                {\n                    if (!result.Contains("new Playerjs"))\n                        return null;\n\n                    proxyManager?.Success();\n                    return result;\n                }',
    '                var nativeIndexCookies = new CookieContainer();\n                if (string.IsNullOrEmpty(PHPSESSID))\n                    Console.WriteLine("[ZetflixDiag] stage=http_skipped_no_session");\n                if (!string.IsNullOrEmpty(PHPSESSID))\n                    nativeIndexCookies.Add(new Uri(uri), new System.Net.Cookie("PHPSESSID", PHPSESSID));\n                var nativeIndexResult = string.IsNullOrEmpty(PHPSESSID) ? default : await Http.BaseGet(uri, proxy: proxy, headers: headers, cookieContainer: nativeIndexCookies);\n                string result = nativeIndexResult.content;\n                string nativeIndexUri = nativeIndexResult.response?.RequestMessage?.RequestUri?.AbsoluteUri ?? uri;\n                string nativeUserAgent = headers.LastOrDefault(header => string.Equals(header.name, "user-agent", StringComparison.OrdinalIgnoreCase))?.val;\n                if (string.IsNullOrWhiteSpace(nativeUserAgent))\n                    nativeUserAgent = Http.UserAgent;\n                if (result == null)\n                    Console.WriteLine("[ZetflixDiag] stage=http_empty");\n                else if (result.StartsWith("<script>(function"))\n                    Console.WriteLine("[ZetflixDiag] stage=http_challenge");\n                if (result != null && !result.StartsWith("<script>(function"))\n                {\n                    if (!result.Contains("new Playerjs"))\n                    {\n                        Console.WriteLine("[ZetflixDiag] stage=http_playerjs_missing");\n                        return null;\n                    }\n                    Console.WriteLine("[ZetflixDiag] stage=http_playerjs_present");\n\n                    var nativeIndexEmbed = BuildSerialEmbedFromHtml(result, rs);\n                    if (serial == 1 && rs > 0 && nativeIndexEmbed?.pl?.Count > 0 && !nativeIndexEmbed.movie)\n                        await WarmSerialVideoCache(nativeIndexEmbed, ztfhost, kinopoisk_id, rs, nativeIndexUri, nativeUserAgent, nativeIndexCookies, null).ConfigureAwait(false);\n\n                    proxyManager?.Success();\n                    return result;\n                }',
  ],
  [
    '                        if (!result.Contains("new Playerjs"))\n                            return null;\n\n                        return result;',
    '                        if (!result.Contains("new Playerjs"))\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=browser_playerjs_missing");\n                            return null;\n                        }\n                        Console.WriteLine("[ZetflixDiag] stage=browser_playerjs_present");\n\n                        string browserUserAgent = await page.EvaluateAsync<string>("() => navigator.userAgent").ConfigureAwait(false);\n                        var browserIndexEmbed = BuildSerialEmbedFromHtml(result, rs);\n                        if (serial == 1 && rs > 0 && browserIndexEmbed?.pl?.Count > 0 && !browserIndexEmbed.movie)\n                            await WarmSerialVideoCache(browserIndexEmbed, ztfhost, kinopoisk_id, rs, page.Url, browserUserAgent, null, page).ConfigureAwait(false);\n\n                        return result;',
  ],
  [
    '            string memKey = $"zetflix:live_serial_tpl:v1:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}";',
    '            string memKey = $"zetflix:live_serial_tpl:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}";',
  ],
  [
    '            string memKey = $"zetflix:live_serial_tpl:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}";\n            if (!hybridCache.TryGetValue(memKey, out EmbedModel cache))',
    '            string memKey = $"zetflix:live_serial_tpl:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}";\n            bool templateHit = hybridCache.TryGetValue(memKey, out EmbedModel cache);\n            Console.WriteLine("[ZetflixDiag] stage=serial_template_cache_lookup hit=" + templateHit);\n            if (!templateHit)',
  ],
  [
    '            var cache = await InvokeCache($"zetflix:live_serial:v8:{kinopoisk_id}:{s}:{e}:{t}:{proxyManager?.CurrentProxyIp}", 300,',
    '            var cache = await InvokeCache(SerialVideoCacheKey(ztfhost, kinopoisk_id, s, e, t), 300,',
  ],
  [
    '                string playerHtml = await Http.Get(playerUri, headers: HeadersModel.Init(\n                    ("Referer", $"{ztfhost}/"),\n                    ("Origin", ztfhost)\n                ), timeoutSeconds: 15, statusCodeOK: false);\n\n                var direct = await TrySerialEmbedFromPlayerHtml(playerHtml, playerUri, ztfhost, season);',
    '                var playerResult = await Http.BaseGet(playerUri, headers: HeadersModel.Init(\n                    ("Referer", $"{ztfhost}/"),\n                    ("Origin", ztfhost)\n                ), timeoutSeconds: 15, statusCodeOK: false);\n                string actualPlayerUri = playerResult.response?.RequestMessage?.RequestUri?.AbsoluteUri ?? playerUri;\n\n                var direct = await TrySerialEmbedFromPlayerHtml(playerResult.content, actualPlayerUri, ztfhost, kinopoisk_id, season);',
  ],
  [
    '                if (page == null)\n                    return default;\n\n                await page.RouteAsync("**/*", async route =>',
    '                if (page == null)\n                    return default;\n\n                string browserUserAgent = await page.EvaluateAsync<string>("() => navigator.userAgent").ConfigureAwait(false);\n                await page.RouteAsync("**/*", async route =>',
  ],
  [
    '                        var direct = await TrySerialEmbedFromPlayerHtml(playerHtml, playerUri, ztfhost, season);',
    '                        var direct = await TrySerialEmbedFromPlayerHtml(playerHtml, page.Url, ztfhost, kinopoisk_id, season, page, browserUserAgent);',
  ],
  [
    '                            var direct = BuildSerialEmbedFromHtml(frameHtml, season);\n                            if (direct?.pl?.Count > 0 && !direct.movie)\n                            {',
    `                            var direct = BuildSerialEmbedFromHtml(frameHtml, season);\n                            if (direct?.pl?.Count > 0 && !direct.movie)\n                            {\n                                Console.WriteLine("[ZetflixDiag] stage=serial_frame_document_capture");\n                                string frameDocumentUri = await frame.EvaluateAsync<string>(${JSON.stringify(SERIAL_FRAME_DOCUMENT_SCRIPT)}).ConfigureAwait(false);\n                                await WarmSerialVideoCache(direct, ztfhost, kinopoisk_id, season, frameDocumentUri, browserUserAgent, null, page).ConfigureAwait(false);`,
  ],
  [
    '        async ValueTask<EmbedModel> TrySerialEmbedFromPlayerHtml(string playerHtml, string playerUri, string ztfhost, int season)',
    '        async ValueTask<EmbedModel> TrySerialEmbedFromPlayerHtml(string playerHtml, string playerUri, string ztfhost, long kinopoisk_id, int season, IPage browserPage = null, string browserUserAgent = null)',
  ],
  [
    '            var direct = BuildSerialEmbedFromHtml(playerHtml, season);\n            if (direct?.pl?.Count > 0 && !direct.movie)\n                return direct;',
    '            var direct = BuildSerialEmbedFromHtml(playerHtml, season);\n            if (direct?.pl?.Count > 0 && !direct.movie)\n            {\n                string documentUri = string.IsNullOrWhiteSpace(browserPage?.Url) ? playerUri : browserPage.Url;\n                string userAgent = string.IsNullOrWhiteSpace(browserUserAgent) ? Http.UserAgent : browserUserAgent;\n                Console.WriteLine("[ZetflixDiag] stage=serial_parent_document_capture");\n                await WarmSerialVideoCache(direct, ztfhost, kinopoisk_id, season, documentUri, userAgent, null, browserPage).ConfigureAwait(false);\n                return direct;\n            }',
  ],
  [
    '            string iframeUri = iframeSrc.StartsWith("//") ? $"https:{iframeSrc}" :\n                               iframeSrc.StartsWith("/") ? $"{ztfhost}{iframeSrc}" :\n                               iframeSrc;',
    '            string iframeUri = Uri.TryCreate(playerUri, UriKind.Absolute, out var playerDocument)\n                ? new Uri(playerDocument, iframeSrc).AbsoluteUri\n                : iframeSrc.StartsWith("//") ? $"https:{iframeSrc}" :\n                  iframeSrc.StartsWith("/") ? $"{ztfhost}{iframeSrc}" :\n                  iframeSrc;',
  ],
  [
    '            var iframeResult = await Http.BaseGet(iframeUri,\n                headers: HeadersModel.Init(\n                    ("Referer", playerUri),\n                    ("Origin", ztfhost),\n                    ("Sec-Fetch-Dest", "iframe"),\n                    ("Sec-Fetch-Mode", "navigate"),\n                    ("Sec-Fetch-Site", "cross-site")\n                ),\n                timeoutSeconds: 15,\n                statusCodeOK: false,\n                cookieContainer: new CookieContainer()\n            );\n\n            return BuildSerialEmbedFromHtml(iframeResult.content, season);',
    '            var iframeCookies = new CookieContainer();\n            var iframeResult = await Http.BaseGet(iframeUri,\n                headers: HeadersModel.Init(\n                    ("Referer", playerUri),\n                    ("Origin", ztfhost),\n                    ("Sec-Fetch-Dest", "iframe"),\n                    ("Sec-Fetch-Mode", "navigate"),\n                    ("Sec-Fetch-Site", "cross-site")\n                ),\n                timeoutSeconds: 15,\n                statusCodeOK: false,\n                cookieContainer: iframeCookies\n            );\n\n            var iframeEmbed = BuildSerialEmbedFromHtml(iframeResult.content, season);\n            if (iframeEmbed?.pl?.Count > 0 && !iframeEmbed.movie)\n            {\n                string documentUri = iframeResult.response?.RequestMessage?.RequestUri?.AbsoluteUri ?? iframeUri;\n                Console.WriteLine("[ZetflixDiag] stage=serial_iframe_document_capture");\n                await WarmSerialVideoCache(iframeEmbed, ztfhost, kinopoisk_id, season, documentUri, Http.UserAgent, iframeCookies, null).ConfigureAwait(false);\n            }\n            return iframeEmbed;',
    '                cookieContainer: new CookieContainer()\n            );\n\n            return BuildSerialEmbedFromHtml(iframeResult.content, season);',
  ],
  [
    '        EmbedModel BuildSerialEmbedFromHtml(string html, int season)',
    String.raw`        string SerialVideoCacheKey(string ztfhost, long kinopoisk_id, int season, int episode, string voice)
        {
            return $"zetflix:live_serial:v9:{ztfhost?.TrimEnd('/')}:{kinopoisk_id}:{season}:{episode}:{NormalizeObrutNodeText(voice)}:{proxyManager?.CurrentProxyIp}";
        }

        async ValueTask WarmSerialVideoCache(EmbedModel embed, string ztfhost, long kinopoisk_id, int season, string documentUri, string userAgent, CookieContainer cookieContainer, IPage browserPage)
        {
            Console.WriteLine("[ZetflixDiag] stage=video_cache_enter");
            if (embed?.movie != false || embed.pl == null)
            {
                Console.WriteLine("[ZetflixDiag] stage=video_cache_embed_rejected");
                return;
            }
            if (!Uri.TryCreate(documentUri, UriKind.Absolute, out var document) ||
                (document.Scheme != Uri.UriSchemeHttps && document.Scheme != Uri.UriSchemeHttp))
            {
                Console.WriteLine("[ZetflixDiag] stage=video_cache_document_rejected");
                return;
            }

            int warmed = 0;
            foreach (var voice in embed.pl)
            {
                string voiceName = voice.title;
                string normalizedVoice = NormalizeObrutNodeText(voiceName);
                if (string.IsNullOrWhiteSpace(normalizedVoice) || voice.folder == null)
                    continue;

                foreach (var episode in voice.folder)
                {
                    string episodeNumber = Regex.Match(episode.comment ?? string.Empty, "^([0-9]+)").Groups[1].Value;
                    if (!int.TryParse(episodeNumber, out int episodeIndex) || episodeIndex <= 0)
                        continue;

                    string file = episode.file;
                    if (string.IsNullOrWhiteSpace(file) || file.StartsWith("episode://", StringComparison.OrdinalIgnoreCase))
                        continue;

                    var qualitys = ParsePlayerjsQualityMap(file);
                    if (qualitys.Count == 0)
                        qualitys = ParseObrutQualityMap(file);
                    if (qualitys.Count == 0)
                        continue;

                    string firstUrl = qualitys.OrderByDescending(item => item.Key).First().Value.Replace("#.m3u8", string.Empty);
                    if (!Uri.TryCreate(firstUrl, UriKind.Absolute, out var firstMedia) || (firstMedia.Scheme != Uri.UriSchemeHttps && firstMedia.Scheme != Uri.UriSchemeHttp))
                        continue;

                    bool sameAuthority = qualitys.Values.All(value =>
                        Uri.TryCreate(value.Replace("#.m3u8", string.Empty), UriKind.Absolute, out var media) &&
                        (media.Scheme == Uri.UriSchemeHttps || media.Scheme == Uri.UriSchemeHttp) &&
                        media.Scheme == firstMedia.Scheme &&
                        string.Equals(media.GetLeftPart(UriPartial.Authority), firstMedia.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase));
                    if (!sameAuthority)
                        continue;

                    var headers = HeadersModel.Init(
                        ("accept", "*/*"),
                        ("origin", document.GetLeftPart(UriPartial.Authority)),
                        ("referer", document.AbsoluteUri),
                        ("sec-fetch-dest", "empty"),
                        ("sec-fetch-mode", "cors"),
                        ("sec-fetch-site", "same-site"));
                    headers.Add(new HeadersModel("user-agent", string.IsNullOrWhiteSpace(userAgent) ? Http.UserAgent : userAgent));

                    async Task<string> getScopedCookieHeader(Uri mediaUri)
                    {
                        if (browserPage != null)
                        {
                            var scopedCookies = await browserPage.Context.CookiesAsync(new[] { mediaUri.AbsoluteUri }).ConfigureAwait(false);
                            return string.Join("; ", scopedCookies
                                .OrderBy(item => item.Name, StringComparer.Ordinal)
                                .ThenBy(item => item.Value, StringComparer.Ordinal)
                                .Select(item => $"{item.Name}={item.Value}"));
                        }

                        return string.Join("; ", (cookieContainer?.GetCookies(mediaUri).Cast<System.Net.Cookie>() ?? Enumerable.Empty<System.Net.Cookie>())
                            .OrderBy(item => item.Name, StringComparer.Ordinal)
                            .ThenBy(item => item.Value, StringComparer.Ordinal)
                            .Select(item => $"{item.Name}={item.Value}"));
                    }

                    string cookie;
                    string firstCookieScope;
                    bool sameCookies = true;
                    try
                    {
                        cookie = await getScopedCookieHeader(firstMedia).ConfigureAwait(false);
                        firstCookieScope = cookie;
                        foreach (string qualityUrl in qualitys.Values.Select(value => value.Replace("#.m3u8", string.Empty)).Distinct(StringComparer.Ordinal))
                        {
                            if (string.Equals(qualityUrl, firstMedia.AbsoluteUri, StringComparison.Ordinal))
                                continue;
                            var mediaUri = new Uri(qualityUrl, UriKind.Absolute);
                            string qualityCookieScope = await getScopedCookieHeader(mediaUri).ConfigureAwait(false);
                            if (!string.Equals(firstCookieScope, qualityCookieScope, StringComparison.Ordinal))
                            {
                                sameCookies = false;
                                break;
                            }
                        }
                    }
                    catch { continue; }
                    if (!sameCookies)
                        continue;
                    if (!string.IsNullOrWhiteSpace(cookie))
                        headers.Add(new HeadersModel("cookie", cookie));

                    hybridCache.Set(SerialVideoCacheKey(ztfhost, kinopoisk_id, season, episodeIndex, voiceName),
                        (qualitys, headers), cacheTime(300));
                    warmed++;
                }
            }
            Console.WriteLine("[ZetflixDiag] stage=video_cache_warmed count=" + warmed);
        }

        EmbedModel BuildSerialEmbedFromHtml(string html, int season)`,
  ],
  [
    '            string log = $"{HttpContext.Request.Path.Value}\\n\\nstart init\\n";',
    '            Console.WriteLine("[ZetflixDiag] stage=index_start");',
  ],
  [
    '                        log += "browser init\\n";\n\n',
    '                        Console.WriteLine("[ZetflixDiag] stage=browser_fallback");\n\n',
  ],
  [
    '                        if (page == null)\n                            return null;',
    '                        if (page == null)\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=page_null");\n                            return null;\n                        }',
  ],
  [
    '                        await page.GotoAsync(uri, new PageGotoOptions()\n                        {\n                            Timeout = 15_000,\n                            WaitUntil = WaitUntilState.NetworkIdle\n                        }).ConfigureAwait(false);',
    '                        try\n                        {\n                            await page.GotoAsync(uri, new PageGotoOptions()\n                            {\n                                Timeout = 15_000,\n                                WaitUntil = WaitUntilState.NetworkIdle\n                            }).ConfigureAwait(false);\n                        }\n                        catch (Exception ex)\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=navigation_exception type=" + ex.GetType().Name);\n                            throw;\n                        }',
  ],
  [
    '                        log += "page init\\n";\n\n',
    '',
  ],
  [
    '                        log += $"{result}\\n\\n";\n\n                        if (result == null || result.StartsWith("<script>(function"))',
    '                        if (result == null)\n                            Console.WriteLine("[ZetflixDiag] stage=browser_empty");\n                        else if (result.StartsWith("<script>(function"))\n                            Console.WriteLine("[ZetflixDiag] stage=browser_challenge");\n\n                        if (result == null || result.StartsWith("<script>(function"))',
  ],
  [
    '                    log += $"\\nex: {ex}\\n";\n                    return null;',
    '                    Console.WriteLine("[ZetflixDiag] stage=browser_exception type=" + ex.GetType().Name);\n                    return null;',
  ],
  [
    '\n                        var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);',
    '\n                        Console.WriteLine("[ZetflixDiag] stage=serial_fallback_start");\n                        var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);\n                        Console.WriteLine("[ZetflixDiag] stage=serial_fallback_result count=" + (fallbackSerial?.pl?.Count ?? 0));',
  ],
  [
    '\n                var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);',
    '\n                Console.WriteLine("[ZetflixDiag] stage=serial_fallback_start");\n                var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);\n                Console.WriteLine("[ZetflixDiag] stage=serial_fallback_result count=" + (fallbackSerial?.pl?.Count ?? 0));',
  ],
  [
    '        {\n            if (kinopoisk_id == 0 || s <= 0 || e <= 0 || string.IsNullOrWhiteSpace(t))\n                return OnError();',
    '        {\n            Console.WriteLine("[ZetflixDiag] stage=video_start");\n            if (kinopoisk_id == 0 || s <= 0 || e <= 0 || string.IsNullOrWhiteSpace(t))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=video_invalid_args");\n                return OnError();\n            }',
  ],
  [
    '        [Route("lite/zetflix/video.m3u8")]\n        public async ValueTask<ActionResult> Video(long kinopoisk_id, string title, string original_title, string t, int s, int e, bool play)\n        {\n            Console.WriteLine("[ZetflixDiag] stage=video_start");\n            if (kinopoisk_id == 0 || s <= 0 || e <= 0 || string.IsNullOrWhiteSpace(t))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=video_invalid_args");\n                return OnError();\n            }\n\n            if (PlaywrightBrowser.Status == PlaywrightStatus.disabled)\n                return OnError();\n\n            if (await IsRequestBlocked(rch: false))\n                return badInitMsg;',
    '        [Route("lite/zetflix/video.m3u8")]\n        public async ValueTask<ActionResult> Video(long kinopoisk_id, string title, string original_title, string t, int s, int e, bool play)\n        {\n            Console.WriteLine("[ZetflixDiag] stage=video_start");\n            if (kinopoisk_id == 0 || s <= 0 || e <= 0 || string.IsNullOrWhiteSpace(t))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=video_invalid_args");\n                return OnError();\n            }\n\n            if (PlaywrightBrowser.Status == PlaywrightStatus.disabled)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=video_playwright_disabled");\n                return OnError();\n            }\n\n            if (await IsRequestBlocked(rch: false))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=video_request_blocked");\n                return badInitMsg;\n            }',
  ],
  [
    '            if (cache.qualitys == null || cache.qualitys.Count == 0)\n                return OnError();',
    '            if (cache.qualitys == null || cache.qualitys.Count == 0)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=video_no_quality");\n                return OnError();\n            }\n            Console.WriteLine("[ZetflixDiag] stage=video_quality_count count=" + cache.qualitys.Count);',
  ],
  [
    '            try\n            {\n                string playerHtml = await Http.Get(pageUri, headers: HeadersModel.Init(\n                    ("Referer", $"{ztfhost}/"),\n                    ("Origin", ztfhost)\n                ));\n\n                string iframeSrc = Regex.Match(playerHtml ?? string.Empty, "<iframe[^>]*?\\\\ssrc=\\\"([^\\\"]+)\\\"", RegexOptions.IgnoreCase).Groups[1].Value;',
    '            Console.WriteLine("[ZetflixDiag] stage=episode_capture_start");\n            try\n            {\n                string playerHtml = await Http.Get(pageUri, headers: HeadersModel.Init(\n                    ("Referer", $"{ztfhost}/"),\n                    ("Origin", ztfhost)\n                ));\n\n                if (string.IsNullOrWhiteSpace(playerHtml))\n                    Console.WriteLine("[ZetflixDiag] stage=player_page_empty");\n                string iframeSrc = Regex.Match(playerHtml ?? string.Empty, "<iframe[^>]*?\\\\ssrc=\\\"([^\\\"]+)\\\"", RegexOptions.IgnoreCase).Groups[1].Value;',
  ],
  [
    '                if (string.IsNullOrWhiteSpace(iframeSrc))\n                    return await TryPlayerjsSerial(ztfhost, kinopoisk_id, season, voice, episode);',
    '                if (string.IsNullOrWhiteSpace(iframeSrc))\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=player_iframe_missing");\n                    return await TryPlayerjsSerial(ztfhost, kinopoisk_id, season, voice, episode);\n                }',
  ],
  [
    '                if (!iframeUri.Contains(".obrut.show/", StringComparison.OrdinalIgnoreCase))\n                    return await TryPlayerjsSerial(ztfhost, kinopoisk_id, season, voice, episode);',
    '                if (!iframeUri.Contains(".obrut.show/", StringComparison.OrdinalIgnoreCase))\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=player_iframe_other");\n                    return await TryPlayerjsSerial(ztfhost, kinopoisk_id, season, voice, episode);\n                }\n                Console.WriteLine("[ZetflixDiag] stage=player_iframe_obrut");',
  ],
  [
    '                var obrutResult = await TryObrutSerial(iframeUri, pageUri, ztfhost, season, episode, voice);\n                if (obrutResult.qualitys?.Count > 0)\n                    return obrutResult;\n\n                return await TryPlayerjsSerial(ztfhost, kinopoisk_id, season, voice, episode);',
    '                var obrutResult = await TryObrutSerial(iframeUri, pageUri, ztfhost, season, episode, voice);\n                if (obrutResult.qualitys?.Count > 0)\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=obrut_quality_count count=" + obrutResult.qualitys.Count);\n                    return obrutResult;\n                }\n                Console.WriteLine("[ZetflixDiag] stage=obrut_no_quality");\n                return await TryPlayerjsSerial(ztfhost, kinopoisk_id, season, voice, episode);',
  ],
  [
    '            catch\n            {\n                return default;\n            }\n        }\n\n        async ValueTask<(Dictionary<int, string> qualitys, List<HeadersModel> headers)> TryPlayerjsSerial',
    '            catch\n            {\n                Console.WriteLine("[ZetflixDiag] stage=episode_capture_exception");\n                return default;\n            }\n        }\n\n        async ValueTask<(Dictionary<int, string> qualitys, List<HeadersModel> headers)> TryPlayerjsSerial',
  ],
  [
    '                    html = string.IsNullOrEmpty(PHPSESSID) ? null :\n                        await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: reqHeaders);',
    '                    if (string.IsNullOrEmpty(PHPSESSID))\n                        Console.WriteLine("[ZetflixDiag] stage=playerjs_fetch_skipped_no_session");\n                    else\n                        Console.WriteLine("[ZetflixDiag] stage=playerjs_http_fetch");\n\n                    html = string.IsNullOrEmpty(PHPSESSID) ? null :\n                        await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: reqHeaders);',
  ],
  [
    '                if (string.IsNullOrWhiteSpace(html) || html.StartsWith("<script>(function") || !html.Contains("new Playerjs"))\n                    return default;',
    '                if (string.IsNullOrWhiteSpace(html))\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=playerjs_html_empty");\n                    return default;\n                }\n                if (html.StartsWith("<script>(function"))\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=playerjs_challenge");\n                    return default;\n                }\n                if (!html.Contains("new Playerjs"))\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=playerjs_marker_missing");\n                    return default;\n                }\n                Console.WriteLine("[ZetflixDiag] stage=playerjs_marker_present");',
  ],
  [
    '                if (embed?.pl == null || embed.pl.Count == 0 || embed.movie)\n                    return default;',
    '                if (embed?.pl == null || embed.pl.Count == 0 || embed.movie)\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=playerjs_embed_empty");\n                    return default;\n                }\n                Console.WriteLine("[ZetflixDiag] stage=playerjs_voice_count count=" + embed.pl.Count);',
  ],
  [
    '                        var qualitys = ParsePlayerjsQualityMap(ep.file);\n                        if (qualitys.Count > 0)\n                            return (qualitys, null);',
    '                        var qualitys = ParsePlayerjsQualityMap(ep.file);\n                        if (qualitys.Count > 0)\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=playerjs_quality_count count=" + qualitys.Count);\n                            return (qualitys, null);\n                        }',
  ],
  [
    '                return default;\n            }\n            catch\n            {\n                return default;\n            }\n        }\n\n        static string FindPlayerjsEpisodeFile',
    '                Console.WriteLine("[ZetflixDiag] stage=playerjs_no_matching_quality");\n                return default;\n            }\n            catch\n            {\n                Console.WriteLine("[ZetflixDiag] stage=playerjs_capture_exception");\n                return default;\n            }\n        }\n\n        static string FindPlayerjsEpisodeFile',
  ],
  [
    '            string iframeHtml = iframeResult.content;\n            if (string.IsNullOrWhiteSpace(iframeHtml))\n                return default;\n\n            if (!TryParseObrutPlayerRoot(iframeHtml, out JsonObject root))\n                return default;\n\n            string file = FindObrutSerialFile(root, season, episode, voice);\n            if (string.IsNullOrWhiteSpace(file))\n                return default;\n\n            var qualitys = ParseObrutQualityMap(file);\n            if (qualitys.Count == 0)\n                return default;',
    '            string iframeHtml = iframeResult.content;\n            if (string.IsNullOrWhiteSpace(iframeHtml))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_iframe_empty");\n                return default;\n            }\n\n            if (!TryParseObrutPlayerRoot(iframeHtml, out JsonObject root))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_root_parse_failed");\n                var legacyQualitys = ParsePlayerjsSerialEpisode(iframeHtml, episode, voice);\n                if (legacyQualitys.Count > 0)\n                {\n                    Console.WriteLine("[ZetflixDiag] stage=playerjs_quality_count count=" + legacyQualitys.Count);\n                    return (legacyQualitys, BuildNativeStreamHeaders(iframeUri, legacyQualitys.First().Value, cookieContainer));\n                }\n                Console.WriteLine("[ZetflixDiag] stage=playerjs_quality_count count=0");\n                return default;\n            }\n\n            string file = FindObrutSerialFile(root, season, episode, voice);\n            if (string.IsNullOrWhiteSpace(file))\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_file_missing");\n                return default;\n            }\n\n            var qualitys = ParseObrutQualityMap(file);\n            if (qualitys.Count == 0)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_quality_missing");\n                return default;\n            }',
  ],
  [
    '        static string FindObrutSerialFile(JsonObject root, int season, int episode, string voice)\n        {\n            if (root?["file"] is not JsonArray seasons)\n                return null;\n\n            JsonObject seasonNode = FindObrutFolderByNumber(seasons, season);\n            if (seasonNode == null && seasons.Count == 1 && season == 1)\n                seasonNode = seasons[0] as JsonObject;\n\n            if (seasonNode == null || seasonNode["folder"] is not JsonArray episodes)\n                return null;\n\n            JsonObject episodeNode = FindObrutFolderByNumber(episodes, episode);\n            if (episodeNode == null)\n                return null;\n\n            if (episodeNode["folder"] is JsonArray voices && voices.Count > 0)\n            {\n                JsonObject voiceNode = FindObrutVoiceNode(voices, voice) ?? voices[0] as JsonObject;\n                return voiceNode?["file"]?.GetValue<string>();\n            }\n\n            return episodeNode["file"]?.GetValue<string>();\n        }',
    '        static string FindObrutSerialFile(JsonObject root, int season, int episode, string voice)\n        {\n            if (root?["file"] is not JsonArray seasons)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_seasons_missing");\n                return null;\n            }\n\n            JsonObject seasonNode = FindObrutFolderByNumber(seasons, season);\n            if (seasonNode == null && seasons.Count == 1 && season == 1)\n                seasonNode = seasons[0] as JsonObject;\n\n            if (seasonNode == null)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_season_missing");\n                return null;\n            }\n            if (seasonNode["folder"] is not JsonArray episodes)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_episode_list_missing");\n                return null;\n            }\n\n            JsonObject episodeNode = FindObrutFolderByNumber(episodes, episode);\n            if (episodeNode == null)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=obrut_episode_missing");\n                return null;\n            }\n\n            if (episodeNode["folder"] is JsonArray voices && voices.Count > 0)\n            {\n                JsonObject voiceNode = FindObrutVoiceNode(voices, voice);\n                Console.WriteLine(voiceNode == null ? "[ZetflixDiag] stage=obrut_voice_match_missing" : "[ZetflixDiag] stage=obrut_voice_match_found");\n                return voiceNode?["file"]?.GetValue<string>();\n            }\n\n            return episodeNode["file"]?.GetValue<string>();\n        }',
  ],
  [
    '        static JsonObject FindObrutVoiceNode(JsonArray items, string voice)\n        {\n            if (items == null || items.Count == 0)\n                return null;\n\n            string wanted = NormalizeObrutNodeText(voice);\n            JsonObject partial = null;\n\n            foreach (var item in items)\n            {\n                if (item is not JsonObject obj)\n                    continue;\n\n                string current = NormalizeObrutNodeText(obj["title"]?.GetValue<string>());\n                if (string.IsNullOrWhiteSpace(current))\n                    continue;\n\n                if (string.IsNullOrWhiteSpace(wanted))\n                    return obj;\n\n                if (current == wanted || current.Contains(wanted, StringComparison.OrdinalIgnoreCase) || wanted.Contains(current, StringComparison.OrdinalIgnoreCase))\n                    return obj;\n\n                if (partial == null && current.EndsWith(wanted, StringComparison.OrdinalIgnoreCase))\n                    partial = obj;\n            }\n\n            return partial;\n        }',
    '        static JsonObject FindObrutVoiceNode(JsonArray items, string voice)\n        {\n            if (items == null || items.Count == 0)\n                return null;\n\n            string wanted = NormalizeObrutNodeText(voice);\n            if (string.IsNullOrWhiteSpace(wanted))\n                return null;\n\n            foreach (var item in items)\n            {\n                if (item is not JsonObject obj)\n                    continue;\n\n                string current = NormalizeObrutNodeText(obj["title"]?.GetValue<string>());\n                if (current == wanted)\n                    return obj;\n            }\n\n            return null;\n        }',
  ],
  [
    '        static bool TryParseObrutPlayerRoot(string iframeHtml, out JsonObject root)',
    String.raw`        Dictionary<int, string> ParsePlayerjsSerialEpisode(string html, int episode, string voice)
        {
            if (string.IsNullOrWhiteSpace(html))
                return new Dictionary<int, string>();

            var oninvk = new ZetflixInvoke(null, null, init.hls, null, link => link);
            var embed = oninvk.Embed(html);
            var result = new Dictionary<int, string>();
            if (embed?.pl == null || embed.pl.Count == 0 || embed.movie)
                return result;

            string wantedVoice = NormalizeObrutNodeText(voice);
            foreach (var player in embed.pl)
            {
                if (NormalizeObrutNodeText(player.title) != wantedVoice || player.folder == null)
                    continue;

                foreach (var item in player.folder)
                {
                    string episodeNumber = Regex.Match(item.comment ?? string.Empty, "^([0-9]+)").Groups[1].Value;
                    if (episodeNumber != episode.ToString())
                        continue;

                    return ParsePlayerjsQualityMap(item.file);
                }
            }

            return result;
        }

        List<HeadersModel> BuildNativeStreamHeaders(string referer, string mediaUrl, CookieContainer cookieContainer)
        {
            string origin = Regex.Match(referer ?? string.Empty, "^(https?://[^/]+)", RegexOptions.IgnoreCase).Groups[1].Value;
            var headers = HeadersModel.Init(("accept", "*/*"), ("origin", origin), ("referer", referer),
                ("sec-fetch-dest", "empty"), ("sec-fetch-mode", "cors"), ("sec-fetch-site", "same-site"));
            headers.Add(new HeadersModel("user-agent", Http.UserAgent));
            if (Uri.TryCreate(mediaUrl.Replace("#.m3u8", string.Empty), UriKind.Absolute, out var mediaUri))
            {
                string cookie = BuildCookieHeader(cookieContainer, mediaUri);
                if (!string.IsNullOrWhiteSpace(cookie))
                    headers.Add(new HeadersModel("cookie", cookie));
            }
            return headers;
        }

        static bool TryParseObrutPlayerRoot(string iframeHtml, out JsonObject root)`
  ],
  [
    "                string normalizedVoice = NormalizeObrutNodeText(voice);\n\n                foreach (var pl in embed.pl)\n                {\n                    string plVoice = NormalizeObrutNodeText(pl.title);\n                    bool voiceMatch = string.IsNullOrEmpty(normalizedVoice) ||\n                                      plVoice.Contains(normalizedVoice, StringComparison.OrdinalIgnoreCase) ||\n                                      normalizedVoice.Contains(plVoice, StringComparison.OrdinalIgnoreCase);\n                    if (!voiceMatch)\n                        continue;\n\n                    if (pl.folder == null)\n                        continue;\n\n                    foreach (var ep in pl.folder)\n                    {\n                        string epNum = Regex.Match(ep.comment ?? string.Empty, \"^([0-9]+)\").Groups[1].Value;\n                        if (epNum != episode.ToString())\n                            continue;\n\n                        var qualitys = ParsePlayerjsQualityMap(ep.file);\n                        if (qualitys.Count > 0)\n                        {\n                            Console.WriteLine(\"[ZetflixDiag] stage=playerjs_quality_count count=\" + qualitys.Count);\n                            return (qualitys, null);\n                        }\n                    }\n                }\n\n                if (embed.pl.Count > 0 && IsGenericVoiceLabel(normalizedVoice))\n                {\n                    var qualitys = ParsePlayerjsQualityMap(FindPlayerjsEpisodeFile(embed.pl[0].folder, episode));\n                    if (qualitys.Count > 0)\n                        return (qualitys, null);\n                }\n\n",
    "                string normalizedVoice = NormalizeObrutNodeText(voice);\n\n                foreach (var pl in embed.pl)\n                {\n                    string plVoice = NormalizeObrutNodeText(pl.title);\n                    bool voiceMatch = !string.IsNullOrWhiteSpace(normalizedVoice) && plVoice == normalizedVoice;\n                    if (!voiceMatch || pl.folder == null)\n                        continue;\n\n                    foreach (var ep in pl.folder)\n                    {\n                        string epNum = Regex.Match(ep.comment ?? string.Empty, \"^([0-9]+)\").Groups[1].Value;\n                        if (epNum != episode.ToString())\n                            continue;\n\n                        var qualitys = ParsePlayerjsQualityMap(ep.file);\n                        if (qualitys.Count > 0)\n                        {\n                            Console.WriteLine(\"[ZetflixDiag] stage=playerjs_quality_count count=\" + qualitys.Count);\n                            return (qualitys, null);\n                        }\n                    }\n                }\n\n",
  ],
  [
    String.raw`                            var quality = Regex.Match(url ?? string.Empty, @"/(240|360|480|720|1080|1440|2160)\\.mp4:hls:manifest\\.m3u8(?:\\?|$)", RegexOptions.IgnoreCase);`,
    String.raw`                            var quality = Regex.Match(url ?? string.Empty, @"/(240|360|480|720|1080|1440|2160)\.mp4:hls:manifest\.m3u8(?:\?|$)", RegexOptions.IgnoreCase);`,
  ],
  [
    '        async ValueTask<List<LiveMovieSource>> CaptureLiveMovieInternal(string ztfhost, long kinopoisk_id, int season)\n        {\n            if (string.IsNullOrWhiteSpace(ztfhost) || kinopoisk_id == 0)',
    '        async ValueTask<List<LiveMovieSource>> CaptureLiveMovieInternal(string ztfhost, long kinopoisk_id, int season)\n        {\n            Console.WriteLine("[ZetflixDiag] stage=movie_capture_start");\n            if (string.IsNullOrWhiteSpace(ztfhost) || kinopoisk_id == 0)',
  ],
  [
    '                var fotpro = await TryFotproMovie(playerHtml);\n                var validFotpro = await ValidateMovieManifests(fotpro);',
    '                var fotpro = await TryFotproMovie(playerHtml);\n                Console.WriteLine("[ZetflixDiag] stage=movie_fotpro_count count=" + (fotpro?.Count ?? 0));\n                var validFotpro = await ValidateMovieManifests(fotpro);\n                Console.WriteLine("[ZetflixDiag] stage=movie_fotpro_validated_count count=" + (validFotpro?.Count ?? 0));',
  ],
  [
    '                string iframeSrc = Regex.Match(playerHtml ?? string.Empty, "<iframe[^>]*?\\\\ssrc=\\\"([^\\\"]+)\\\"", RegexOptions.IgnoreCase).Groups[1].Value;\n                if (!string.IsNullOrWhiteSpace(iframeSrc))',
    '                string iframeSrc = Regex.Match(playerHtml ?? string.Empty, "<iframe[^>]*?\\\\ssrc=\\\"([^\\\"]+)\\\"", RegexOptions.IgnoreCase).Groups[1].Value;\n                Console.WriteLine(string.IsNullOrWhiteSpace(iframeSrc) ? "[ZetflixDiag] stage=movie_iframe_present value=0" : "[ZetflixDiag] stage=movie_iframe_present value=1");\n                if (!string.IsNullOrWhiteSpace(iframeSrc))',
  ],
  [
    '                        var obrut = await TryObrutMovie(iframeUri, playerUri, ztfhost);\n                        var validObrut = await ValidateMovieManifests(obrut);',
    '                        var obrut = await TryObrutMovie(iframeUri, playerUri, ztfhost);\n                        Console.WriteLine("[ZetflixDiag] stage=movie_obrut_count count=" + (obrut?.Count ?? 0));\n                        var validObrut = await ValidateMovieManifests(obrut);\n                        Console.WriteLine("[ZetflixDiag] stage=movie_obrut_validated_count count=" + (validObrut?.Count ?? 0));',
  ],
  [
    '                    var qualitys = new Dictionary<int, string>();\n                    List<HeadersModel> headers = null;\n\n                    bool captured = await CaptureMovieWithBrowser(page, playerUri, qualitys, () => headers = FilterStreamHeaders(page));\n                    if (!captured && !string.IsNullOrWhiteSpace(iframeUri))\n                        captured = await CaptureMovieWithBrowser(page, iframeUri, qualitys, () => headers = FilterStreamHeaders(page));\n\n                    if (!captured || qualitys.Count == 0)\n                    {\n                        proxyManager?.Refresh();\n                        return default;\n                    }\n\n                    proxyManager?.Success();\n                    return new List<LiveMovieSource>()\n                    {\n                        new LiveMovieSource() { title = "По умолчанию", qualitys = qualitys, headers = headers }\n                    };',
    '                    var browserSources = await CaptureMovieWithBrowser(page, playerUri).ConfigureAwait(false);\n                    Console.WriteLine("[ZetflixDiag] stage=movie_browser_player captured=" + (browserSources.Count > 0 ? 1 : 0) + " quality_count=" + browserSources.Sum(source => source.qualitys?.Count ?? 0));\n                    var validBrowserSources = await ValidateMovieManifests(browserSources);\n                    if ((validBrowserSources == null || validBrowserSources.Count == 0) && !string.IsNullOrWhiteSpace(iframeUri))\n                    {\n                        browserSources = await CaptureMovieWithBrowser(page, iframeUri).ConfigureAwait(false);\n                        Console.WriteLine("[ZetflixDiag] stage=movie_browser_iframe captured=" + (browserSources.Count > 0 ? 1 : 0) + " quality_count=" + browserSources.Sum(source => source.qualitys?.Count ?? 0));\n                        validBrowserSources = await ValidateMovieManifests(browserSources);\n                    }\n                    if (validBrowserSources?.Count > 0)\n                    {\n                        proxyManager?.Success();\n                        return validBrowserSources;\n                    }\n\n                    proxyManager?.Refresh();\n                    return default;',
  ],
  [
    '                }\n            }\n            catch { }\n\n            try\n            {\n                using (var browser = new PlaywrightBrowser(init.priorityBrowser))',
    '                }\n            }\n            catch (Exception ex)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=movie_http_exception type=" + ex.GetType().Name);\n            }\n\n            try\n            {\n                using (var browser = new PlaywrightBrowser(init.priorityBrowser))',
  ],
  [
    '            }\n            catch\n            {\n                return default;\n            }\n        }\n\n        [HttpGet]\n        [Route("lite/zetflix/video")]',
    '            }\n            catch (Exception ex)\n            {\n                Console.WriteLine("[ZetflixDiag] stage=movie_browser_exception type=" + ex.GetType().Name);\n                return default;\n            }\n        }\n\n        [HttpGet]\n        [Route("lite/zetflix/video")]',
  ],
];

export function patchController(source) {
  if (source.includes(MARKER)) throw new Error("Zetflix diagnostics patch already applied");
  let output = source;
  for (const [index, [anchor, replacement]] of replacements.entries()) {
    const first = output.indexOf(anchor);
    if (first < 0 || output.indexOf(anchor, first + anchor.length) >= 0) {
      throw new Error(`Lampac 1.81.0 Zetflix source anchor mismatch at ${index}`);
    }
    output = output.slice(0, first) + replacement + output.slice(first + anchor.length);
  }
  const captureStart = output.indexOf("        async ValueTask<bool> CaptureMovieWithBrowser(");
  const captureEnd = output.indexOf("        List<HeadersModel> FilterStreamHeaders(IPage page)", captureStart);
  if (captureStart < 0 || captureEnd < 0 || output.indexOf("        async ValueTask<bool> CaptureMovieWithBrowser(", captureStart + 1) >= 0) {
    throw new Error("Lampac 1.81.0 movie browser capture anchor mismatch");
  }
  output = output.slice(0, captureStart) + String.raw`        async ValueTask<List<LiveMovieSource>> CaptureMovieWithBrowser(IPage page, string targetUri)
        {
            var sources = new Dictionary<string, LiveMovieSource>(StringComparer.Ordinal);
            if (string.IsNullOrWhiteSpace(targetUri))
                return sources.Values.ToList();

            string browserUserAgent = null;
            try
            {
                await page.GotoAsync(targetUri, new PageGotoOptions()
                {
                    Timeout = 8_000,
                    WaitUntil = WaitUntilState.DOMContentLoaded
                }).ConfigureAwait(false);
            }
            catch { }

            try
            {
                browserUserAgent = await page.EvaluateAsync<string>("() => navigator.userAgent").ConfigureAwait(false);
            }
            catch { }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            DateTime lastHit = default;
            for (int i = 0; i < 60; i++)
            {
                foreach (var frame in page.Frames.ToArray())
                {
                    try
                    {
                        string documentUri = await frame.EvaluateAsync<string>(${JSON.stringify(SERIAL_FRAME_DOCUMENT_SCRIPT)}).ConfigureAwait(false);
                        if (!Uri.TryCreate(documentUri, UriKind.Absolute, out var document) ||
                            (document.Scheme != Uri.UriSchemeHttp && document.Scheme != Uri.UriSchemeHttps))
                            continue;

                        string frameHtml = await frame.ContentAsync().ConfigureAwait(false);
                        bool hasVoiceCatalog = false;
                        if (TryParseObrutPlayerRoot(frameHtml, out JsonObject movieRoot))
                        {
                            var voices = FindObrutMovieVoices(movieRoot);
                            hasVoiceCatalog = voices?.Count > 0;
                            if (hasVoiceCatalog)
                            {
                                foreach (var voice in voices)
                                {
                                    var voiceQualitys = ParseObrutQualityMap(voice.file);
                                    if (voiceQualitys.Count == 0)
                                        continue;
                                    var voiceHeaders = await BuildMovieSourceHeaders(documentUri, voiceQualitys, browserUserAgent, page).ConfigureAwait(false);
                                    if (voiceHeaders == null)
                                        continue;
                                    string voiceTitle = string.IsNullOrWhiteSpace(voice.title) ? "По умолчанию" : voice.title;
                                    string fingerprint = documentUri + "|" + voiceTitle + "|" + string.Join("|", voiceQualitys.OrderBy(item => item.Key).Select(item => item.Key + ":" + item.Value));
                                    if (seen.Add(fingerprint))
                                    {
                                        string sourceKey = documentUri + "|" + voiceTitle;
                                        sources[sourceKey] = new LiveMovieSource { title = voiceTitle, qualitys = voiceQualitys, headers = voiceHeaders };
                                        lastHit = DateTime.UtcNow;
                                    }
                                }
                            }
                        }

                        if (!hasVoiceCatalog)
                        {
                            var resourceQualitys = new Dictionary<int, string>();
                            var resources = await frame.EvaluateAsync<string[]>(${JSON.stringify(MOVIE_FRAME_RESOURCES_SCRIPT)}).ConfigureAwait(false);
                            foreach (string url in resources ?? Array.Empty<string>())
                            {
                                var quality = Regex.Match(url ?? string.Empty, @"/(240|360|480|720|1080|1440|2160)\.mp4:hls:manifest\.m3u8(?:\?|$)", RegexOptions.IgnoreCase);
                                if (quality.Success && int.TryParse(quality.Groups[1].Value, out int height))
                                    resourceQualitys[height] = url;
                            }
                            if (resourceQualitys.Count > 0)
                            {
                                var resourceHeaders = await BuildMovieSourceHeaders(documentUri, resourceQualitys, browserUserAgent, page).ConfigureAwait(false);
                                if (resourceHeaders != null)
                                {
                                    string fingerprint = documentUri + "|По умолчанию|" + string.Join("|", resourceQualitys.OrderBy(item => item.Key).Select(item => item.Key + ":" + item.Value));
                                    if (seen.Add(fingerprint))
                                    {
                                        string sourceKey = documentUri + "|По умолчанию";
                                        sources[sourceKey] = new LiveMovieSource { title = "По умолчанию", qualitys = resourceQualitys, headers = resourceHeaders };
                                        lastHit = DateTime.UtcNow;
                                    }
                                }
                            }
                        }
                    }
                    catch
                    {
                        // A detached frame must not stop collection from other documents.
                    }
                }

                if (sources.Count > 0 && (DateTime.UtcNow - lastHit).TotalMilliseconds > 700)
                    return sources.Values.ToList();

                if (i % 8 == 0)
                {
                    try { await page.Mouse.ClickAsync(640, 360); } catch { }
                    foreach (var frame in page.Frames.ToArray())
                    {
                        try
                        {
                            await frame.EvaluateAsync(@"() => {
                                const button = document.querySelector('button, .play, .vjs-big-play-button, .jw-icon-display, .jw-display-icon-container');
                                if (button) button.click();
                                const video = document.querySelector('video');
                                if (video) {
                                    video.muted = true;
                                    video.play().catch(() => {});
                                }
                            }").ConfigureAwait(false);
                        }
                        catch { }
                    }
                }

                await Task.Delay(100);
            }

            return sources.Values.ToList();
        }

        async ValueTask<List<HeadersModel>> BuildMovieSourceHeaders(string documentUri, Dictionary<int, string> qualitys, string browserUserAgent, IPage page)
        {
            if (!Uri.TryCreate(documentUri, UriKind.Absolute, out var document) ||
                (document.Scheme != Uri.UriSchemeHttp && document.Scheme != Uri.UriSchemeHttps) ||
                string.IsNullOrWhiteSpace(browserUserAgent) || qualitys == null || qualitys.Count == 0)
                return null;

            string cookieHeader = null;
            string authority = null;
            string scheme = null;
            foreach (string rawUrl in qualitys.Values.Distinct(StringComparer.Ordinal))
            {
                if (!Uri.TryCreate(rawUrl?.Replace("#.m3u8", string.Empty), UriKind.Absolute, out var mediaUri) ||
                    (mediaUri.Scheme != Uri.UriSchemeHttp && mediaUri.Scheme != Uri.UriSchemeHttps))
                    return null;
                string currentAuthority = mediaUri.GetLeftPart(UriPartial.Authority);
                if (authority == null)
                {
                    authority = currentAuthority;
                    scheme = mediaUri.Scheme;
                }
                else if (!string.Equals(authority, currentAuthority, StringComparison.OrdinalIgnoreCase) ||
                         !string.Equals(scheme, mediaUri.Scheme, StringComparison.OrdinalIgnoreCase))
                    return null;

                var cookies = await page.Context.CookiesAsync(new[] { mediaUri.AbsoluteUri }).ConfigureAwait(false);
                string scopedCookie = string.Join("; ", cookies
                    .OrderBy(cookie => cookie.Name, StringComparer.Ordinal)
                    .ThenBy(cookie => cookie.Value, StringComparer.Ordinal)
                    .Select(cookie => cookie.Name + "=" + cookie.Value));
                if (cookieHeader == null)
                    cookieHeader = scopedCookie;
                else if (!string.Equals(cookieHeader, scopedCookie, StringComparison.Ordinal))
                    return null;
            }

            string origin = document.GetLeftPart(UriPartial.Authority);
            var headers = HeadersModel.Init(("accept", "*/*"), ("origin", origin), ("referer", documentUri));
            headers.Add(new HeadersModel("user-agent", browserUserAgent));
            if (!string.IsNullOrWhiteSpace(cookieHeader))
                headers.Add(new HeadersModel("cookie", cookieHeader));
            return headers;
        }

` + output.slice(captureEnd);
  const unusedPageHeaders = `        List<HeadersModel> FilterStreamHeaders(IPage page)
        {
            return HeadersModel.Init(
                ("accept", "*/*"),
                ("origin", page.Url is string current && current.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? Regex.Match(current, "^(https?://[^/]+)", RegexOptions.IgnoreCase).Groups[1].Value : string.Empty),
                ("referer", page.Url)
            ).Where(h => !string.IsNullOrWhiteSpace(h.val)).ToList();
        }

`;
  const unusedHeadersAt = output.indexOf(unusedPageHeaders);
  if (unusedHeadersAt < 0 || output.indexOf(unusedPageHeaders, unusedHeadersAt + unusedPageHeaders.length) >= 0) {
    throw new Error("Lampac 1.81.0 obsolete page-header helper anchor mismatch");
  }
  output = output.slice(0, unusedHeadersAt) + output.slice(unusedHeadersAt + unusedPageHeaders.length);
  if (output.includes('log += $"{result}')) throw new Error("Unsafe full HTML logging remains");
  if (output.includes("log += $\"\\nex: {ex}")) throw new Error("Unsafe exception logging remains");
  return output;
}

export function patchVideoDbService(source) {
  if (source.includes(VIDEODB_QUALITY_MARKER)) throw new Error("VideoDB movie qualities patch already applied");

  const replacements = [
    [
      `                            file.Contains("2160p") ? "2160" : file.Contains("1080p") ? "1080" : file.Contains("720p") ? "720" : "480"`,
      `                            m.Groups[1].Value == "Авто" ? "auto" : m.Groups[1].Value`,
    ],
    [
      `                    mtpl.Append(\n                        pl.title,\n                        pl.streams[0].link + args,\n                        quality: pl.streams[0].quality\n                    );`,
      `                    // ${VIDEODB_QUALITY_MARKER}: retain each concrete file URL as its own selectable quality.\n                    var streamquality = new StreamQualityTpl(pl.streams, link => link + args);\n                    if (streamquality.IsEmpty)\n                        continue;\n\n                    var selected = streamquality.Firts();\n                    mtpl.Append(\n                        pl.title,\n                        selected.link,\n                        streamquality: streamquality,\n                        quality: selected.quality\n                    );`,
    ],
  ];

  let output = source;
  for (const [index, [anchor, replacement]] of replacements.entries()) {
    const first = output.indexOf(anchor);
    if (first < 0 || output.indexOf(anchor, first + anchor.length) >= 0) {
      throw new Error(`Lampac 1.81.0 VideoDB Service source anchor mismatch at ${index}`);
    }
    output = output.slice(0, first) + replacement + output.slice(first + anchor.length);
  }
  if (output.includes('file.Contains("2160p") ? "2160"'))
    throw new Error("VideoDB global movie quality label remains");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node patch-zetflix-diagnostics.mjs /lampac/module/OnlineRUS/Zetflix/Controller.cs");
  const original = readFileSync(target, "utf8");
  const videoDbService = resolve(dirname(target), "../VideoDB/Service.cs");
  const patchedVideoDb = patchVideoDbService(readFileSync(videoDbService, "utf8"));
  const patchedController = patchController(original);
  writeFileSync(videoDbService, patchedVideoDb);
  writeFileSync(target, patchedController);
}
