import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function replaceOnce(source, before, after, label) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error(`Lampac 1.81.0 ${label} anchor mismatch`);
  }
  return source.slice(0, at) + after + source.slice(at + before.length);
}

const MOVIE_MATCH_HELPER = String.raw`    static bool IsPlatformMovieMatch(string candidateTitle, long duration, string title, string originalTitle, short year, int runtimeMinutes)
    {
        string name = NormalizePlatformMovieName(candidateTitle);
        if (string.IsNullOrWhiteSpace(name))
            return false;

        string NormalizePlatformMovieName(string value)
        {
            return System.Text.RegularExpressions.Regex.Replace(value ?? string.Empty, @"[^\p{L}\p{N}]+", " ").Trim().ToLowerInvariant().Replace('ё', 'е');
        }

        bool hasTitlePrefix(string expected, out string suffix)
        {
            string prefix = NormalizePlatformMovieName(expected);
            if (string.IsNullOrWhiteSpace(prefix) || name.Length < prefix.Length || !name.StartsWith(prefix, StringComparison.Ordinal))
            {
                suffix = null;
                return false;
            }
            if (name.Length > prefix.Length && name[prefix.Length] != ' ')
            {
                suffix = null;
                return false;
            }
            suffix = name.Length == prefix.Length ? string.Empty : name.Substring(prefix.Length).TrimStart();
            return true;
        }

        if (!hasTitlePrefix(title, out string suffix) && !hasTitlePrefix(originalTitle, out suffix))
            return false;

        if (runtimeMinutes > 0)
        {
            double expectedSeconds = runtimeMinutes * 60d;
            double toleranceSeconds = Math.Max(120d, expectedSeconds * 0.1d);
            if (Math.Abs(duration - expectedSeconds) > toleranceSeconds)
                return false;
        }
        else if (duration < 3000)
        {
            return false;
        }

        if (name.Contains("трейлер") || name.Contains("trailer") || name.Contains("премьера") || name.Contains("обзор")
            || name.Contains("сезон") || name.Contains("сериал") || name.Contains("серия") || name.Contains("серий"))
            return false;

        var years = System.Text.RegularExpressions.Regex.Matches(suffix, @"(?<!\d)(?:19|20)\d{2}(?!\d)");
        bool hasYear = years.Count > 0;
        if (!hasYear || year == 0)
        {
            if (runtimeMinutes <= 0)
                return false;
        }
        else
        {
            foreach (System.Text.RegularExpressions.Match match in years)
                if (match.Value != year.ToString())
                    return false;
        }

        return true;
    }

`;

const VK_QUERY_BLOCK = String.raw`            async Task<List<CatalogVideo>> search(string query)
            {
                string url = $"{init.host}/method/catalog.getVideoSearchWeb2?v=5.264&client_id={client_id}";
                string data = $"screen_ref=search_video_service&input_method=keyboard_search_button&q={HttpUtility.UrlEncode(query)}&access_token={access_token}";
                var result = await httpHydra.Post<Root>(url, data, textJson: true);
                return (result?.response?.catalog_videos ?? new List<CatalogVideo>())
                    .Where(item => item?.video != null && IsPlatformMovieMatch(item.video.title, item.video.duration, title, original_title, year, runtimeMinutes)
                        && item.video.files != null
                        && (!string.IsNullOrEmpty(item.video.files.mp4_2160) || !string.IsNullOrEmpty(item.video.files.mp4_1440)
                            || !string.IsNullOrEmpty(item.video.files.mp4_1080) || !string.IsNullOrEmpty(item.video.files.mp4_720)
                            || !string.IsNullOrEmpty(item.video.files.mp4_480) || !string.IsNullOrEmpty(item.video.files.mp4_360)
                            || !string.IsNullOrEmpty(item.video.files.mp4_240) || !string.IsNullOrEmpty(item.video.files.mp4_144)
                            || !string.IsNullOrEmpty(item.video.files.hls)))
                    .OrderByDescending(item => item.video.files.mp4_2160 != null)
                    .ThenByDescending(item => item.video.files.mp4_1440 != null)
                    .ThenByDescending(item => item.video.files.mp4_1080 != null)
                    .ToList();
            }

            var queries = new List<string> { year > 0 ? $"{title} {year}" : title };
            if (year > 0 && !string.IsNullOrWhiteSpace(original_title) && !string.Equals(title, original_title, StringComparison.OrdinalIgnoreCase))
                queries.Add($"{original_title} {year}");
            if (year > 0)
                queries.Add(title);

            List<CatalogVideo> videos = new();
            foreach (string query in queries)
            {
                videos = await search(query);
                if (videos.Count > 0)
                    break;
            }
            if (videos.Count == 0)
                return e.Fail("catalog_videos");

            return e.Success(videos);`;

