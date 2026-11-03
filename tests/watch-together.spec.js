import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand, createRoom, generateCode, publicRoom } from "../workers-api/rooms-core.mjs";

// Two real browser pages share a room. The rooms server runs in this process on the
// same rules module the Durable Object runs; the app's own HTTP and WebSocket
// clients reach it through Playwright routes.
const WORKER = "lampa-rooms.ocr-gemini-proxy.workers.dev";

const FILM = { id: 550, title: "Бойцовский клуб", original_title: "Fight Club", original_language: "en", release_date: "1999-10-15", poster_path: "/p.svg", media_type: "movie" };
const SERIES = { id: 1396, name: "Во все тяжкие", original_name: "Breaking Bad", original_language: "en", first_air_date: "2008-01-20", poster_path: "/s.svg", media_type: "tv" };

test.use({ actionTimeout: 10_000 });

let fixtureDir;
test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "wt-fixture-"));
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=240",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0",
    "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(fixtureDir, "seg%03d.ts"), join(fixtureDir, "index.m3u8"),
  ]);
});
test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

class RoomsServer {
  constructor() {
    this.rooms = new Map();
    this.sockets = new Map();
    this.commands = [];
    this.wsBlocked = false;
    this.directHttpBlocked = false;
  }

  peerId(secret) { return createHash("sha256").update(String(secret)).digest("hex"); }

