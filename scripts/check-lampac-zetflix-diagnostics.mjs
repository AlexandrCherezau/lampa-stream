import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { MOVIE_FRAME_RESOURCES_SCRIPT, patchController, SERIAL_FRAME_DOCUMENT_SCRIPT } from "../infrastructure/lampac/patch-zetflix-diagnostics.mjs";

const dockerfile = readFileSync(new URL("../infrastructure/lampac/Dockerfile.vercel", import.meta.url), "utf8");
const launcher = readFileSync(new URL("../infrastructure/lampac/start-vercel.sh", import.meta.url), "utf8");
const patchCall = "patch-zetflix-diagnostics.mjs /lampac/module/OnlineRUS/Zetflix/Controller.cs";
assert.ok(dockerfile.includes("COPY infrastructure/lampac/patch-zetflix-diagnostics.mjs"));
assert.ok(dockerfile.includes(patchCall));
assert.ok(dockerfile.indexOf(patchCall) < dockerfile.indexOf("Core.dll >/tmp/lampac-module-prewarm.log"));

const zetflixPath = "/tmp/lampac-native-1.81.0/module/OnlineRUS/Zetflix/Controller.cs";
const zetflixServicePath = "/tmp/lampac-native-1.81.0/module/OnlineRUS/Zetflix/Service.cs";
const httpSourcePath = "/tmp/lampac-zetflix-research/Shared/Services/HTTP/Http.cs";
const baseControllerPath = "/tmp/lampac-zetflix-research/Shared/Controllers/BaseOnlineController.cs";
const hybridCachePath = "/tmp/lampac-zetflix-research/Shared/Services/Hybrid/IHybridCache.cs";
const httpPath = "/tmp/lampac-zetflix-research/Shared/Services/HTTP/Http.cs";
const browserCookieExamplePath = "/tmp/lampac-zetflix-research/Modules/Music/Providers/Audio/Z3Fm/Z3FmSupport.cs";
const sourcePath = process.env.LAMPAC_ZETFLIX_SOURCE || zetflixPath;
if (!existsSync(sourcePath)) throw new Error(`Pinned Lampac Zetflix source required at ${sourcePath}; set LAMPAC_ZETFLIX_SOURCE to its path`);
if (!existsSync(zetflixServicePath)) throw new Error(`Pinned Lampac Zetflix Service source required at ${zetflixServicePath}`);
if (!existsSync(httpSourcePath)) throw new Error(`Pinned Lampac HTTP source required at ${httpSourcePath}`);
if (!existsSync(baseControllerPath)) throw new Error(`Pinned Lampac BaseOnlineController source required at ${baseControllerPath}`);
if (!existsSync(hybridCachePath)) throw new Error(`Pinned Lampac IHybridCache source required at ${hybridCachePath}`);
if (!existsSync(browserCookieExamplePath)) throw new Error(`Pinned Lampac browser-cookie API example required at ${browserCookieExamplePath}`);
const zetflix = readFileSync(sourcePath, "utf8");
const zetflixService = readFileSync(zetflixServicePath, "utf8");
const httpSource = readFileSync(httpSourcePath, "utf8");
const baseController = readFileSync(baseControllerPath, "utf8");
const hybridCache = readFileSync(hybridCachePath, "utf8");
const httpApi = readFileSync(httpPath, "utf8");
const browserCookieExample = readFileSync(browserCookieExamplePath, "utf8");
assert.match(httpApi, /Task<\(string content, HttpResponseMessage response\)> BaseGet\(/);
assert.match(hybridCache, /TItem Set<TItem>\(string key, TItem value, TimeSpan absoluteExpirationRelativeToNow/);
assert.match(browserCookieExample, /IReadOnlyList<BrowserContextCookiesResult>/);
assert.match(browserCookieExample, /page\.Context\.CookiesAsync\(\)/);
assert.match(zetflixService, /Regex\.Match\(html, "file:/);
assert.doesNotMatch(zetflixService, /if \(!html\.Contains\("new Playerjs"\)\)/);
assert.match(httpSource, /public const string UserAgent =/);
assert.match(zetflix, /if \(checksearch\)\s*\{\s*if \(PlaywrightBrowser\.Status == PlaywrightStatus\.disabled\)\s*return OnError\(\);\s*return Content\("data-json="\);/);
assert.match(baseController, /public ActionResult OnError\(int statusCode = 503/);
const readinessProbe = "http://127.0.0.1:9118/lite/zetflix?checksearch=true&kinopoisk_id=1";
assert.ok(launcher.includes(readinessProbe));
assert.ok(launcher.includes(`if response="$(curl -fsS --max-time 1 '${readinessProbe}' 2>/dev/null)" \\`));
assert.ok(launcher.includes("[ \"$response\" = 'data-json=' ]"));
assert.ok(launcher.includes("Lampac native Playwright did not become ready within 120 seconds"));
assert.ok(launcher.indexOf(readinessProbe) < launcher.indexOf('touch "$SOURCE_ENGINE_READY_FILE"'));

const source = zetflix;
const patched = patchController(source);
assert.equal(MOVIE_FRAME_RESOURCES_SCRIPT, '() => performance.getEntriesByType("resource").map(r => r.name)');
assert.match(patched, /zetflix:live_movie:v5:\{ztfhost\?\.TrimEnd\('\/'\)\}:\{kinopoisk_id\}:\{season\}/,
  "movie cache must be invalidated and host-scoped for per-frame sources");
assert.ok(!patched.includes('zetflix:live_movie:v4:'));
assert.ok(patched.includes('zeflix:gohost:v5:{host}'));
assert.ok(!patched.includes('zeflix:gohost:v4:'));
const hostPattern = patched.match(/Regex\.IsMatch\(uri\.Host, @"([^"\n]+)"/);
assert.ok(hostPattern, 'Zetflix redirect hosts must use the constrained date-host pattern');
const zetflixHostRegex = new RegExp(hostPattern[1], 'i');
for (const host of ['1jan.zet-flix.online', '7apr.zet-flix.online', '12oct.zet-flix.online', '31dec.zet-flix.online'])
  assert.equal(zetflixHostRegex.test(host), true, `valid dated Zetflix host should match: ${host}`);
for (const host of ['0jan.zet-flix.online', '32oct.zet-flix.online', '12foo.zet-flix.online', '12oct.evil.example', '12-oct.zet-flix.online', 'x12oct.zet-flix.online'])
  assert.equal(zetflixHostRegex.test(host), false, `invalid or unrelated host should not match: ${host}`);
assert.ok(patched.includes('(uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)'));
assert.ok(patched.includes('string selectedHost = Uri.TryCreate(ztfhost, UriKind.Absolute, out var selectedHostUri) ? selectedHostUri.DnsSafeHost : string.Empty;'));
assert.ok(patched.includes('stage=host_selected host=" + selectedHost'));
const movieFallbackStart = patched.indexOf('if (serial != 1 && ((content?.movie == true && NeedLiveMovieFallback(content)) || content?.pl == null))');
const movieFallbackEnd = patched.indexOf('if (content?.pl == null)', movieFallbackStart);
assert.ok(movieFallbackStart >= 0 && movieFallbackEnd > movieFallbackStart);
const movieFallback = patched.slice(movieFallbackStart, movieFallbackEnd);
assert.match(movieFallback, /if \(!liveMovie\.IsEmpty\)[\s\S]*?return ContentTpl\(liveMovie\);[\s\S]*?return OnError\(\);/,
  'failed required live-movie fallback must not fall through to stale provider content');
assert.ok(patched.includes(`frame.EvaluateAsync<string[]>(${JSON.stringify(MOVIE_FRAME_RESOURCES_SCRIPT)})`));
assert.ok(patched.includes(`frame.EvaluateAsync<string>(${JSON.stringify(SERIAL_FRAME_DOCUMENT_SCRIPT)})`));
assert.ok(patched.includes('async ValueTask<List<LiveMovieSource>> CaptureMovieWithBrowser(IPage page, string targetUri)'));
assert.ok(!patched.includes('CaptureMovieWithBrowser(page, playerUri, qualitys'));
assert.ok(!patched.includes('FilterStreamHeaders(page)'));
assert.ok(!patched.includes('List<HeadersModel> FilterStreamHeaders(IPage page)'));
const movieCaptureFlowStart = patched.indexOf('async ValueTask<List<LiveMovieSource>> CaptureLiveMovieInternal(');
const movieCaptureFlowEnd = patched.indexOf('[HttpGet]', movieCaptureFlowStart);
assert.ok(movieCaptureFlowStart >= 0 && movieCaptureFlowEnd > movieCaptureFlowStart);
const movieCaptureFlow = patched.slice(movieCaptureFlowStart, movieCaptureFlowEnd);
assert.doesNotMatch(movieCaptureFlow, /bool captured\s*=|var qualitys\s*=\s*new Dictionary<int, string>\(\)|if \(!captured \|\| qualitys\.Count == 0\)|FilterStreamHeaders\(page\)/,
  'the old single-map browser collector must be removed in full');
assert.ok(movieCaptureFlow.indexOf('ValidateMovieManifests(browserSources)') < movieCaptureFlow.indexOf('CaptureMovieWithBrowser(page, iframeUri)'));
assert.ok(movieCaptureFlow.includes('(validBrowserSources == null || validBrowserSources.Count == 0) && !string.IsNullOrWhiteSpace(iframeUri)'),
  'the iframe fallback must run after an invalid player-document manifest result');
assert.ok(patched.includes('TryParseObrutPlayerRoot(frameHtml, out JsonObject movieRoot)'));
assert.ok(patched.includes('FindObrutMovieVoices(movieRoot)'));
assert.ok(patched.includes('ParseObrutQualityMap(voice.file)'));
assert.ok(patched.includes('foreach (var frame in page.Frames.ToArray())'));
assert.ok(patched.includes('if (!hasVoiceCatalog)'));
assert.ok(patched.includes('string sourceKey = documentUri + "|" + voiceTitle'));
assert.ok(patched.includes('string sourceKey = documentUri + "|По умолчанию"'));
assert.ok(patched.includes('sources[sourceKey] = new LiveMovieSource { title = voiceTitle'));
assert.ok(patched.includes('sources[sourceKey] = new LiveMovieSource { title = "По умолчанию"'));
assert.ok(!patched.includes('combinedQualitys') && !patched.includes('existingSource.qualitys'));
assert.ok(patched.includes('string fingerprint = documentUri + "|" + voiceTitle'));
assert.ok(patched.includes('string fingerprint = documentUri + "|По умолчанию|"'));
assert.ok(patched.includes('await BuildMovieSourceHeaders('));
assert.ok(patched.includes('page.Context.CookiesAsync(new[] { mediaUri.AbsoluteUri })'));
assert.ok(patched.includes('mediaUri.GetLeftPart(UriPartial.Authority)'));
assert.ok(patched.includes('string.Equals(cookieHeader, scopedCookie, StringComparison.Ordinal)'));
assert.ok(patched.includes('navigator.userAgent'));
assert.ok(patched.includes('ValidateMovieManifests(browserSources)'));
const movieQualityPattern = patched.match(/var quality = Regex\.Match\(url \?\? string\.Empty, @"([^"\n]+)"/);
assert.ok(movieQualityPattern, "patched movie browser capture must retain its quality matcher");
const movieQualityRegex = new RegExp(movieQualityPattern[1], "i");
for (const height of [240, 360, 480, 720, 1080, 1440, 2160]) {
  const mediaUrl = `https://cdn.example/video/${height}.mp4:hls:manifest.m3u8?session=fixture`;
  assert.equal(movieQualityRegex.exec(mediaUrl)?.[1], String(height), `normal ${height}p manifest should match`);
}
for (const rejectedUrl of [
  "https://cdn.example/video/720.mp4:manifest.m3u8?session=fixture",
  "https://cdn.example/video/720Xmp4:hls:manifest.m3u8?session=fixture",
  "https://foreign.example/video/720.mp4:hls:manifest.m3u8.evil",
  "https://cdn.example/video/trailer.mp4?session=fixture",
]) {
  assert.equal(movieQualityRegex.test(rejectedUrl), false, `nonmanifest resource should not match: ${rejectedUrl}`);
}
assert.ok(patched.includes('hybridCache.TryGetValue($"zetfix:view:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{season}:{proxyManager?.CurrentProxyIp}"'));
assert.ok(patched.includes('InvokeCache($"zetfix:view:v2:{ztfhost?.TrimEnd(\'/\')}:{kinopoisk_id}:{rs}:{proxyManager?.CurrentProxyIp}"'));
assert.ok(!patched.includes('zetfix:view:{'), 'HTML cache reader and writer must use the same host-scoped version');
assert.match(patched, /live_serial_tpl:v2:\{ztfhost\?\.TrimEnd\('\/'\)\}:\{kinopoisk_id\}:\{season\}/);
assert.match(patched, /zetfix:view:v2:\{ztfhost\?\.TrimEnd\('\/'\)\}:\{kinopoisk_id\}:\{rs\}/,
  "the cached catalog must be scoped to the Zetflix host");
assert.match(patched, /live_serial:v9:\{ztfhost\?\.TrimEnd\('\/'\)\}:\{kinopoisk_id\}:\{season\}:\{episode\}:\{NormalizeObrutNodeText\(voice\)\}:\{proxyManager\?\.CurrentProxyIp\}/);
assert.ok(patched.includes('InvokeCache(SerialVideoCacheKey(ztfhost, kinopoisk_id, s, e, t), 300,') &&
  patched.includes('async () => await CaptureLiveSerialEpisodeInternal(ztfhost, kinopoisk_id, s, t, e)'));
assert.ok(!patched.includes('zetflix:live_serial:v8:') && !patched.includes('zetflix:live_serial_tpl:v1:'));
assert.ok(patched.includes('WarmSerialVideoCache(direct, ztfhost, kinopoisk_id, season, documentUri, userAgent, null, browserPage)'));
assert.ok(patched.includes('WarmSerialVideoCache(iframeEmbed, ztfhost, kinopoisk_id, season, documentUri, Http.UserAgent, iframeCookies, null)'));
assert.ok(patched.includes('WarmSerialVideoCache(direct, ztfhost, kinopoisk_id, season, frameDocumentUri, browserUserAgent, null, page)'));
assert.ok(patched.includes(`frame.EvaluateAsync<string>(${JSON.stringify(SERIAL_FRAME_DOCUMENT_SCRIPT)})`));
assert.ok(patched.includes('nativeIndexCookies.Add(new Uri(uri), new System.Net.Cookie("PHPSESSID", PHPSESSID))'),
  "the session cookie must stay scoped to the initial provider URI");
assert.ok(patched.includes('Http.BaseGet(uri, proxy: proxy, headers: headers, cookieContainer: nativeIndexCookies)'));
assert.ok(patched.includes('nativeIndexResult.response?.RequestMessage?.RequestUri?.AbsoluteUri ?? uri'));
assert.ok(patched.includes('headers.LastOrDefault(header => string.Equals(header.name, "user-agent", StringComparison.OrdinalIgnoreCase))?.val'));
assert.ok(patched.includes('serial == 1 && rs > 0 && nativeIndexEmbed?.pl?.Count > 0'));
assert.ok(patched.includes('WarmSerialVideoCache(nativeIndexEmbed, ztfhost, kinopoisk_id, rs, nativeIndexUri, nativeUserAgent, nativeIndexCookies, null)'));
assert.ok(patched.includes('serial == 1 && rs > 0 && browserIndexEmbed?.pl?.Count > 0'));
assert.ok(patched.includes('WarmSerialVideoCache(browserIndexEmbed, ztfhost, kinopoisk_id, rs, page.Url, browserUserAgent, null, page)'));
assert.ok(patched.includes('cookieContainer: iframeCookies'));
assert.ok(patched.includes('iframeResult.response?.RequestMessage?.RequestUri?.AbsoluteUri ?? iframeUri'));
assert.ok(patched.includes('var playerResult = await Http.BaseGet(playerUri'));
assert.ok(patched.includes('string actualPlayerUri = playerResult.response?.RequestMessage?.RequestUri?.AbsoluteUri ?? playerUri'));
assert.ok(patched.includes('TrySerialEmbedFromPlayerHtml(playerResult.content, actualPlayerUri, ztfhost, kinopoisk_id, season)'));
assert.ok(patched.includes('new Uri(playerDocument, iframeSrc).AbsoluteUri'),
  "relative iframe source must resolve against the final player document URI");
const cacheHelperStart = patched.indexOf('async ValueTask WarmSerialVideoCache(');
const cacheHelperEnd = patched.indexOf('EmbedModel BuildSerialEmbedFromHtml(', cacheHelperStart);
assert.ok(cacheHelperStart >= 0 && cacheHelperEnd > cacheHelperStart);
const cacheHelper = patched.slice(cacheHelperStart, cacheHelperEnd);
assert.ok(cacheHelper.includes('episode.file') && cacheHelper.includes('episode://'));
assert.ok(cacheHelper.includes('ParsePlayerjsQualityMap(file)') && cacheHelper.includes('ParseObrutQualityMap(file)'));
assert.ok(cacheHelper.includes('voice.folder') && cacheHelper.includes('NormalizeObrutNodeText(voiceName)'));
assert.ok(cacheHelper.includes('hybridCache.Set(SerialVideoCacheKey(') && cacheHelper.includes('(qualitys, headers), cacheTime(300)'));
assert.ok(cacheHelper.includes('browserPage.Context.CookiesAsync(new[] { mediaUri.AbsoluteUri })'));
assert.ok(cacheHelper.includes('Http.UserAgent') && cacheHelper.includes('new HeadersModel("user-agent"'));
assert.ok(cacheHelper.includes('media.GetLeftPart(UriPartial.Authority)') && cacheHelper.includes('sameAuthority'));
assert.ok(cacheHelper.includes('getScopedCookieHeader(mediaUri)') && cacheHelper.includes('sameCookies') &&
  cacheHelper.includes('if (!sameCookies)\n                        continue;'),
  "shared headers may only be cached when all quality URLs have identical scoped cookies");
assert.doesNotMatch(cacheHelper, /voice\?\.title|episode\?\.comment/,
  "Lampac RootObject and Folder are value types");
assert.ok(cacheHelper.includes('Console.WriteLine("[ZetflixDiag] stage=video_cache_warmed count=" + warmed)'));
for (const stage of ['video_cache_enter', 'video_cache_embed_rejected', 'video_cache_document_rejected']) {
  assert.ok(cacheHelper.includes(`Console.WriteLine("[ZetflixDiag] stage=${stage}");`));
}
assert.ok(patched.includes('stage=serial_template_cache_lookup hit=" + templateHit'));
for (const source of ['parent', 'iframe', 'frame']) {
  assert.ok(patched.includes(`Console.WriteLine("[ZetflixDiag] stage=serial_${source}_document_capture");`));
}
for (const stage of [
  'movie_capture_start', 'movie_fotpro_count count=', 'movie_fotpro_validated_count count=',
  'movie_iframe_present value=', 'movie_obrut_count count=', 'movie_obrut_validated_count count=',
  'movie_browser_player captured=', 'movie_browser_iframe captured=',
  'movie_http_exception type=', 'movie_browser_exception type=',
]) assert.ok(patched.includes(`[ZetflixDiag] stage=${stage}`), `missing safe movie diagnostic stage ${stage}`);
assert.doesNotMatch(patched, /stage=movie_[^"\n]*(?:url|cookie|header|html|message)/i,
  'movie diagnostics must not include URLs, headers, cookies, or response content');
assert.equal((patched.match(/EvaluateAsync<string>\("\(\) => navigator\.userAgent"\)/g) || []).length, 3,
  "browser UA should be captured once per serial-parent, serial-frame, and movie-browser path");
assert.match(cacheHelper, /Console\.WriteLine\("\[ZetflixDiag\] stage=video_cache_warmed count=" \+ warmed\);/,
  "cache warming reports only the numeric number of tuple entries created");
assert.doesNotMatch(cacheHelper, /PHPSESSID|Console\.Error|Console\.WriteLine\((?!"\[ZetflixDiag\] stage=video_cache_(?:warmed count="|(?:enter|embed_rejected|document_rejected)"\);))/,
  "cache warming must not log content or credentials");
assert.ok(patched.includes("[ZetflixDiag] stage=page_null"));
assert.ok(patched.includes("[ZetflixDiag] stage=navigation_exception type="));
assert.ok(patched.includes("[ZetflixDiag] stage=browser_exception type="));
assert.ok(patched.includes("[ZetflixDiag] stage=serial_fallback_result count="));
const httpRootFailure = patched.indexOf('if (!TryParseObrutPlayerRoot(iframeHtml, out JsonObject root))');
const httpPlayerjsAttempt = patched.indexOf('var legacyQualitys = ParsePlayerjsSerialEpisode(iframeHtml, episode, voice);');
const browserHelperNames = ['TryObrutSerialWithBrowser', 'TryParseBrowserSerialDocument', 'BuildBrowserStreamHeaders'];
assert.ok(httpRootFailure >= 0 && httpPlayerjsAttempt > httpRootFailure,
  "the native file: parser must run after the HTTP Obrut parser fails");
assert.ok(patched.includes('if (legacyQualitys.Count > 0)') && patched.includes('return default;'),
  "HTTP file-parser failure must stop without a blind browser retry");
for (const helper of browserHelperNames) assert.ok(!patched.includes(helper), `removed unproductive helper remains: ${helper}`);
assert.ok(patched.includes('new ZetflixInvoke(null, null, init.hls, null, link => link);'));
assert.match(zetflixService, /Regex\.Match\(html, "file:/);
assert.doesNotMatch(zetflixService, /if \(!html\.Contains\("new Playerjs"\)\)/);
assert.match(httpSource, /public const string UserAgent =/);
const playerjsHelperStart = patched.indexOf('Dictionary<int, string> ParsePlayerjsSerialEpisode(string html, int episode, string voice)');
const playerjsHelperEnd = patched.indexOf('List<HeadersModel> BuildNativeStreamHeaders', playerjsHelperStart);
assert.ok(playerjsHelperStart >= 0 && playerjsHelperEnd > playerjsHelperStart);
assert.doesNotMatch(patched.slice(playerjsHelperStart, playerjsHelperEnd), /html\.Contains\("new Playerjs"\)/,
  "serial helper must use Lampac's file: parser without requiring a Playerjs marker");
assert.ok(patched.includes('bool voiceMatch = !string.IsNullOrWhiteSpace(normalizedVoice) && plVoice == normalizedVoice;'),
  "normal Playerjs resolution must require the selected voice exactly");
assert.ok(patched.includes('if (current == wanted)'));
assert.ok(!patched.includes('voiceNode ??= voices[0]'), "wrong voice must not silently fall back to the first voice");
assert.ok(!patched.includes('if (embed.pl.Count > 0 && IsGenericVoiceLabel(normalizedVoice))'),
  "Playerjs must not substitute the first voice for a generic or missing selection");
assert.ok(patched.includes('BuildNativeStreamHeaders(iframeUri, legacyQualitys.First().Value, cookieContainer)'));
assert.ok(patched.includes('BuildCookieHeader(cookieContainer, mediaUri)'), "cookies remain scoped to the selected stream URL");
assert.ok(patched.includes('stage=playerjs_quality_count count=0'));
const originalPlayerjsFetch = '                    html = string.IsNullOrEmpty(PHPSESSID) ? null :\n                        await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: reqHeaders);';
assert.ok(patched.includes(originalPlayerjsFetch), "diagnostics must preserve native Playerjs fetch behavior");
assert.ok(patched.indexOf("stage=playerjs_fetch_skipped_no_session") < patched.indexOf(originalPlayerjsFetch));
for (const stage of [
  "video_start", "video_playwright_disabled", "video_request_blocked", "video_no_quality",
  "video_quality_count count=", "player_page_empty", "player_iframe_missing", "player_iframe_other",
  "player_iframe_obrut", "obrut_no_quality", "obrut_iframe_empty", "obrut_root_parse_failed",
  "obrut_file_missing", "obrut_quality_missing", "playerjs_fetch_skipped_no_session",
  "playerjs_html_empty", "playerjs_marker_missing", "playerjs_embed_empty", "playerjs_no_matching_quality",
  "obrut_seasons_missing", "obrut_season_missing", "obrut_episode_list_missing", "obrut_episode_missing",
  "obrut_voice_match_missing", "obrut_voice_match_found",
]) assert.ok(patched.includes(`[ZetflixDiag] stage=${stage}`), `missing safe Video diagnostic stage ${stage}`);
assert.ok(!patched.includes("string log ="));
assert.ok(!patched.includes("log += "));
const diagnosticWrites = [...patched.matchAll(/Console\.WriteLine\(([^;]+)\);/g)].map((match) => match[1]);
assert.ok(diagnosticWrites.length >= 10);
for (const line of diagnosticWrites) {
  assert.ok(line.includes("[ZetflixDiag]"));
  assert.doesNotMatch(line, /\+.*(HttpContext|PHPSESSID|result|href|title|cookie|ex\.Message|ex\.ToString)/);
}
assert.ok(!patched.includes('log += $"{result}'));
assert.ok(!patched.includes("log += $\"\\nex: {ex}"));
assert.throws(() => patchController(source.replace('string log = ', 'string logs = ')), /anchor mismatch/);
assert.throws(() => patchController(patched), /already applied/);

const tempDir = mkdtempSync(join(tmpdir(), "lampac-zetflix-diag-"));
try {
  const gateStart = launcher.lastIndexOf("attempt=0", launcher.indexOf(readinessProbe));
  const gateEnd = launcher.indexOf('chmod 0600 "$SOURCE_ENGINE_READY_FILE"');
  const gate = launcher.slice(gateStart, gateEnd);
  const readinessFile = join(tempDir, "ready");
  const attemptsFile = join(tempDir, "attempts");
  const mock = `set -eu
node_pid=$$; lampac_pid=$$
sleep() { :; }
curl() {
  count=0; [ ! -f "$ATTEMPTS_FILE" ] || count=$(cat "$ATTEMPTS_FILE")
  count=$((count + 1)); printf '%s' "$count" > "$ATTEMPTS_FILE"
  [ ! -f "$SOURCE_ENGINE_READY_FILE" ] || exit 90
  case "$count" in
    1) return 22 ;;
    2) printf pong ;;
    *) printf data-json= ;;
  esac
}
`;
  execFileSync("sh", ["-c", mock + gate], {
    env: { ...process.env, SOURCE_ENGINE_READY_FILE: readinessFile, ATTEMPTS_FILE: attemptsFile },
  });
  assert.ok(existsSync(readinessFile));
  assert.equal(readFileSync(attemptsFile, "utf8"), "3");
  const target = join(tempDir, "Controller.cs");
  writeFileSync(target, source);
  execFileSync(process.execPath, [fileURLToPath(new URL("../infrastructure/lampac/patch-zetflix-diagnostics.mjs", import.meta.url)), target]);
  assert.equal(readFileSync(target, "utf8"), patched);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("../infrastructure/lampac/patch-zetflix-diagnostics.mjs", import.meta.url)), target], { stdio: "ignore" }));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("Lampac Zetflix diagnostic patch checks passed");