const VK_CACHE_ANCHOR = String.raw`        var cache = await InvokeCacheResult<List<CatalogVideo>>(ipkey($"vkmovie:view:{searchTitle}:{year}"), 20, textJson: true, onget: async e =>
        {
            if (init.httpversion == 2)
                httpHydra.RegisterHttp(http2Client);

            string url = $"{init.host}/method/catalog.getVideoSearchWeb2?v=5.264&client_id={client_id}";
            string data = $"screen_ref=search_video_service&input_method=keyboard_search_button&q={HttpUtility.UrlEncode($"{title} {year}")}&access_token={access_token}";

            var root = await httpHydra.Post<Root>(url, data, textJson: true);

            var videos = root?.response?.catalog_videos;
            if (videos == null || videos.Count == 0)
                return e.Fail("catalog_videos");

            return e.Success(
                videos
                    .OrderByDescending(i => i.video?.files?.mp4_2160 != null)
                    .ThenByDescending(i => i.video?.files?.mp4_1440 != null)
                    .ThenByDescending(i => i.video?.files?.mp4_1080 != null)
                    .ToList()
            );
        });`;

const VK_CACHE_REPLACEMENT = String.raw`        var cache = await InvokeCacheResult<List<CatalogVideo>>(ipkey($"vkmovie:view:{searchTitle}:{original_title}:{year}:{runtimeMinutes}"), 20, textJson: true, onget: async e =>
        {
            if (init.httpversion == 2)
                httpHydra.RegisterHttp(http2Client);

${VK_QUERY_BLOCK}
        });`;

const RUTUBE_QUERY_BLOCK = String.raw`            async Task<List<Result>> search(string query)
            {
                string uri = $"api/search/video/?content_type=video&duration=movie&query={HttpUtility.UrlEncode(query)}";
                var result = await httpHydra.Get<RootSearch>($"{init.host}/{uri}", textJson: true);
                var matches = new List<Result>();
                foreach (var movie in result?.results ?? new List<Result>())
                {
                    if (movie?.category?.id != 4 || movie.is_hidden || movie.is_deleted || movie.is_adult || movie.is_locked || movie.is_audio || movie.is_paid || movie.is_livestream)
                        continue;
                    if (!IsPlatformMovieMatch(movie.title, movie.duration, title, original_title, year, runtimeMinutes))
                        continue;
                    string name = SearchNameTo.Convert(movie.title);
                    if (name.Contains("трейлер") || name.Contains("trailer") || name.Contains("премьера") || name.Contains("обзор")
                        || name.Contains("сезон") || name.Contains("сериал") || name.Contains("серия") || name.Contains("серий"))
                        continue;
                    matches.Add(movie);
                }
                return matches;
            }

            var queries = new List<string> { year > 0 ? $"{title} {year}" : title };
            if (year > 0 && !string.IsNullOrWhiteSpace(original_title) && !string.Equals(title, original_title, StringComparison.OrdinalIgnoreCase))
                queries.Add($"{original_title} {year}");
            if (year > 0)
                queries.Add(title);

            List<Result> matches = new();
            foreach (string query in queries)
            {
                matches = await search(query);
                if (matches.Count > 0)
                    break;
            }
            if (matches.Count == 0)
                return e.Fail("content", refresh_proxy: true);

            return e.Success(matches);`;

