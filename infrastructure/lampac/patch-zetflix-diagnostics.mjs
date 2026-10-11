import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "[ZetflixDiag]";
const replacements = [
  [
    '            string log = $"{HttpContext.Request.Path.Value}\\n\\nstart init\\n";',
    '            Console.WriteLine("[ZetflixDiag] stage=index_start");',
  ],
  [
    '                    if (!result.Contains("new Playerjs"))\n                        return null;',
    '                    if (!result.Contains("new Playerjs"))\n                    {\n                        Console.WriteLine("[ZetflixDiag] stage=http_playerjs_missing");\n                        return null;\n                    }\n\n                    Console.WriteLine("[ZetflixDiag] stage=http_playerjs_present");',
  ],
  [
    '                string result = string.IsNullOrEmpty(PHPSESSID) ? null : await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: headers);',
    '                string result = string.IsNullOrEmpty(PHPSESSID) ? null : await Http.Get(uri, proxy: proxy, cookie: $"PHPSESSID={PHPSESSID}", headers: headers);\n                if (string.IsNullOrEmpty(PHPSESSID))\n                    Console.WriteLine("[ZetflixDiag] stage=http_skipped_no_session");\n                else if (result == null)\n                    Console.WriteLine("[ZetflixDiag] stage=http_empty");\n                else if (result.StartsWith("<script>(function"))\n                    Console.WriteLine("[ZetflixDiag] stage=http_challenge");',
  ],
  [
    '                        log += "browser init\\n";\n\n',
    '                        Console.WriteLine("[ZetflixDiag] stage=browser_fallback");\n\n',
  ],
  [
    '                        if (page == null)\n                            return null;',
    '                        if (page == null)\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=page_null");\n                            return null;\n                        }',
  ],
  [
    '                        await page.GotoAsync(uri, new PageGotoOptions()\n                        {\n                            Timeout = 15_000,\n                            WaitUntil = WaitUntilState.NetworkIdle\n                        }).ConfigureAwait(false);',
    '                        try\n                        {\n                            await page.GotoAsync(uri, new PageGotoOptions()\n                            {\n                                Timeout = 15_000,\n                                WaitUntil = WaitUntilState.NetworkIdle\n                            }).ConfigureAwait(false);\n                        }\n                        catch (Exception ex)\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=navigation_exception type=" + ex.GetType().Name);\n                            throw;\n                        }',
  ],
  [
    '                        log += "page init\\n";\n\n',
    '',
  ],
  [
    '                        log += $"{result}\\n\\n";\n\n                        if (result == null || result.StartsWith("<script>(function"))',
    '                        if (result == null)\n                            Console.WriteLine("[ZetflixDiag] stage=browser_empty");\n                        else if (result.StartsWith("<script>(function"))\n                            Console.WriteLine("[ZetflixDiag] stage=browser_challenge");\n\n                        if (result == null || result.StartsWith("<script>(function"))',
  ],
  [
    '                        if (!result.Contains("new Playerjs"))\n                            return null;\n\n                        return result;',
    '                        if (!result.Contains("new Playerjs"))\n                        {\n                            Console.WriteLine("[ZetflixDiag] stage=browser_playerjs_missing");\n                            return null;\n                        }\n\n                        Console.WriteLine("[ZetflixDiag] stage=browser_playerjs_present");\n                        return result;',
  ],
  [
    '                    log += $"\\nex: {ex}\\n";\n                    return null;',
    '                    Console.WriteLine("[ZetflixDiag] stage=browser_exception type=" + ex.GetType().Name);\n                    return null;',
  ],
  [
    '\n                        var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);',
    '\n                        Console.WriteLine("[ZetflixDiag] stage=serial_fallback_start");\n                        var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);\n                        Console.WriteLine("[ZetflixDiag] stage=serial_fallback_result count=" + (fallbackSerial?.pl?.Count ?? 0));',
  ],
  [
    '\n                var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);',
    '\n                Console.WriteLine("[ZetflixDiag] stage=serial_fallback_start");\n                var fallbackSerial = await CaptureBestSerialFallback(ztfhost, id, kinopoisk_id, rs, retry: true);\n                Console.WriteLine("[ZetflixDiag] stage=serial_fallback_result count=" + (fallbackSerial?.pl?.Count ?? 0));',
  ],
];

export function patchController(source) {
  if (source.includes(MARKER)) throw new Error("Zetflix diagnostics patch already applied");
  let output = source;
  for (const [anchor, replacement] of replacements) {
    const first = output.indexOf(anchor);
    if (first < 0 || output.indexOf(anchor, first + anchor.length) >= 0) {
      throw new Error("Lampac 1.81.0 Zetflix source anchor mismatch");
    }
    output = output.slice(0, first) + replacement + output.slice(first + anchor.length);
  }
  if (output.includes('log += $"{result}')) throw new Error("Unsafe full HTML logging remains");
  if (output.includes("log += $\"\\nex: {ex}")) throw new Error("Unsafe exception logging remains");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node patch-zetflix-diagnostics.mjs /lampac/module/OnlineRUS/Zetflix/Controller.cs");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, patchController(original));
}
