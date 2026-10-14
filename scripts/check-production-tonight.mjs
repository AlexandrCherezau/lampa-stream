import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const token = process.env.TONIGHT_SMOKE_TMDB_TOKEN;
if (!token) throw new Error('TONIGHT_SMOKE_TMDB_TOKEN is required; this check never substitutes fixture catalogue data');
const origin = new URL(process.env.PRODUCTION_ORIGIN || 'https://lampa-stream-six.vercel.app');
assert.ok(['https:', 'http:'].includes(origin.protocol), 'The app origin must use HTTP(S)');
const evidencePath = process.env.TONIGHT_SMOKE_OUTPUT || '/tmp/personal-cinema-real-tonight.json';
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], catalogueResponses = [], detailReads = [];
  const discoveredDetails = new Map();
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/tmdb/3/discover/movie') || /^\/api\/tmdb\/3\/movie\/\d+$/.test(path)) catalogueResponses.push({ path, status: response.status() });
    if (/^\/api\/tmdb\/3\/movie\/\d+$/.test(path) && response.ok()) detailReads.push(response.json().then(item => discoveredDetails.set(item.id, item)).catch(() => {}));
  });
  await page.addInitScript(value => {
    localStorage.setItem('lampa_stream_site_pwd', 'ok');
    localStorage.setItem('lampa_stream_tmdb_token', value);
  }, token);
  await page.goto(new URL('/tonight', origin).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Напряжённое', exact: false }).click();
  await page.getByRole('button', { name: 'До 2 часов', exact: true }).click();
  await page.getByRole('button', { name: 'Вдвоём', exact: true }).click();
  await page.getByRole('button', { name: 'Найти пять фильмов', exact: true }).click();
  await page.locator('.tonight-film').nth(4).waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.tonight-film').count(), 5);
  const titles = await page.locator('.tonight-film h3').allTextContents();
  await Promise.all(detailReads);
  const details = [];
  for (const title of titles) {
    const matching = [...discoveredDetails.values()].filter(item => item.title === title);
    assert.equal(matching.length, 1, 'Each displayed title must map to one actual catalogue detail');
    const id = matching[0].id;
    const response = await context.request.get(new URL(`/api/tmdb/3/movie/${id}?language=ru&append_to_response=release_dates`, origin).href, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    assert.equal(response.status(), 200, `Actual catalogue detail HTTP status for movie ${id}`);
    const item = await response.json();
    assert.equal(item.id, id);
    assert.ok(!item.adult && Number.isFinite(item.runtime) && item.runtime >= 40 && item.runtime <= 120, `Actual runtime for movie ${id}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(item.release_date || '') && item.release_date <= new Date().toISOString().slice(0, 10), `Actual release for movie ${id}`);
    assert.ok(item.genres?.some(genre => [53, 9648, 80].includes(genre.id)), `Actual mood genres for movie ${id}`);
    details.push({ id, title: item.title, runtime: item.runtime, releaseDate: item.release_date, genreIds: item.genres.map(genre => genre.id) });
  }
  assert.equal(new Set(details.map(item => item.id)).size, 5);
  assert.ok(catalogueResponses.some(value => value.path.includes('/discover/movie') && value.status === 200));
  await page.getByRole('button', { name: `Открыть ${titles[0]}`, exact: true }).click();
  await page.waitForURL(/\/movie\/\d+$/);
  assert.equal(Number(new URL(page.url()).pathname.split('/').pop()), details[0].id);
  assert.deepEqual(errors, []);
  const evidence = { checkedAt: new Date().toISOString(), origin: origin.origin, metadataMocked: false, mood: 'tension', maxMinutes: 120, company: 'pair', movieCount: details.length, movies: details, catalogueResponses, pageErrors: errors.length };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, evidencePath, movieCount: details.length, metadataMocked: false }));
} finally {
  await browser.close();
}