const RUTUBE_CACHE_ANCHOR = String.raw`        var cache = await InvokeCacheResult<List<Result>>(memKey, TimeSpan.FromHours(4), textJson: true, onget: async e =>
        {
            string uri = $"api/search/video/?content_type=video&duration=movie&query={HttpUtility.UrlEncode($"{title} {year}")}";

            var root = await httpHydra.Get<RootSearch>($"{init.host}/{uri}", textJson: true);

            if (root?.results == null || root.results.Count == 0)
                return e.Fail("content", refresh_proxy: true);

            return e.Success(root.results);
        });`;

const RUTUBE_CACHE_REPLACEMENT = String.raw`        var cache = await InvokeCacheResult<List<Result>>(memKey, TimeSpan.FromHours(4), textJson: true, onget: async e =>
        {
${RUTUBE_QUERY_BLOCK}
        });`;

export function patchVkMovie(source) {
  if (source.includes("[PlatformMovies:VK]")) return source;
  source = replaceOnce(source,
    "public class VkMovieController : BaseOnlineController\n{\n",
    "public class VkMovieController : BaseOnlineController\n{\n" + MOVIE_MATCH_HELPER.replace("    static bool IsPlatformMovieMatch", "    // [PlatformMovies:VK]\n    static bool IsPlatformMovieMatch"),
    "VK helper");
  source = replaceOnce(source,
    "public async Task<ActionResult> Index(string title, string original_title, short year, byte serial, bool rjson = false)",
    "public async Task<ActionResult> Index(string title, string original_title, short year, byte serial, int runtimeMinutes = 0, bool rjson = false)",
    "VK runtimeMinutes parameter");
  source = replaceOnce(source, VK_CACHE_ANCHOR, VK_CACHE_REPLACEMENT, "VK search fallback");
  source = replaceOnce(source,
    "                if (video == null || video.files == null)\n                    continue;\n\n                string name = SearchNameTo.Convert(video.title);\n                if (name == null || !name.Contains(searchTitle))\n                    continue;\n\n                if (!(name.Contains(year.ToString()) || name.Contains((year + 1).ToString()) || name.Contains((year - 1).ToString())))\n                    continue;\n\n                if (video.duration < 3000)\n                    continue;",
    "                if (video == null || video.files == null || !IsPlatformMovieMatch(video.title, video.duration, title, original_title, year, runtimeMinutes))\n                    continue;\n\n                string name = SearchNameTo.Convert(video.title);",
    "VK exact movie filtering");
  source = replaceOnce(source,
    "                if (string.IsNullOrEmpty(video.files.mp4_2160) &&\n                    string.IsNullOrEmpty(video.files.mp4_1440) &&\n                    string.IsNullOrEmpty(video.files.mp4_1080) &&\n                    string.IsNullOrEmpty(video.files.mp4_720))\n                    continue;",
    "                if (string.IsNullOrEmpty(video.files.mp4_2160) && string.IsNullOrEmpty(video.files.mp4_1440)\n                    && string.IsNullOrEmpty(video.files.mp4_1080) && string.IsNullOrEmpty(video.files.mp4_720)\n                    && string.IsNullOrEmpty(video.files.mp4_480) && string.IsNullOrEmpty(video.files.mp4_360)\n                    && string.IsNullOrEmpty(video.files.mp4_240) && string.IsNullOrEmpty(video.files.mp4_144)\n                    && string.IsNullOrEmpty(video.files.hls))\n                    continue;",
    "VK playable quality check");
  source = replaceOnce(source,
    "                append(video.files.mp4_144, \"144p\");\n\n                if (streams.IsEmpty)",
    "                append(video.files.mp4_144, \"144p\");\n                if (streams.IsEmpty)\n                    append(video.files.hls, \"auto\");\n\n                if (streams.IsEmpty)",
    "VK HLS-only fallback");
  return source;
}

