import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/utils/useLampacSource.js', import.meta.url), 'utf8');
const pickCode = source.slice(source.indexOf('function defaultVoiceIndex('), source.indexOf('// ── Per-series descent caches'));
const contextCode = source.slice(source.indexOf('async function loadContext('), source.indexOf('// A source item'));
let response = { type: 'season', seasons: [{ number: 1, url: 'season-1' }] };
const env = {
  lampacBalanser: async (url) => url === 'unavailable-voice' ? {ok: false} : {ok: true, json: response},
  lampacKind: (j) => j.type,
  normalizeSeasons: (j) => ({seasons: j.seasons}),
  normalizeEpisodes: (j) => ({voices: j.voices || [], episodes: j.episodes || []}),
  episodeSource: (ep) => ep,
  descentCacheGet: () => null, descentCacheSet() {},
  titleDescentCache: new Map(), seasonDescentCache: new Map(),
};
const {loadContext, pickEpisode} = vm.runInNewContext(`${pickCode}\n${contextCode}\n({loadContext, pickEpisode})`, env);
assert.equal(pickEpisode([{episode: 1}], 14), null, 'missing episode must not play episode 1');
const args = {entry: {balanser: 'test', rawUrl: 'title'}, ids: {}, type: 'tv', season: 2, episode: 14};
await assert.rejects(loadContext(args), /Сезон не найден/);
response = {type: 'episode', episodes: [{episode: 1}]};
await assert.rejects(loadContext({...args, season: 1}), /Серия не найдена/);
response = {type: 'episode', episodes: [{episode: 14}], voices: [{url: 'unavailable-voice', active: false}]};
await assert.rejects(loadContext({...args, season: 1}), /озвучка недоступна/);
response.voices = [];
assert.equal((await loadContext({...args, season: 1})).source.episode, 14);
const advanceCode = source.slice(source.indexOf('const advance = useCallback('), source.indexOf('// The player calls this when the attached'));
const manualRef = {current: true};
let next;
const advance = vm.runInNewContext(`${advanceCode}; advance`, {
  useCallback: (fn) => fn, manualRef,
  entriesRef: {current: [{balanser: 'failed'}, {balanser: 'working'}]},
  balanserRef: {current: 'failed'}, triedRef: {current: new Set()}, poolRef: {current: ['working']},
  setStream() {}, setVoiceIdx() {}, setQualities() {}, setQualityId() {}, setBalanser: (id) => {next = id;},
});
assert.equal(advance(), true, 'manual source failure must recover');
assert.equal(next, 'working');
assert.equal(manualRef.current, false);
console.log('Lampac recovery checks passed: exact season/episode/voice and manual source failover');

const resolveCode = source.slice(source.indexOf("async function resolveSource("), source.indexOf("// Stable id for a quality entry"));
let kind = "no-link";
const {resolveSource} = vm.runInNewContext(`${resolveCode}; ({resolveSource})`, {
  lampacResolveCall: async () => ({ok: false, error: "HTTP 503", kind}), extractQualities: () => [],
});
const shortcut = {method: "call", url: "https://source/video", stream: "https://source/video?play=true", streamProxyUrl: "/api/stream", headers: {Referer: "https://source/"}};
const recovered = await resolveSource(shortcut);
assert.equal(recovered.ok, true);
assert.equal(recovered.fallback.url, shortcut.stream);
assert.equal(recovered.fallback.proxyUrl, shortcut.streamProxyUrl);
assert.equal(recovered.fallback.headers.Referer, "https://source/");
kind = "cancelled";
assert.equal((await resolveSource(shortcut)).ok, false, "cancelled lookup must never publish a fallback stream");
console.log("Lampac published stream fallback check passed");
