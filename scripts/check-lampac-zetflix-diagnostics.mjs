import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { patchController } from "../infrastructure/lampac/patch-zetflix-diagnostics.mjs";

const dockerfile = readFileSync(new URL("../infrastructure/lampac/Dockerfile.vercel", import.meta.url), "utf8");
const launcher = readFileSync(new URL("../infrastructure/lampac/start-vercel.sh", import.meta.url), "utf8");
const patchCall = "patch-zetflix-diagnostics.mjs /lampac/module/OnlineRUS/Zetflix/Controller.cs";
assert.ok(dockerfile.includes("COPY infrastructure/lampac/patch-zetflix-diagnostics.mjs"));
assert.ok(dockerfile.includes(patchCall));
assert.ok(dockerfile.indexOf(patchCall) < dockerfile.indexOf("Core.dll >/tmp/lampac-module-prewarm.log"));

const zetflixPath = "/tmp/lampac-native-1.81.0/module/OnlineRUS/Zetflix/Controller.cs";
const baseControllerPath = "/tmp/lampac-zetflix-research/Shared/Controllers/BaseOnlineController.cs";
const sourcePath = process.env.LAMPAC_ZETFLIX_SOURCE || zetflixPath;
if (!existsSync(sourcePath)) throw new Error(`Pinned Lampac Zetflix source required at ${sourcePath}; set LAMPAC_ZETFLIX_SOURCE to its path`);
if (!existsSync(baseControllerPath)) throw new Error(`Pinned Lampac BaseOnlineController source required at ${baseControllerPath}`);
const zetflix = readFileSync(sourcePath, "utf8");
const baseController = readFileSync(baseControllerPath, "utf8");
assert.match(zetflix, /if \(checksearch\)\s*\{\s*if \(PlaywrightBrowser\.Status == PlaywrightStatus\.disabled\)\s*return OnError\(\);\s*return Content\("data-json="\);/);
assert.match(baseController, /public ActionResult OnError\(int statusCode = 503/);
const readinessProbe = "http://127.0.0.1:9118/lite/zetflix?checksearch=true&kinopoisk_id=1";
assert.ok(launcher.includes(readinessProbe));
assert.ok(launcher.includes(`if response="$(curl -fsS --max-time 1 '${readinessProbe}' 2>/dev/null)" \\`));
assert.ok(launcher.includes("[ \"$response\" = 'data-json=' ]"));
assert.ok(launcher.includes("Lampac native Playwright did not become ready within 120 seconds"));
assert.ok(launcher.indexOf(readinessProbe) < launcher.indexOf('touch "$SOURCE_ENGINE_READY_FILE"'));

const source = zetflix;
const patched = patchController(source);
assert.ok(patched.includes("[ZetflixDiag] stage=page_null"));
assert.ok(patched.includes("[ZetflixDiag] stage=navigation_exception type="));
assert.ok(patched.includes("[ZetflixDiag] stage=browser_exception type="));
assert.ok(patched.includes("[ZetflixDiag] stage=serial_fallback_result count="));
const originalPlayerjsFetch = '                    html = string.IsNullOrEmpty(PHPSESSID) ? null :\n                        await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: reqHeaders);';
assert.ok(patched.includes(originalPlayerjsFetch), "diagnostics must preserve native Playerjs fetch behavior");
assert.ok(patched.indexOf("stage=playerjs_fetch_skipped_no_session") < patched.indexOf(originalPlayerjsFetch));
for (const stage of [
  "video_start", "video_playwright_disabled", "video_request_blocked", "video_no_quality",
  "video_quality_count count=", "player_page_empty", "player_iframe_missing", "player_iframe_other",
  "player_iframe_obrut", "obrut_no_quality", "obrut_iframe_empty", "obrut_root_parse_failed",
  "obrut_file_missing", "obrut_quality_missing", "playerjs_fetch_skipped_no_session",
  "playerjs_html_empty", "playerjs_marker_missing", "playerjs_embed_empty", "playerjs_no_matching_quality",
  "obrut_seasons_missing", "obrut_season_missing", "obrut_episode_list_missing", "obrut_episode_missing",
  "obrut_voice_match_missing", "obrut_voice_match_found",
]) assert.ok(patched.includes(`[ZetflixDiag] stage=${stage}`), `missing safe Video diagnostic stage ${stage}`);
assert.ok(!patched.includes("string log ="));
assert.ok(!patched.includes("log += "));
const diagnosticWrites = [...patched.matchAll(/Console\.WriteLine\(([^;]+)\);/g)].map((match) => match[1]);
assert.ok(diagnosticWrites.length >= 10);
for (const line of diagnosticWrites) {
  assert.ok(line.includes("[ZetflixDiag]"));
  assert.doesNotMatch(line, /\+.*(HttpContext|PHPSESSID|result|href|title|cookie|ex\.Message|ex\.ToString)/);
}
assert.ok(!patched.includes('log += $"{result}'));
assert.ok(!patched.includes("log += $\"\\nex: {ex}"));
assert.throws(() => patchController(source.replace('string log = ', 'string logs = ')), /anchor mismatch/);
assert.throws(() => patchController(patched), /already applied/);

const tempDir = mkdtempSync(join(tmpdir(), "lampac-zetflix-diag-"));
try {
  const gateStart = launcher.lastIndexOf("attempt=0", launcher.indexOf(readinessProbe));
  const gateEnd = launcher.indexOf('chmod 0600 "$SOURCE_ENGINE_READY_FILE"');
  const gate = launcher.slice(gateStart, gateEnd);
  const readinessFile = join(tempDir, "ready");
  const attemptsFile = join(tempDir, "attempts");
  const mock = `set -eu
node_pid=$$; lampac_pid=$$
sleep() { :; }
curl() {
  count=0; [ ! -f "$ATTEMPTS_FILE" ] || count=$(cat "$ATTEMPTS_FILE")
  count=$((count + 1)); printf '%s' "$count" > "$ATTEMPTS_FILE"
  [ ! -f "$SOURCE_ENGINE_READY_FILE" ] || exit 90
  case "$count" in
    1) return 22 ;;
    2) printf pong ;;
    *) printf data-json= ;;
  esac
}
`;
  execFileSync("sh", ["-c", mock + gate], {
    env: { ...process.env, SOURCE_ENGINE_READY_FILE: readinessFile, ATTEMPTS_FILE: attemptsFile },
  });
  assert.ok(existsSync(readinessFile));
  assert.equal(readFileSync(attemptsFile, "utf8"), "3");
  const target = join(tempDir, "Controller.cs");
  writeFileSync(target, source);
  execFileSync(process.execPath, [fileURLToPath(new URL("../infrastructure/lampac/patch-zetflix-diagnostics.mjs", import.meta.url)), target]);
  assert.equal(readFileSync(target, "utf8"), patched);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("../infrastructure/lampac/patch-zetflix-diagnostics.mjs", import.meta.url)), target], { stdio: "ignore" }));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("Lampac Zetflix diagnostic patch checks passed");