  create(secret, name) {
    const code = generateCode((n) => Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
    this.rooms.set(code, createRoom({ code, hostId: this.peerId(secret), name, now: Date.now() }));
    this.sockets.set(code, new Set());
    return code;
  }

  broadcast(code, message) {
    for (const socket of this.sockets.get(code) || []) if (socket.peerId) socket.ws.send(JSON.stringify(message));
  }

  run(code, peerId, command) {
    const room = this.rooms.get(code);
    const now = Date.now();
    this.commands.push({ code, peerId, command });
    const result = applyCommand(room, peerId, command, now);
    if (result.closed) {
      this.broadcast(code, { t: "closed" });
      for (const socket of this.sockets.get(code)) socket.ws.close({ code: 4000, reason: "closed" });
      this.rooms.delete(code);
      return result;
    }
    if (result.error) return result;
    const { patch, chat, reaction, joined, left } = result;
    if (patch || chat || reaction) {
      const name = joined ? room.who[peerId]?.name : left;
      this.broadcast(code, {
        t: "patch", now,
        ...(patch ? { patch } : {}), ...(chat ? { chat } : {}), ...(reaction ? { reaction } : {}),
        ...(joined ? { joined: { by: peerId, name } } : {}), ...(left ? { left: { by: peerId, name } } : {}),
      });
    }
    return result;
  }

  async attach(page, { clockSkewMs = 0, token = "wt-token", name = null } = {}) {
    await page.addInitScript(({ skew, token, name }) => {
      if (token) localStorage.setItem("lampa_stream_tmdb_token", token);
      localStorage.setItem("streambert_reduceAnimations", "true");
      localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
      if (name) localStorage.setItem("streambert_wtName", JSON.stringify(name));
      if (skew) {
        const real = Date.now.bind(Date);
        Date.now = () => real() + skew;
      }
    }, { skew: clockSkewMs, token, name });

    const handleHttp = async (route, code) => {
      const request = route.request();
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const secret = (request.headers().authorization || "").replace("Bearer ", "");
      if (request.method() === "POST" && !code) return route.fulfill({ headers, json: { code: this.create(secret, request.postDataJSON().name), now: Date.now() } });
      const room = this.rooms.get(code);
      if (request.method() === "GET") return route.fulfill({ headers, json: { room: room ? publicRoom(room) : null, now: Date.now() } });
      if (!room) return route.fulfill({ status: 404, headers, json: { error: "room_not_found", now: Date.now() } });
      const result = this.run(code, this.peerId(secret), request.postDataJSON());
      return route.fulfill({ status: result.error ? 400 : 200, headers, json: result.error ? { error: result.error } : { ok: true, now: Date.now() } });
    };
    await page.route(new RegExp(`https://${WORKER}/rooms(/[^/?]+)?$`), (route) => {
      if (this.directHttpBlocked) return route.abort();
      const match = new URL(route.request().url()).pathname.match(/^\/rooms\/([^/]+)/);
      return handleHttp(route, match?.[1] || null);
    });
    await page.route(/\/api\/room(\?|$)/, (route) => handleHttp(route, new URL(route.request().url()).searchParams.get("code")));

    await page.routeWebSocket(new RegExp(`wss://${WORKER}/rooms/[^/]+/ws`), (ws) => {
      if (this.wsBlocked) { ws.close({ code: 1011, reason: "blocked" }); return; }
      const code = new URL(ws.url()).pathname.split("/")[2];
      const socket = { ws, peerId: null };
      this.sockets.get(code)?.add(socket);
      ws.onMessage((data) => {
        if (data === "ping") { ws.send("pong"); return; }
        const message = JSON.parse(data);
        const room = this.rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ t: "closed" })); ws.close({ code: 4004, reason: "no room" }); return; }
        if (message.t === "hello") {
          const peerId = this.peerId(message.secret);
          this.run(code, peerId, { t: "join", name: message.name });
          socket.peerId = peerId;
          ws.send(JSON.stringify({ t: "snapshot", now: Date.now(), peerId, room: publicRoom(room) }));
          return;
        }
        if (message.t === "time") { ws.send(JSON.stringify({ t: "time", sent: message.sent, now: Date.now() })); return; }
        const result = this.run(code, socket.peerId, message);
        if (result.error) ws.send(JSON.stringify({ t: "error", error: result.error, for: message.t }));
      });
      ws.onClose(() => { this.sockets.get(code)?.delete(socket); });
    });

    await page.route("**/api/tmdb/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.includes("/img/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="#345"/></svg>' });
      if (!route.request().headers().authorization?.includes(token || "\u0000")) return route.fulfill({ status: 401, json: {} });
      let json = { results: [] };
      if (/\/tv\/1396\/season\/\d+$/.test(pathname)) json = { episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `Серия ${n}`, air_date: "2008-01-20" })) };
      else if (/\/tv\/1396$/.test(pathname)) json = { ...SERIES, seasons: [{ season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 3 }] };
      else if (/\/movie\/550$/.test(pathname)) json = { ...FILM, imdb_id: "tt0137523", runtime: 139, genres: [] };
      else if (/trending\/all/.test(pathname) || /search\/multi/.test(pathname)) json = { results: [FILM, SERIES] };
      return route.fulfill({ json });
    });
    await page.route("**/api/source-host?op=discover", (route) => route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: candidate\ndata: ${JSON.stringify({ id: "pb", providerId: "habster:alloha", providerName: "Habster", voiceId: "v", voiceName: "Original", qualityHint: "Auto" })}\n\nevent: done\ndata: {"candidates":1,"complete":true}\n\n`,
    }));
    await page.route("**/api/source-host?op=resolve", (route) => route.fulfill({ json: {
      kind: "hls", selected: { url: "https://media.test/index.m3u8", label: "360p" },
      qualities: [{ label: "360p", height: 360, url: "https://media.test/index.m3u8" }], subtitles: [], audioNames: [],
    } }));
    await page.route("https://media.test/**", (route) => {
      const file = new URL(route.request().url()).pathname.split("/").pop();
      return route.fulfill({
        contentType: file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
        body: readFileSync(join(fixtureDir, file)),
      });
    });
  }
}

const videoState = (page) => page.evaluate(() => {
  const v = document.querySelector("video");
  return v ? { t: v.currentTime, paused: v.paused, duration: v.duration, seeks: window.__seeks || 0, rate: v.playbackRate } : null;
});
const videoReady = (page) => expect.poll(async () => (await videoState(page))?.duration > 0, { timeout: 25_000 }).toBe(true);

async function hostRoom(server, browser, attachOptions = {}) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await server.attach(page, { name: "Аня", ...attachOptions });
  await page.goto("/together", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(page.locator(".wt-bar")).toBeVisible();
  const code = await page.locator(".wt-code").textContent();
  return { context, page, code };
}

const pickFilm = async (page) => {
  await page.locator(".wt-title", { hasText: FILM.title }).click();
  await expect(page.locator(".wt-bar__title strong")).toHaveText(FILM.title);
  await videoReady(page);
};

async function guestJoin(server, browser, code, attachOptions = {}, contextOptions = {}) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 }, ...contextOptions });
  const page = await context.newPage();
  await server.attach(page, { name: "Боря", ...attachOptions });
  await page.goto(`/?room=${code}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Присоединиться" }).click();
  await expect(page.locator(".wt-bar")).toBeVisible();
  return { context, page };
}

