import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { patchVideoDbService } from "../infrastructure/lampac/patch-zetflix-diagnostics.mjs";

const pinnedPath = process.env.LAMPAC_VIDEODB_SERVICE_SOURCE || "/tmp/lampac-native-1.81.0/module/OnlineRUS/VideoDB/Service.cs";
const templatePath = "/tmp/lampac-zetflix-research/Shared/Models/Templates/MovieTpl.cs";
const qualityTemplatePath = "/tmp/lampac-zetflix-research/Shared/Models/Templates/StreamQualityTpl.cs";
if (!existsSync(pinnedPath)) throw new Error(`Pinned Lampac VideoDB Service source required at ${pinnedPath}`);
if (!existsSync(templatePath)) throw new Error(`Pinned Lampac MovieTpl source required at ${templatePath}`);
if (!existsSync(qualityTemplatePath)) throw new Error(`Pinned Lampac StreamQualityTpl source required at ${qualityTemplatePath}`);

const source = readFileSync(pinnedPath, "utf8");
const movieTpl = readFileSync(templatePath, "utf8");
const streamQualityTpl = readFileSync(qualityTemplatePath, "utf8");

// Red baseline: upstream labels every match with a file-wide maximum and emits only streams[0].
assert.match(source, /file\.Contains\("2160p"\) \? "2160" : file\.Contains\("1080p"\)/);
assert.match(source, /pl\.streams\[0\]\.link \+ args[\s\S]*quality: pl\.streams\[0\]\.quality/);

// Verify the pinned template contract used by the patch: all stream entries become a quality map,
// and MovieTpl emits that map into the movie DTO.
assert.match(streamQualityTpl, /StreamQualityTpl\(IReadOnlyList<StreamQualityDto> streams, Func<string, string> linkPredicate = null\)/);
assert.match(streamQualityTpl, /result\.TryAdd\(item\.quality, item\.link\)/);
assert.match(streamQualityTpl, /return data\[0\]/);
assert.match(movieTpl, /streamquality\?\.ToObject\(emptyToNull: true\)/);

const patched = patchVideoDbService(source);
assert.match(patched, /m\.Groups\[1\]\.Value == "Авто" \? "auto" : m\.Groups\[1\]\.Value/);
assert.match(patched, /new StreamQualityTpl\(pl\.streams, link => link \+ args\)/);
assert.match(patched, /if \(streamquality\.IsEmpty\)\s*continue;\s*var selected = streamquality\.Firts\(\);[\s\S]*?selected\.link,[\s\S]*?streamquality: streamquality,[\s\S]*?quality: selected\.quality/);
assert.doesNotMatch(patched, /file\.Contains\("2160p"\) \? "2160"/);
const qualitiesMarker = patched.indexOf("[VideoDBQualities]");
const movieReturn = patched.indexOf("return mtpl;", qualitiesMarker);
const regularMovieBranch = patched.slice(qualitiesMarker, movieReturn);
assert.ok(regularMovieBranch.includes("selected.link"));
assert.ok(!regularMovieBranch.includes("pl.streams[0].link + args"));

const file = "[1080p]https://cdn.example/video-1080.m3u8,[720p]https://cdn.example/video-720.m3u8,[Авто]https://cdn.example/video-auto.m3u8";
const matches = [...file.matchAll(/\[(Авто|2160|1440|1080|720|480|360)p?\]([^"\,\[ ]+)/g)];
assert.equal(matches.length, 3);
const expected = [
  { link: "https://cdn.example/video-auto.m3u8", quality: "auto" },
  { link: "https://cdn.example/video-720.m3u8", quality: "720" },
  { link: "https://cdn.example/video-1080.m3u8", quality: "1080" },
];
const originalSemantics = matches.map((match) => ({
  link: match[2],
  quality: file.includes("2160p") ? "2160" : file.includes("1080p") ? "1080" : file.includes("720p") ? "720" : "480",
})).reverse().slice(0, 1);
assert.notDeepEqual(originalSemantics, expected,
  "red baseline: the old file-wide label and single-link output cannot satisfy the expected quality map");
const parsed = matches.map((match) => ({ link: match[2], quality: match[1] === "Авто" ? "auto" : match[1] })).reverse();
assert.deepEqual(parsed, expected);
assert.deepEqual(Object.fromEntries(parsed.map(({ link, quality }) => [quality, link])), {
  auto: "https://cdn.example/video-auto.m3u8",
  720: "https://cdn.example/video-720.m3u8",
  1080: "https://cdn.example/video-1080.m3u8",
});
assert.equal(parsed[0].quality, "auto", "selected URL and selected quality must agree");

assert.throws(() => patchVideoDbService(patched), /already applied/);
assert.throws(() => patchVideoDbService(source.replace("pl.streams[0].link + args", "pl.streams[1].link + args")), /anchor mismatch/);

console.log("Lampac VideoDB movie qualities check passed (1 fixture, pinned template contract).");
