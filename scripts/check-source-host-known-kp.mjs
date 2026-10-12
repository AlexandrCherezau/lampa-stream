import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hookPath = new URL("../src/utils/useSourceHost.js", import.meta.url);
let source = await readFile(hookPath, "utf8");
source = source.replace(
  'import { useEffect, useRef, useState } from "react";',
  "const useEffect = (...args) => globalThis.__sourceHostHookStubs.useEffect(...args);\nconst useRef = (...args) => globalThis.__sourceHostHookStubs.useRef(...args);\nconst useState = (...args) => globalThis.__sourceHostHookStubs.useState(...args);",
).replace(
  'import { tmdbFetch, isAnimeContent } from "./api";',
  "const tmdbFetch = (...args) => globalThis.__sourceHostHookStubs.tmdbFetch(...args);\nconst isAnimeContent = (...args) => globalThis.__sourceHostHookStubs.isAnimeContent(...args);",
).replace(
  'import { collapsFindKp } from "./collaps-client";',
  "const collapsFindKp = (...args) => globalThis.__sourceHostHookStubs.collapsFindKp(...args);",
).replace(
  'import { createSourceSession } from "./source-host-client";',
  "const createSourceSession = (...args) => globalThis.__sourceHostHookStubs.createSourceSession(...args);",
);

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
globalThis.__sourceHostHookStubs = {};
const { default: useSourceHost } = await import(moduleUrl);

async function runCase({ details = {}, item = {}, expectedId, expectedDependency = null, expectLookup }) {
  let effect;
  let dependencies;
  let lookupCount = 0;
  let started;
  const stubs = {
    useEffect(callback, deps) { effect = callback; dependencies = deps; },
    useRef(current) { return { current }; },
    useState(initial) { return [initial, () => {}]; },
    tmdbFetch: async () => null,
    isAnimeContent: () => false,
    collapsFindKp: async () => { lookupCount++; return { ok: true, kinopoiskId: 777 }; },
    createSourceSession: () => ({ start(value) { started = value; }, stop() {} }),
  };
  globalThis.__sourceHostHookStubs = stubs;
  useSourceHost({ enabled: true, item: { title: "Fixture", ...item }, details: { title: "Fixture", ...details }, type: "movie" });
  const cleanup = effect();
  for (let attempt = 0; attempt < 10 && !started; attempt++) await new Promise((resolve) => setImmediate(resolve));
  cleanup?.();
  assert.equal(lookupCount, expectLookup ? 1 : 0);
  assert.equal(started?.kinopoiskId, expectedId);
  assert(dependencies.includes(expectedDependency), "selected Kinopoisk ID is tracked as an effect dependency");
  return dependencies;
}

await runCase({ details: { kinopoisk_id: 361 }, expectedId: 361, expectedDependency: 361, expectLookup: false });
await runCase({ details: { kinopoisk_id: 0, kinopoiskId: "362" }, item: { kinopoisk_id: 363, kinopoiskId: 364 }, expectedId: 362, expectedDependency: 362, expectLookup: false });
await runCase({ item: { kinopoisk_id: 365 }, expectedId: 365, expectedDependency: 365, expectLookup: false });
await runCase({ details: { kinopoiskId: Number.MAX_SAFE_INTEGER + 1 }, item: { kinopoisk_id: 363 }, expectedId: 363, expectedDependency: 363, expectLookup: false });
await runCase({ details: { kinopoisk_id: true, kinopoiskId: null }, item: { kinopoisk_id: { valueOf: () => 366 } }, expectedId: 777, expectLookup: true });
await runCase({ details: { kinopoisk_id: "invalid" }, expectedId: 777, expectLookup: true });

console.log("Source host known-KP checks passed");
