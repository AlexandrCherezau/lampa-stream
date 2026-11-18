// Workers have no system resolver: answer the transport's address check over DNS-over-HTTPS.
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 200;
const cache = new Map();

async function query(hostname, type, family) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
    headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`DNS query failed with HTTP ${response.status}`);
  const answer = (await response.json()).Answer || [];
  return answer.filter((record) => record.type === (family === 4 ? 1 : 28)).map((record) => ({ address: record.data, family }));
}

export async function publicLookup(hostname) {
  const hit = cache.get(hostname);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.addresses;
  let addresses = await query(hostname, "A", 4);
  if (!addresses.length) addresses = await query(hostname, "AAAA", 6);
  if (!addresses.length) throw Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(hostname, { at: Date.now(), addresses });
  return addresses;
}
