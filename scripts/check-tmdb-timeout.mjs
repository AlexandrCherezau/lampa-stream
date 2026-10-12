import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../src/utils/api.js', import.meta.url), 'utf8')).replace(/export /g, '');
const context = vm.createContext({ URL, URLSearchParams, console, setTimeout, clearTimeout,
  localStorage: { getItem() { return null; }, setItem() {} },
  AbortSignal: { timeout: () => AbortSignal.timeout(10), any: (signals) => AbortSignal.any(signals) },
  fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }),
});
vm.runInContext(source, context);
const caller = new AbortController();
context.caller = caller;
const result = await Promise.race([
  vm.runInContext('tmdbFetch("/search/multi?query=fixture", "fixture", { signal: caller.signal })', context).then(() => 'resolved', () => 'timed-out'),
  new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
]);
caller.abort();
assert.equal(result, 'timed-out', 'caller cancellation signal must not remove the request timeout');
console.log('TMDB request timeout check passed');
