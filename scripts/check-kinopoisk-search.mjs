import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/web/shim.js', import.meta.url), 'utf8');
let films = [];
let requests = 0;
const window = {};
vm.runInNewContext(source, { window, URL, URLSearchParams, AbortSignal, AbortController, setTimeout, clearTimeout,
  fetch: async () => { requests++; return { ok: true, json: async () => ({ films }) }; },
  localStorage: { getItem() { return null; } }, console });
const find = (query, year, extra = {}) => window.electron.collapsFindKp({ query, year, type: 'movie', ...extra });
films = [{ filmId: 1, nameRu: 'Другой фильм', year: '1999' }];
assert.equal((await find('Бойцовский клуб', 1999)).ok, false, 'same year is insufficient to identify a film');
films = [{ filmId: 2, nameRu: 'Бойцовский клуб', year: '2001' }];
assert.equal((await find('Бойцовский клуб', 1999)).ok, false, 'wrong release year must not override requested film');
films = [{ filmId: 361, nameRu: 'Бойцовский клуб', year: '1999' }, { filmId: 9, nameRu: 'Бойцовский клуб', year: '1999' }];
assert.equal((await find('Бойцовский клуб', 1999)).ok, false, 'ambiguous exact matches are rejected');
films = [{ filmId: 361, nameEn: 'Fight Club', year: '1999' }];
assert.equal((await find('Бойцовский клуб', 1999, { originalTitle: 'Fight Club' })).kinopoiskId, 361);
const before = requests;
films = [];
assert.equal((await find('Бойцовский клуб', 1999, { originalTitle: 'Fight Club' })).kinopoiskId, 361);
assert.equal(requests, before, 'known mapping is reused across episodes/openings');
assert.equal((await find('Бойцовский клуб', 2000, { originalTitle: 'Fight Club' })).ok, false, 'cache keeps release years separate');
console.log('Kinopoisk search checks passed');
