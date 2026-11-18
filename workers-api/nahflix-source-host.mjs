// The source host as a Worker: the same Node server, without the Lampac engine a Worker cannot run.
import { httpServerHandler } from "cloudflare:node";
import { createSourceServer } from "../source-host/server.mjs";
import { createTransport } from "../source-host/transport.mjs";
import { createMedia } from "../source-host/media.mjs";
import { createVi3000Provider } from "../source-host/providers/vi3000.mjs";
import { createHabsterProvider } from "../source-host/providers/habster.mjs";
import { createAllMangaProvider } from "../source-host/providers/allmanga.mjs";
import { createKinoarcProvider } from "../source-host/providers/kinoarc.mjs";
import { publicLookup } from "./public-lookup.mjs";
import { fetchRequestOnce } from "./fetch-request.mjs";

const PORT = 9120;
const transport = () => createTransport({ lookup: publicLookup, requestOnceImpl: fetchRequestOnce });

// Built on the first request: random values are not available while the module loads.
function start() {
  const secret = process.env.SOURCE_HOST_SECRET || "";
  const publicOrigin = process.env.SOURCE_PUBLIC_ORIGIN || "";
  const mediaTransport = transport();
  createSourceServer({
    secret,
    apiKey: process.env.SOURCE_API_KEY || "",
    publicOrigin,
    transport: mediaTransport,
    media: createMedia({ transport: mediaTransport, secret, publicOrigin }),
    adapter: { async *discover() {} },
    viAdapter: createVi3000Provider({ transport: transport() }),
    habsterAdapter: createHabsterProvider({ transport: transport() }),
    allmangaAdapter: createAllMangaProvider({ transport: transport() }),
    kinoarcAdapter: createKinoarcProvider({ transport: transport() }),
  }).listen(PORT);
  return httpServerHandler({ port: PORT });
}

let handler;
export default {
  fetch(request, env, context) {
    handler ||= start();
    return handler.fetch(request, env, context);
  },
};