export function patchRutubeMovie(source) {
  if (source.includes("[PlatformMovies:RuTube]")) return source;
  source = replaceOnce(source,
    "public class RutubeMovieController : BaseOnlineController\n{\n",
    "public class RutubeMovieController : BaseOnlineController\n{\n" + MOVIE_MATCH_HELPER.replace("    static bool IsPlatformMovieMatch", "    // [PlatformMovies:RuTube]\n    static bool IsPlatformMovieMatch"),
    "Rutube helper");
  source = replaceOnce(source,
    "public async Task<ActionResult> Index(string title, string original_title, short year, byte serial)",
    "public async Task<ActionResult> Index(string title, string original_title, short year, byte serial, int runtimeMinutes = 0)",
    "Rutube runtimeMinutes parameter");
  source = replaceOnce(source,
    "if (searchTitle == null || year == 0 || serial == 1)",
    "if (searchTitle == null || serial == 1)",
    "Rutube no-year input");
  source = replaceOnce(source,
    'string memKey = $"rutubemovie:view:{searchTitle}:{year}:{(rch?.enable == true ? requestInfo.Country : "")}";',
    'string memKey = $"rutubemovie:view:{searchTitle}:{original_title}:{year}:{runtimeMinutes}:{(rch?.enable == true ? requestInfo.Country : "")}";',
    "Rutube cache key");
  source = replaceOnce(source, RUTUBE_CACHE_ANCHOR, RUTUBE_CACHE_REPLACEMENT, "Rutube search fallback");
  source = replaceOnce(source,
    '                string name = SearchNameTo.Convert(movie.title);\n                if (name != null && name.Contains(searchTitle) && (name.Contains(year.ToString()) || name.Contains((year + 1).ToString()) || name.Contains((year - 1).ToString())))\n                {\n                    if (movie.duration > 3000)\n                    {\n                        if (name.Contains("трейлер") || name.Contains("trailer") ||\n                            name.Contains("премьера") || name.Contains("обзор") ||\n                            name.Contains("сезон") || name.Contains("сериал") ||\n                            name.Contains("серия") || name.Contains("серий"))\n                            continue;\n\n                        if (movie.category.id == 4)\n                        {\n                            if (movie.is_hidden || movie.is_deleted || movie.is_adult || movie.is_locked || movie.is_audio || movie.is_paid || movie.is_livestream)\n                                continue;\n\n                            mtpl.Append(\n                                movie.title,\n                                $"{host}/lite/rutubemovie/play?linkid={movie.id}",\n                                "call",\n                                vast: init.vast\n                            );\n                        }\n                    }\n                }',
    '                string name = SearchNameTo.Convert(movie.title);\n                if (!IsPlatformMovieMatch(movie.title, movie.duration, title, original_title, year, runtimeMinutes) || movie.category?.id != 4)\n                    continue;\n                if (movie.is_hidden || movie.is_deleted || movie.is_adult || movie.is_locked || movie.is_audio || movie.is_paid || movie.is_livestream)\n                    continue;\n\n                mtpl.Append(\n                    movie.title,\n                    $"{host}/lite/rutubemovie/play?linkid={movie.id}",\n                    "call",\n                    vast: init.vast\n                );',
    "Rutube exact movie filtering");
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: node patch-platform-movies.mjs /path/VkMovieController.cs /path/RutubeMovieController.cs");
  const [vkPath, rutubePath] = process.argv.slice(2);
  const vk = patchVkMovie(readFileSync(vkPath, "utf8"));
  const rutube = patchRutubeMovie(readFileSync(rutubePath, "utf8"));
  writeFileSync(vkPath, vk);
  writeFileSync(rutubePath, rutube);
}
