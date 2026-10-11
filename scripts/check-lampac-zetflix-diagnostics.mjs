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
if (existsSync(zetflixPath) && existsSync(baseControllerPath)) {
  const zetflix = readFileSync(zetflixPath, "utf8");
  const baseController = readFileSync(baseControllerPath, "utf8");
  assert.match(zetflix, /if \(checksearch\)\s*\{\s*if \(PlaywrightBrowser\.Status == PlaywrightStatus\.disabled\)\s*return OnError\(\);\s*return Content\("data-json="\);/);
  assert.match(baseController, /public ActionResult OnError\(int statusCode = 503/);
}
const readinessProbe = "http://127.0.0.1:9118/lite/zetflix?checksearch=true&kinopoisk_id=1";
assert.ok(launcher.includes(readinessProbe));
assert.ok(launcher.includes(`if response="$(curl -fsS --max-time 1 '${readinessProbe}' 2>/dev/null)" \\`));
assert.ok(launcher.includes("[ \"$response\" = 'data-json=' ]"));
assert.ok(launcher.includes("Lampac native Playwright did not become ready within 120 seconds"));
assert.ok(launcher.indexOf(readinessProbe) < launcher.indexOf('touch "$SOURCE_ENGINE_READY_FILE"'));

const sourcePath = process.env.LAMPAC_ZETFLIX_SOURCE || "/tmp/lampac-native-1.81.0/module/OnlineRUS/Zetflix/Controller.cs";
const fixture = [
  '            string log = $"{HttpContext.Request.Path.Value}\\n\\nstart init\\n";',
  '                    if (!result.Contains("new Playerjs"))\n                        return null;',
  '                string result = string.IsNullOrEmpty(PHPSESSID) ? null : await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: headers);',
  '                        log += "browser init\\n";\n\n',
  '                        if (page == null)\n                            return null;',
  '                        await page.GotoAsync(uri, new PageGotoOptions()\n                        {\n                            Timeout = 15_000,\n                            WaitUntil = WaitUntilState.NetworkIdle\n                        }).ConfigureAwait(false);',
  '                        log += "page init\\n";\n\n',
  '                        log += $"{result}\\n\\n";\n\n                        if (result == null || result.StartsWith("<script>(function"))',
  '                        if (!result.Contains("new Playerjs"))\n                            return null;\n\n                        return result;',
  '                    log += $"\\nex: {ex}\\n";\n                    return null;',
  '\n                        var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);',
  '\n                var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);',
].join("\n");
const source = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : fixture;
const patched = patchController(source);
assert.ok(patched.includes("[ZetflixDiag] stage=page_null"));
assert.ok(patched.includes("[ZetflixDiag] stage=navigation_exception type="));
assert.ok(patched.includes("[ZetflixDiag] stage=browser_exception type="));
assert.ok(patched.includes("[ZetflixDiag] stage=serial_fallback_result count="));
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
