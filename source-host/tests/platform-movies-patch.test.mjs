import assert from "node:assert/strict";
import { test } from "node:test";
import { patchRutubeMovie, patchVkMovie } from "../../infrastructure/lampac/patch-platform-movies.mjs";

const vkFixture = `public class VkMovieController : BaseOnlineController
{
    public async Task<ActionResult> Index(string title, string original_title, short year, byte serial, bool rjson = false)
    {
        var cache = await InvokeCacheResult<List<CatalogVideo>>(ipkey($"vkmovie:view:{searchTitle}:{year}"), 20, textJson: true, onget: async e =>
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
        });
        foreach (var item in cache.Value)
        {
            var video = item.video;
                if (video == null || video.files == null)
                    continue;

                string name = SearchNameTo.Convert(video.title);
                if (name == null || !name.Contains(searchTitle))
                    continue;

                if (!(name.Contains(year.ToString()) || name.Contains((year + 1).ToString()) || name.Contains((year - 1).ToString())))
                    continue;

                if (video.duration < 3000)
                    continue;

                if (string.IsNullOrEmpty(video.files.mp4_2160) &&
                    string.IsNullOrEmpty(video.files.mp4_1440) &&
                    string.IsNullOrEmpty(video.files.mp4_1080) &&
                    string.IsNullOrEmpty(video.files.mp4_720))
                    continue;

                append(video.files.mp4_144, "144p");

                if (streams.IsEmpty)
                    continue;
        }
    }
}`;

const rutubeFixture = `public class RutubeMovieController : BaseOnlineController
{
    public async Task<ActionResult> Index(string title, string original_title, short year, byte serial)
    {
        if (searchTitle == null || year == 0 || serial == 1)
        string memKey = $"rutubemovie:view:{searchTitle}:{year}:{(rch?.enable == true ? requestInfo.Country : "")}";
        var cache = await InvokeCacheResult<List<Result>>(memKey, TimeSpan.FromHours(4), textJson: true, onget: async e =>
        {
            string uri = $"api/search/video/?content_type=video&duration=movie&query={HttpUtility.UrlEncode($"{title} {year}")}";

            var root = await httpHydra.Get<RootSearch>($"{init.host}/{uri}", textJson: true);

            if (root?.results == null || root.results.Count == 0)
                return e.Fail("content", refresh_proxy: true);

            return e.Success(root.results);
        });
        foreach (var movie in cache.Value)
        {
            string name = SearchNameTo.Convert(movie.title);
            if (name != null && name.Contains(searchTitle) && (name.Contains(year.ToString()) || name.Contains((year + 1).ToString()) || name.Contains((year - 1).ToString())))
            {
                if (movie.duration > 3000)
                {
                    if (name.Contains("трейлер") || name.Contains("trailer") ||
                        name.Contains("премьера") || name.Contains("обзор") ||
                        name.Contains("сезон") || name.Contains("сериал") ||
                        name.Contains("серия") || name.Contains("серий"))
                        continue;

                    if (movie.category.id == 4)
                    {
                        if (movie.is_hidden || movie.is_deleted || movie.is_adult || movie.is_locked || movie.is_audio || movie.is_paid || movie.is_livestream)
                            continue;

                        mtpl.Append(
                            movie.title,
                            $"{host}/lite/rutubemovie/play?linkid={movie.id}",
                            "call",
                            vast: init.vast
                        );
                    }
                }
            }
        }
    }
}`;

test("platform movie patches match pinned 1.81.0 anchors, remain idempotent and fail closed on drift", () => {
  const vkSource = vkFixture;
  const rutubeSource = rutubeFixture.replace(
    /(foreach \(var movie in cache\.Value\)\n)([\s\S]*?)(\n        \})/,
    (_, start, body, end) => start + body.replaceAll("\n            ", "\n                ") + end,
  );
  const vk = patchVkMovie(vkSource);
  const rutube = patchRutubeMovie(rutubeSource);

  assert.equal(patchVkMovie(vk), vk);
  assert.equal(patchRutubeMovie(rutube), rutube);
  for (const text of [vk, rutube]) {
    assert.match(text, /runtimeMinutes = 0/);
    assert.match(text, /original_title.*year.*runtimeMinutes/);
    assert.match(text, /runtimeMinutes \* 60d/);
    assert.match(text, /Math\.Max\(120d, expectedSeconds \* 0\.1d\)/);
    assert.match(text, /19\|20\).*d\{2\}/);
    assert.match(text, /year > 0 \? \$"\{title\} \{year\}" : title/);
    assert.match(text, /year > 0 && !string\.IsNullOrWhiteSpace\(original_title\)/);
    assert.match(text, /queries\.Add\(\$"\{original_title\} \{year\}"\)/);
    assert.doesNotMatch(text, /year \+ 1|year - 1/);
  }
  assert.match(vk, /string name = SearchNameTo\.Convert\(video\.title\);/, "the remaining native trailer filter retains its local name variable");
  assert.match(vk, /video\.files\.hls/);
  assert.match(vk, /append\(video\.files\.hls, "auto"\)/);
  assert.match(rutube, /movie\.is_hidden \|\| movie\.is_deleted \|\| movie\.is_adult \|\| movie\.is_locked \|\| movie\.is_audio \|\| movie\.is_paid \|\| movie\.is_livestream/);
  assert.doesNotMatch(rutube, /searchTitle == null \|\| year == 0/);

  assert.throws(() => patchVkMovie(vkSource + vkSource), /anchor mismatch/);
  assert.throws(() => patchRutubeMovie(rutubeSource.replace("Get<RootSearch>", "Post<RootSearch>")), /anchor mismatch/);
});