const pressPlay = (page) => page.locator(".torrplayer-bigplay").click();
const inSync = (a, b, tolerance) => expect.poll(async () => {
  const [x, y] = await Promise.all([videoState(a), videoState(b)]);
  return x && y && Math.abs(x.t - y.t) < tolerance && x.paused === y.paused;
}, { timeout: 15_000 }).toBe(true);

test("an invited guest without a TMDB token sees who invites to what, joins and gets the film", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);

  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await server.attach(page, { token: null, name: "Боря" });
  await page.goto(`/?room=${host.code}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".wt-invite")).toContainText("Аня зовёт смотреть вместе");
  await expect(page.locator(".wt-invite")).toContainText(FILM.title);
  await page.getByRole("button", { name: "Присоединиться" }).click();
  await videoReady(page);
  await expect(page.locator(".wt-panel")).toContainText("Боря (вы)");
  await expect(host.page.locator(".wt-panel")).toContainText("Боря присоединяется");
  await context.close();
  await host.context.close();
});

test("play, pause and seek from either side reach the other; loading never moves the room", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);

  const reports = () => server.commands.filter((c) => c.command.t === "play");
  await guest.page.waitForTimeout(1500);
  expect(reports()).toHaveLength(0);
  expect((await videoState(guest.page)).paused).toBe(true);

  await pressPlay(host.page);
  await inSync(host.page, guest.page, 0.5);
  expect((await videoState(guest.page)).paused).toBe(false);

  // A guest's pause stops the host too, and the host is told who did it.
  await guest.page.locator("video").click();
  await expect.poll(async () => (await videoState(host.page)).paused).toBe(true);
  await expect(host.page.locator(".wt-toast")).toHaveText("Боря: пауза");
  await inSync(host.page, guest.page, 0.4);

  // Exact frame on seek while paused.
  await host.page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await videoState(guest.page)).t, { timeout: 8000 }).toBeGreaterThan(8);
  await inSync(host.page, guest.page, 0.4);

  await pressPlay(guest.page);
  await expect.poll(async () => (await videoState(host.page)).paused).toBe(false);
  await inSync(host.page, guest.page, 0.5);
  await guest.context.close();
  await host.context.close();
});

test("a guest whose clock is 40 s off stays in sync without seeking again and again", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code, { clockSkewMs: 40_000 });
  await videoReady(guest.page);
  await guest.page.evaluate(() => {
    window.__seeks = 0;
    document.querySelector("video").addEventListener("seeking", () => { window.__seeks += 1; });
  });

  await pressPlay(host.page);
  await inSync(host.page, guest.page, 0.5);
  await guest.page.waitForTimeout(6000);
  const [a, b] = [await videoState(host.page), await videoState(guest.page)];
  expect(Math.abs(a.t - b.t)).toBeLessThan(0.6);
  expect(b.seeks).toBeLessThanOrEqual(1);
  await guest.context.close();
  await host.context.close();
});

test("when only the host controls, a guest cannot move the room but keeps sound and source", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  // Controlled by the room: it changes when the server's answer arrives.
  await host.page.getByLabel("Паузу и перемотку могут все").click();
  await expect(host.page.getByLabel("Паузу и перемотку могут все")).not.toBeChecked();
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);
  await expect(guest.page.locator(".wt-bar__title")).toContainText("Управляет ведущий");

  await expect(guest.page.locator(".torrplayer-btn--play")).toBeHidden();
  await expect(guest.page.locator(".torrplayer-btn--mute")).toBeVisible();
  await pressPlay(host.page);
  await inSync(host.page, guest.page, 0.5);

  const before = server.commands.length;
  await guest.page.locator("video").click();
  await guest.page.keyboard.press("Space");
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.waitForTimeout(800);
  expect(server.commands.slice(before).filter((c) => c.command.t === "play")).toHaveLength(0);
  expect((await videoState(guest.page)).paused).toBe(false);

  // Giving the role away gives the controls.
  await host.page.locator(".wt-person", { hasText: "Боря" }).getByRole("button", { name: "сделать ведущим" }).click();
  await expect(guest.page.locator(".torrplayer-btn--play")).toBeAttached();
  await expect(guest.page.getByLabel("Паузу и перемотку могут все")).toBeVisible();
  await guest.context.close();
  await host.context.close();
});

test("chat and reactions arrive, a failed send keeps the text, leaving passes the host role", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await expect(host.page.locator(".wt-alone")).toBeVisible();
  const guest = await guestJoin(server, browser, host.code);
  await expect(host.page.locator(".wt-alone")).toBeHidden();

  await guest.page.getByLabel("Сообщение").fill("привет <b>всем</b>");
  await guest.page.getByLabel("Сообщение").press("Enter");
  await expect(host.page.locator(".wt-msg")).toHaveText(/Боряпривет <b>всем<\/b>/);
  await expect(guest.page.locator(".wt-msg.is-mine")).toBeVisible();
  await expect(guest.page.getByLabel("Сообщение")).toHaveValue("");

  await guest.page.getByRole("button", { name: "Реакция 🔥" }).click();
  await expect(host.page.locator(".wt-float")).toHaveText("🔥");
  await expect(host.page.locator(".wt-float")).toBeVisible();
  expect(await host.page.locator(".wt-float").evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0);

  await host.page.getByRole("button", { name: "Выйти из комнаты" }).click();
  await expect(host.page.getByRole("button", { name: "Создать комнату" })).toBeVisible();
  await expect(guest.page.locator(".wt-note")).toContainText("Аня выходит из комнаты");
  await expect(guest.page.locator(".wt-person").first()).toContainText("ведущий");
  await guest.context.close();
  await host.context.close();
});

test("a reload returns to the same room at the room's position, and a closed room says so", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);
  await pressPlay(host.page);
  await inSync(host.page, guest.page, 0.5);
  await guest.page.waitForTimeout(3000);

  await guest.page.reload({ waitUntil: "domcontentloaded" });
  await expect(guest.page.locator(".wt-code")).toHaveText(host.code);
  await videoReady(guest.page);
  // No gesture on a reload: the browser may need one tap to allow sound.
  const tap = guest.page.locator(".torrplayer-bigplay");
  if (await tap.isVisible().catch(() => false)) await tap.click();
  await inSync(host.page, guest.page, 0.8);

  // Leaving one room and coming back to the tab does not rejoin it.
  host.page.once("dialog", (dialog) => dialog.accept());
  await host.page.getByRole("button", { name: "Закрыть комнату" }).click();
  await expect(guest.page.locator(".wt-message")).toHaveText("Комната закрыта.");
  await guest.page.reload({ waitUntil: "domcontentloaded" });
  await expect(guest.page.getByRole("button", { name: "Создать комнату" })).toBeVisible();
  await guest.context.close();
  await host.context.close();
});

test("with no WebSocket the room works over HTTP, and through /api/room with no direct route", async ({ browser }) => {
  const server = new RoomsServer();
  server.wsBlocked = true;
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);
  await expect(host.page.locator(".wt-panel")).toContainText("Боря");

  await pressPlay(host.page);
  await inSync(host.page, guest.page, 1);
  await guest.page.getByLabel("Сообщение").fill("без сокета");
  await guest.page.getByLabel("Сообщение").press("Enter");
  await expect(host.page.locator(".wt-msg")).toContainText("без сокета");

  server.directHttpBlocked = true;
  await host.page.getByLabel("Сообщение").fill("через прокси");
  await host.page.getByLabel("Сообщение").press("Enter");
  await expect(guest.page.locator(".wt-msg").last()).toContainText("через прокси", { timeout: 10_000 });
  await guest.context.close();
  await host.context.close();
});

test("a socket that drops comes back and catches up, showing that the link is gone meanwhile", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);
  await pressPlay(host.page);
  await inSync(host.page, guest.page, 0.5);

  for (const socket of [...server.sockets.get(host.code)]) if (socket.peerId === server.peerId(await guest.page.evaluate(() => localStorage.getItem("lampa_stream_wt_peer")))) socket.ws.close({ code: 1011, reason: "drop" });
  await host.page.locator("video").click();
  await expect.poll(async () => (await videoState(guest.page)).paused, { timeout: 10_000 }).toBe(true);
  await guest.context.close();
  await host.context.close();
});

test("series: the host picks an episode, everyone gets it paused at the start", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await host.page.locator(".wt-title", { hasText: SERIES.name }).click();
  await expect(host.page.locator(".wt-episode")).toHaveCount(3);
  await host.page.locator(".wt-episode", { hasText: "Серия 2" }).click();
  await expect(host.page.locator(".wt-bar__title")).toContainText("Сезон 1, серия 2");
  const guest = await guestJoin(server, browser, host.code);
  await expect(guest.page.locator(".wt-bar__title")).toContainText("Сезон 1, серия 2");
  await videoReady(guest.page);
  expect((await videoState(guest.page)).paused).toBe(true);
  await guest.context.close();
  await host.context.close();
});

test("phone: the room fills the screen, video above chat, nothing overflows", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code, {}, { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await videoReady(guest.page);
  const layout = await guest.page.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      video: box("video"),
      send: box(".wt-send"),
      dock: document.querySelector(".mobile-dock, .bottom-dock")?.getBoundingClientRect() ?? null,
      room: box(".wt-room"),
      peopleHidden: getComputedStyle(document.querySelector(".wt-people")).display,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.room.height).toBe(844);
  expect(layout.video.width).toBe(390);
  expect(layout.video.bottom).toBeLessThan(layout.send.top);
  expect(layout.send.bottom).toBeLessThanOrEqual(844);
  expect(layout.peopleHidden).toBe("none");
  // The list and its tools are one tap away.
  await guest.page.getByRole("button", { name: /^Участники/ }).click();
  await expect(guest.page.locator(".wt-people")).toBeVisible();
  await expect(guest.page.locator(".wt-people__code")).toContainText(host.code);
  await guest.context.close();
  await host.context.close();
});

test("a tap on a player that cannot play yet does not move the room", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  await pressPlay(host.page);
  await host.page.waitForTimeout(4000);
  const before = server.rooms.get(host.code).play.seq;

  const guest = await guestJoin(server, browser, host.code);
  // Tap whatever start button exists, as soon as it exists, while the stream attaches.
  await guest.page.evaluate(() => {
    const tap = () => { document.querySelector(".torrplayer-bigplay")?.click(); requestAnimationFrame(tap); };
    tap();
  });
  await videoReady(guest.page);
  await inSync(host.page, guest.page, 0.8);
  expect(server.rooms.get(host.code).play.seq).toBe(before);
  expect((await videoState(host.page)).t).toBeGreaterThan(3);
  await guest.context.close();
  await host.context.close();
});

test("a pause or play keeps the room's position even when this viewer has fallen behind", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  await pressPlay(host.page);
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);
  await inSync(host.page, guest.page, 0.8);
  await host.page.waitForTimeout(3000);

  // The guest's video stands 3 s back when its pause goes out.
  await guest.page.evaluate(() => {
    const v = document.querySelector("video");
    v.currentTime = Math.max(0, v.currentTime - 3);
  });
  await guest.page.locator("video").click();
  await expect.poll(() => server.rooms.get(host.code).play.playing).toBe(false);
  expect(server.rooms.get(host.code).play.position).toBeGreaterThan((await videoState(host.page)).t - 1.5);
  await guest.context.close();
  await host.context.close();
});

test("a new title stops the old video and nothing reports for it until the new one attaches", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const guest = await guestJoin(server, browser, host.code);
  await videoReady(guest.page);
  await pressPlay(host.page);
  await inSync(host.page, guest.page, 0.8);

  // The guest's source search for the next title hangs, as on a slow relay.
  await guest.page.route("**/api/source-host?op=discover", () => {});
  await host.page.getByRole("button", { name: "Сменить фильм" }).click();
  await host.page.locator(".wt-sheet .wt-title", { hasText: SERIES.name }).click();
  await expect(guest.page.locator(".wt-bar__title")).toContainText(SERIES.name);
  await host.page.locator(".wt-episode", { hasText: "Серия 1" }).click();
  await pressPlay(host.page);
  await expect.poll(async () => (await videoState(guest.page))?.paused ?? true).toBe(true);
  const reported = server.commands.length;
  await guest.page.keyboard.press("ArrowRight");
  await guest.page.waitForTimeout(600);
  const guestPeer = server.peerId(await guest.page.evaluate(() => localStorage.getItem("lampa_stream_wt_peer")));
  expect(server.commands.slice(reported).filter((c) => c.command.t === "play" && c.peerId === guestPeer)).toHaveLength(0);
  await guest.context.close();
  await host.context.close();
});

test("a guest without a token keeps the room across a reload; the player's keys stay out of the chat", async ({ browser }) => {
  const server = new RoomsServer();
  const host = await hostRoom(server, browser);
  await pickFilm(host.page);
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await server.attach(page, { token: null, name: "Боря" });
  await page.goto(`/?room=${host.code}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Присоединиться" }).click();
  await videoReady(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".wt-code")).toHaveText(host.code);

  const before = server.commands.filter((c) => c.command.t === "play").length;
  await page.getByRole("button", { name: "Реакция 🔥" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  expect(server.commands.filter((c) => c.command.t === "play")).toHaveLength(before);
  await context.close();
  await host.context.close();
});
