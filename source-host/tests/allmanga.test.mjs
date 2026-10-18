import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createCipheriv } from "node:crypto";
import { createAllMangaProvider, allMangaProtocol } from "../providers/allmanga.mjs";

const MASK = Buffer.from([210,95,113,21,228,205,125,137,27,125,1,230,205,68,37,183,104,115,209,103,115,34,26,42,21,184,251,96,0,206,55,176]);
const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 7 + 13) & 255));
const TITLE = { anime: true, type: "tv", title: "Haikyuu!!", originalTitle: "ハイキュー!!", year: 2014, season: 1, episode: 14 };

function encryptedEpisode(episode) {
  const iv = Buffer.from("00112233445566778899aabb", "hex");
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ episode })), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1]), iv, bytes]).toString("base64");
}

function encodedClockPath(path) {
  return [...path].map((char) => (char.charCodeAt(0) ^ 56).toString(16).padStart(2, "0")).join("");
}

function fixtureTransport({ edges = [show()], episode = validEpisode() } = {}) {
  const calls = [];
  return {
    calls,
    async request(rawUrl, options = {}) {
      calls.push({ url: new URL(rawUrl), options });
      if (options.signal?.aborted) throw options.signal.reason;
      const url = new URL(rawUrl);
      let body;
      if (url.pathname === "/_app/version.json") body = { version: "180" };
      else if (url.pathname === "/api" && url.searchParams.has("variables")) {
        const variables = JSON.parse(url.searchParams.get("variables"));
        body = variables.showId
          ? { data: { tobeparsed: encryptedEpisode(episode) } }
          : { data: { shows: { edges } } };
      } else if (url.pathname === "/client-crypto/v1/bootstrap") {
        const partB = Buffer.from(KEY.map((value, index) => value ^ MASK[index])).toString("base64");
        body = { epoch: Math.floor(Date.now() / 604_800_000), partB };
      } else if (url.hostname === "allanime.day" && url.pathname === "/clock.json") {
        body = { links: [{ link: "https://media.example.test/episode.m3u8", hls: true, resolutionStr: "1080p" }] };
      } else throw new Error(`Unexpected fixture URL ${url.origin}${url.pathname}`);
      const response = Readable.from([Buffer.from(JSON.stringify(body))]);
      response.statusCode = 200;
      response.headers = { "content-length": String(Buffer.byteLength(JSON.stringify(body))), "content-type": "application/json" };
      return { response };
    },
  };
}

function show(overrides = {}) {
  return { _id: "show-haikyuu-test", name: "Haikyuu!!", englishName: "Haikyuu!!", nativeName: "ハイキュー!!",
    type: "TV", airedStart: { year: 2014 }, ...overrides };
}

function validEpisode(overrides = {}) {
  return { episodeString: "14", show: show(), sourceUrls: [{ sourceName: "Default", sourceUrl: encodedClockPath("/clock?id=fixture") }], ...overrides };
}

async function first(items) { return (await items.next()).value; }

test("AllManga discovery is network-free, sealed, and labels sub/dub honestly", async () => {
  const transport = fixtureTransport();
  const provider = createAllMangaProvider({ transport });
  const candidates = [];
  for await (const candidate of provider.discover(TITLE)) candidates.push(candidate);
  assert.deepEqual(candidates.map(({ voiceId, voiceName }) => [voiceId, voiceName]), [["sub", "SUB"], ["dub", "DUB"]]);
  assert.equal(Object.keys(candidates[0]).includes("ref"), false);
  assert.equal(transport.calls.length, 0);
  const none = await first(provider.discover({ ...TITLE, anime: false }));
  assert.equal(none, undefined);
});

test("resolve requires exact show metadata and episode before returning direct HLS", async () => {
  const transport = fixtureTransport();
  const provider = createAllMangaProvider({ transport });
  const candidate = await first(provider.discover(TITLE));
  const result = await provider.resolve(candidate);
  assert.deepEqual(result.qualities.map(({ label, type }) => [label, type]), [["1080p", "hls"]]);
  assert.equal(new URL(result.qualities[0].url).hostname, "media.example.test");
  assert.equal(transport.calls.find((call) => call.url.pathname === "/client-crypto/v1/bootstrap").options.headers["x-aa-boot"].length, 64);
  const searchCall = transport.calls.find((call) => call.url.pathname === "/api");
  assert.equal(JSON.parse(searchCall.url.searchParams.get("variables")).search.query, TITLE.originalTitle);
  assert.equal(transport.calls.filter((call) => call.url.pathname === "/api").length, 2);
});

test("bootstrap aa-boot follows the current weekly epoch across a boundary", async () => {
  const originalNow = Date.now;
  Date.now = () => 604_800_000 * 2964 + 1;
  try {
    const transport = fixtureTransport();
    const provider = createAllMangaProvider({ transport });
    const candidate = await first(provider.discover(TITLE));
    await provider.resolve(candidate);
    const bootstrap = transport.calls.find((call) => call.url.pathname === "/client-crypto/v1/bootstrap");
    assert.equal(bootstrap.options.headers["x-aa-boot"], allMangaProtocol.bootToken({
      buildId: "180", epoch: 2964, group: "mkissa", host: "mkissa.to", lane: "k7",
    }));
  } finally {
    Date.now = originalNow;
  }
});

test("resolve rejects ambiguous titles, wrong year, wrong episode, and missing direct sources", async () => {
  for (const fixture of [
    { edges: [show(), show({ _id: "other-haikyuu" })] },
    { edges: [show({ airedStart: { year: 2015 } })] },
    { episode: validEpisode({ episodeString: "15" }) },
    { episode: validEpisode({ sourceUrls: [{ sourceName: "Ok", sourceUrl: "https://embed.example/" }] }) },
  ]) {
    const provider = createAllMangaProvider({ transport: fixtureTransport(fixture) });
    const candidate = await first(provider.discover(TITLE));
    await assert.rejects(provider.resolve(candidate));
  }
});

test("crypto helpers reject altered response data and unsupported clock paths", () => {
  assert.equal(Buffer.from(allMangaProtocol.makeAaReq({ key: KEY, epoch: 2963, buildId: "180", queryHash: "a".repeat(64), lane: "k7" }), "base64")[0], 1);
  assert.throws(() => allMangaProtocol.decryptResponse("AQ==", KEY));
  assert.throws(() => allMangaProtocol.decodeClockPath("//evil.example/path"));
  assert.throws(() => allMangaProtocol.decodeClockPath(encodedClockPath("/\\evil.example/clock")));
  assert.throws(() => allMangaProtocol.decodeClockPath(encodedClockPath("/\t/evil.example/clock")));
  assert.throws(() => allMangaProtocol.exactShow([], TITLE));
});

test("resolve observes cancellation before doing network work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const provider = createAllMangaProvider({ transport: fixtureTransport() });
  const candidate = await first(provider.discover(TITLE));
  await assert.rejects(provider.resolve(candidate, { signal: controller.signal }), /cancelled/);
});
