import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "[ZetflixDiag]";
const replacements = [
  [
    '            string log = $"{HttpContext.Request.Path.Value}\\n\\nstart init\\n";',
    '            Console.WriteLine("[ZetflixDiag] stage=index_start");',
  ],
  [
    '                    if (!result.Contains("new Playerjs"))\n                        return null;',
    '                    if (!result.Contains("new Playerjs"))\n                    {\n                        Console.WriteLine("[ZetflixDiag] stage=http_playerjs_missing");\n                        return null;\n                    }\n\n                    Console.WriteLine("[ZetflixDiag] stage=http_playerjs_present");',
  ],
  [
    '                string result = string.IsNullOrEmpty(PHPSESSID) ? null : await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: headers);',
    '                string result = string.IsNullOrEmpty(PHPSESSID) ? null : await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: headers);\n                if (string.IsNullOrEmpty(PHPSESSID))\n                    Console.WriteLine("[ZetflixDiag] stage=http_skipped_no_session");\n                else if (result == null)\n                    Console.WriteLine("[ZetflixDiag] stage=http_empty");\n                else if (result.StartsWith("<script>(function"))\n                    Console.WriteLine("[ZetflixDiag] stage=http_challenge");',
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
    '                        if (!result.Contains("new Playerjs"))\n                            return null;\n\n                        return result;',
    '                        if (!result.Contains("new Playerjs"))\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=browser_playerjs_missing");\n                            return null;\n                        }\n\n                        Console.WriteLine("[ZetflixDiag] stage=browser_playerjs_present");\n                        return result;',
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
  if (output.includes('log += $"{result}')) throw new Error("Unsafe full HTML logging remains");
  if (output.includes("log += $\"\\nex: {ex}")) throw new Error("Unsafe exception logging remains");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node patch-zetflix-diagnostics.mjs /lampac/module/OnlineRUS/Zetflix/Controller.cs");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, patchController(original));
}
