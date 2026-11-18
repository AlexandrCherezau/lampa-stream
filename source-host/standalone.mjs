// The source host without the Lampac engine, for a host that only runs Node.
import { createSourceServer } from "./server.mjs";

const server = createSourceServer({
  secret: process.env.SOURCE_HOST_SECRET || "",
  apiKey: process.env.SOURCE_API_KEY || "",
  publicOrigin: process.env.SOURCE_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || "",
  adapter: { async *discover() {} },
});
const port = Number(process.env.PORT || 9120);
server.listen(port, "0.0.0.0", () => console.log(`Source host listening on port ${port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { server.close(); setTimeout(() => process.exit(0), 10_000).unref(); });
