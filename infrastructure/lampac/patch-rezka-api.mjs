import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const anchor = `        var root = await httpHydra.Post<Dictionary<string, object>>(
            uri,
            data,
            safety: safety,
            cookieContainer: cookieContainer,
            newheaders: HeadersModel.JoinReadOnly(base_headers, defaultHeaders)
        );`;

export const REZKA_API_LOOP = `        Dictionary<string, object> root = null;
        foreach (string endpoint in new[] { "/ajax/get_cdn_series/", "/engine/ajax/get_cdn_series/", "/ajax/get_cdn_series.php", "/engine/ajax/get_cdn_series.php" })
        {
            uri = $"{apihost}{endpoint}?t={((DateTimeOffset)DateTime.Now).ToUnixTimeSeconds()}{Random.Shared.Next(101, 999)}";
            root = await httpHydra.Post<Dictionary<string, object>>(
                uri, data, safety: safety, cookieContainer: cookieContainer,
                newheaders: HeadersModel.JoinReadOnly(base_headers, defaultHeaders)
            );
            bool hasStream = root != null && root.TryGetValue("url", out object stream) && !string.IsNullOrWhiteSpace(stream?.ToString()) && !stream.ToString().Contains("false", StringComparison.OrdinalIgnoreCase);
            bool accessDenied = root != null && root.TryGetValue("message", out object message) && Regex.IsMatch(message?.ToString() ?? "", @"авториза|войд|premium|премиум|заблок|authorization|log.?in|forbidden", RegexOptions.IgnoreCase);
            Console.WriteLine($"[RezkaApi] endpoint={endpoint} response={root != null} stream={hasStream} denied={accessDenied}");
            if (hasStream || accessDenied) break;
        }`;

export function patchRezkaApi(source) {
  if (source.includes("[RezkaApi]")) return source;
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + anchor.length) >= 0) throw new Error("Lampac 1.81.0 Rezka API anchor mismatch");
  return source.replace(anchor, REZKA_API_LOOP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node patch-rezka-api.mjs /lampac/module/OnlinePaid/Rezka/Service.cs");
  writeFileSync(target, patchRezkaApi(readFileSync(target, "utf8")));
}
