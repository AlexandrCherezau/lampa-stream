# Zona static source analysis — 2026-10-13

## Scope and tools

Analyzed the user-supplied `ZonaSetup64[W2K4Y].exe` without running the installer or application. Installer size: 191,858,600 bytes; SHA-256: `0ad33f36e2a8b854da361c027c19e9d3ce178dce085dc6c8dd2c979c10ab4cf1`.

Used REA CLI **6.4.0**, following its `reverse-engineer-anything` skill version 41 and [pinned CLI documentation](https://github.com/morluto/rea/blob/3af8f847f0e35843f51622a136165dd6ee12cdd0/docs/cli.md). REA repository revision: `3af8f847f0e35843f51622a136165dd6ee12cdd0`.

- `rea inspect-pe-resources` correctly refused the complete installer because its portable PE parser has a 64 MiB file limit.
- A bounded PE resource-table reader extracted embedded resources without executing target code.
- `rea inspect-artifact` successfully inventoried both the 28,994-byte embedded loader JAR and the extracted 61,283,357-byte `Zona.jar`.
- Loader bytecode was inspected with `javap`. The application payload uses a per-file 10-byte packing key, Blowfish ECB, LZMA, then length-prefixed filename/content records. Our independent Java JCE/Python decoder extracted the records; target classes were never loaded or run.
- Zona.jar SHA-256: `7c89030c9bedbbb60ba73dad95a645698610a0f1ba0487c6f313c16ca5245eda`; 16,275 archive entries. REA evidence ID: `ev_bfd9fa17371e845b0503a2b307e6e0280348170091094577193fe4942ec58aa7`.
- Static application version string: `ZonaDesktop(3.0.0.8)`.

Raw artifacts and network captures remain in owner-private `/tmp/zona-rea-analysis`; they are not committed. This report contains no credentials, signed media addresses, complete torrent hashes, or application binaries.

## Proven catalog interface

The desktop classes `ru.zona.variables.Variable`, `ru.megamakc.search.zona.searchsource.AbstractSearchSource`, and `ru.megamakc.search.zona.service.impl.SolrUrlProvider` identify Zona's public catalog and torrent search. Their default origin is HTTP `zsolr3.zonasearch.com`; HTTPS was independently verified with successful anonymous requests.

Fixed catalog origin: `https://zsolr3.zonasearch.com`.

Exact movie lookup: `/solr/movie/select/` with `q=id:<positive Kinopoisk ID>`, `wt=json`, `rows=1`.

A bounded popular-movie query was tested successfully with HTTP 200, 20 documents, and `response.numFound=1038660`:

```text
q=serial:false AND adult:false
sort=popularity desc
start=0
rows=20
wt=json
fl=id,name_rus,name_original,year,serial,adult,popularity,rating_imdb,rating_kinopoisk,genre_name
```

This exact popularity query is a verified integration proposal, not a claim that desktop UI uses the same ranking filters.

| Field | Observed type | Meaning |
|---|---|---|
| `id` | string | Kinopoisk ID; **not** TMDB ID |
| `name_rus`, `name_original` | string | Russian/original title; original can be empty |
| `year` | number | Release year |
| `serial`, `adult` | boolean | Type and adult flag |
| `popularity` | number | Zona popularity value |
| `rating_imdb`, `rating_kinopoisk` | number | Ratings, not identifiers |
| `genre_name` | string | Comma-separated Russian genres |
| `mobi_url` | string | Public Zona online detail page |
| `mobi_link_id` | number | Internal online video ID |
| `mobi_link_width`, `mobi_link_height` | number | Catalog metadata, not proof of playable resolution |
| `tor_count` | number | Catalog torrent count |

Requests explicitly asking for `imdb_id`, `imdb`, `imdbId`, and `imdb_link` returned none of those fields in the sampled 20 documents. IMDb mapping must therefore be independently enriched and validated; never reuse the KP ID as TMDB ID or infer IMDb identity from `rating_imdb`. An existing fixed KP-to-IMDb metadata lookup can supply the mapping, followed by typed TMDB `/find` and title/year checks; omit unresolved items.

Observed identities: KP5494049 is `Spider-Man: Brand New Day`, 2026; KP328 is `The Lord of the Rings: The Fellowship of the Ring`, 2001. **KP10355286 is `Obsession` / `Обсессия`, 2025 in Zona, not Insidious 6.** This matters when comparing the user's Habster link to their displayed title.

## Proven torrent interface

Anonymous exact lookup `/solr/torrent/select/` with `q=kinopoisk_id:<KP>`, `wt=json`, bounded `rows`, and `sort=seeds desc` returned actual torrent metadata. For KP10355286 it returned `numFound=43`.

Observed fields: `hash` (string), `magnet` (**boolean**, not a magnet URI), `size_bytes` (number), `resolution` (e.g. `1280x720`), `translate_info` (string), `seeds`/`peers` (numbers), `kinopoisk_id` (number), `private` (boolean), `files`/`filenames` (strings), `torrent_download_link` (URL string).

If used by an existing torrent engine, validate a 40-hex infohash and construct the standard magnet URI locally. Reject private records and invalid/mismatched identities; do not expose arbitrary provider URLs or create an unrestricted Solr proxy. A browser cannot directly play these records without a torrent-to-HTTP engine.

## Online playback result: do not integrate the placeholder

Public `mobi_url` pages for KP5494049 and KP328 contained Zona video controls. KP10355286 instead displayed an explicit rights-restriction message and no video element.

The public website JavaScript calls `/ajax/video/<mobi_link_id>?client_time=...` and reads JSON fields `url`, `lqHlsUrl`, `host`. A normal headless browser click on the Spider-Man page produced HTTP 200 with those fields. Independent anonymous requests with omitted `client_time`, milliseconds, and seconds also returned HTTP 200. No remote JavaScript evaluation is required merely to call that endpoint.

However, validating the actual returned media disproved successful movie playback:

- MP4 range request: HTTP 206, `video/mp4`, total **539,215 bytes**.
- `ffprobe`: **60 seconds**, 1920×1080, video-only.
- A decoded frame says to download and install the latest Zona Android application.
- Returned HLS URL: HTTP 404.

Thus the online endpoint currently supplied an installation-ad placeholder for this test. Its 1080p dimensions are not evidence of a 1080p film. Do not advertise it as a playable Zona movie candidate or autoselect it. The real, verified integration surface is the catalog plus torrent metadata; playback should continue through separately verified sources until a full-duration Zona HTTP stream is proven.

## Verification limits

Analysis covered one installer version and bounded anonymous samples on 2026-10-13. Catalog fields and live domains are undocumented and may change. Desktop playback, DRM/license flows, and full torrent downloads were not executed. No account session or production secrets were accessed. No runtime code was changed by this research task.
