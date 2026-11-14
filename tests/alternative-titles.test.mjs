import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { alternativeTitleNames } from "../src/utils/alternative-titles.js";

test("alternative titles put Russian names first and drop main names, blanks and duplicates", () => {
  // Shape of TMDB /tv/289517/alternative_titles: Habster lists the show as "Идеальная работа".
  const tv = { results: [
    { iso_3166_1: "US", title: "Dead-End Job", type: "" },
    { iso_3166_1: "KR", title: "꿀알바", type: "" },
    { iso_3166_1: "RU", title: "Идеальная работа", type: "" },
    { iso_3166_1: "DE", title: "  ", type: "" },
    { iso_3166_1: "GB", title: "dead-end job", type: "" },
  ] };
  assert.deepEqual(alternativeTitleNames(tv, ["Работа с призрачными перспективами", "꿀알바"]), ["Идеальная работа", "Dead-End Job"]);
  assert.deepEqual(alternativeTitleNames({ titles: [{ iso_3166_1: "FR", title: "Film" }] }), ["Film"]);
});

test("alternative titles tolerate missing or malformed TMDB answers and stay bounded", () => {
  assert.deepEqual(alternativeTitleNames(null), []);
  assert.deepEqual(alternativeTitleNames({ results: "nope" }), []);
  assert.deepEqual(alternativeTitleNames({ results: [{ title: 5 }, null, { title: "x".repeat(301) }] }), []);
  const many = { titles: Array.from({ length: 30 }, (_, i) => ({ iso_3166_1: "US", title: `Name ${i}` })) };
  assert.equal(alternativeTitleNames(many).length, 12);
});

test("source discovery sends alternative titles and keys prepared sources by them", () => {
  const hook = readFileSync(new URL("../src/utils/useSourceHost.js", import.meta.url), "utf8");
  assert.match(hook, /alternative_titles/);
  assert.match(hook, /altTitles/);
  const client = readFileSync(new URL("../src/utils/source-host-client.js", import.meta.url), "utf8");
  assert.match(/function titleKey[\s\S]*?\]\);/.exec(client)[0], /title\.altTitles/);
});
