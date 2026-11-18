// Profile objects in one Durable Object: the conditional writes the profile code expects from its store.
import { DurableObject } from "cloudflare:workers";

export class ProfileStore extends DurableObject {
  constructor(context, env) {
    super(context, env);
    context.storage.sql.exec("CREATE TABLE IF NOT EXISTS objects (path TEXT PRIMARY KEY, body TEXT NOT NULL, etag TEXT NOT NULL)");
  }

  read(path) {
    return this.ctx.storage.sql.exec("SELECT body, etag FROM objects WHERE path = ?", path).toArray()[0] || null;
  }

  write(path, body, { allowOverwrite = false, ifMatch = "" } = {}) {
    const current = this.read(path);
    if (current && !allowOverwrite) return { conflict: "BLOB_ALREADY_EXISTS" };
    if (ifMatch && current?.etag !== ifMatch) return { conflict: "BLOB_PRECONDITION_FAILED" };
    const etag = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO objects (path, body, etag) VALUES (?, ?, ?)", path, body, etag);
    return { etag };
  }

  remove(paths) {
    for (const path of paths) this.ctx.storage.sql.exec("DELETE FROM objects WHERE path = ?", path);
  }
}

export function profileBlobStore(namespace) {
  const store = () => namespace.get(namespace.idFromName("profiles"));
  return {
    async get(path) {
      const row = await store().read(path);
      if (!row) return null;
      return { statusCode: 200, stream: new Response(row.body).body, blob: { etag: row.etag, size: new TextEncoder().encode(row.body).length } };
    },
    async head(path) {
      const row = await store().read(path);
      return row ? { etag: row.etag } : null;
    },
    async put(path, body, options = {}) {
      const result = await store().write(path, String(body), { allowOverwrite: !!options.allowOverwrite, ifMatch: options.ifMatch || "" });
      if (result.conflict) throw Object.assign(new Error("Profile object changed"), { code: result.conflict });
      return result;
    },
    async del(paths) {
      await store().remove([paths].flat());
    },
  };
}
