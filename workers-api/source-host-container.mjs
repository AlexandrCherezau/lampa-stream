import { DurableObject } from "cloudflare:workers";

const INTERNAL_PORT = 9120;
const HEALTH_URL = "http://container/healthz";
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_FETCH_TIMEOUT_MS = 1_500;
const HEALTH_POLL_INTERVAL_MS = 250;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

function validateStartEnvironment(env) {
  const secret = env?.SOURCE_HOST_SECRET;
  const apiKey = env?.SOURCE_API_KEY;
  const publicOrigin = env?.SOURCE_PUBLIC_ORIGIN;
  if (typeof secret !== "string" || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("invalid source-host configuration");
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("invalid source-host configuration");
  }

  let origin;
  try { origin = new URL(publicOrigin); }
  catch { throw new Error("invalid source-host configuration"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("invalid source-host configuration");
  }

  return {
    SOURCE_HOST_SECRET: secret,
    SOURCE_API_KEY: apiKey,
    SOURCE_PUBLIC_ORIGIN: origin.origin,
  };
}

function unavailable(message = "Source host is temporarily unavailable", status = 503) {
  return new Response(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
}

export class SourceHostContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.initializationPromise = null;
    // running is only lifecycle information. We still require a successful health probe per DO activation.
    this.healthVerified = false;

    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)).catch(() => {});
    }
  }

  async ensureContainerReady(startEnv) {
    const container = this.ctx.container;
    if (!container) throw new Error("container unavailable");

    if (!container.running) this.healthVerified = false;
    if (container.running && this.healthVerified) return;

    if (!this.initializationPromise) {
      this.initializationPromise = this.startAndProbe(container, startEnv);
    }
    const pending = this.initializationPromise;
    try {
      await pending;
      this.healthVerified = true;
    } catch (error) {
      this.healthVerified = false;
      throw error;
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = null;
    }
  }

  async startAndProbe(container, startEnv) {
    if (!container.running) {
      container.start({ enableInternet: true, env: startEnv });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(INTERNAL_PORT);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      let timeout;
      try {
        const request = new Request(HEALTH_URL, { method: "GET", signal: controller.signal });
        const healthRequest = port.fetch(request);
        const healthTimeout = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("health timeout"));
          }, HEALTH_FETCH_TIMEOUT_MS);
        });
        const response = await Promise.race([healthRequest, healthTimeout]);
        if (response.ok) {
          await response.body?.cancel().catch(() => {});
          clearTimeout(timeout);
          return;
        }
        await response.body?.cancel().catch(() => {});
      } catch {
        // Retry only the bounded internal readiness probe; the client request is forwarded once.
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error("source-host readiness timeout");
  }

  async fetch(request) {
    let startEnv;
    try { startEnv = validateStartEnvironment(this.env); }
    catch { return unavailable("Source host configuration unavailable"); }

    const container = this.ctx.container;
    if (!container) return unavailable();
    if (!container.running) this.healthVerified = false;

    try {
      await this.ensureContainerReady(startEnv);
      return await container.getTcpPort(INTERNAL_PORT).fetch(request);
    } catch {
      // A forwarding failure can mean the port stopped accepting connections while the VM still reports running.
      this.healthVerified = false;
      return unavailable();
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await env.SOURCE_HOST.getByName("source-host").fetch(request);
    } catch {
      return unavailable();
    }
  },
};
