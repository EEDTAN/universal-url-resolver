import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import { type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { MAX_URL_LENGTH, parseInputUrl } from "@urlresolve/url-parser";
import Fastify, { type FastifyInstance } from "fastify";

type Result = Awaited<ReturnType<typeof resolveUrl>>;

export interface ServerOptions {
  /** Requests to /api/resolve one client may make per minute. Default 30. */
  rateLimit?: number;
  /** Links resolved at the same time, by everyone together. Another request gets 503. Default 8. */
  maxConcurrent?: number;
  /** How long a resolved link is remembered, in milliseconds. Default 0: nothing is. */
  cacheTtlMs?: number;
  /** Most links remembered at once; the oldest goes first. Default 1000. */
  cacheSize?: number;
  /** A browser for the pages that need one. Default: none. */
  browser?: ResolveOptions["browser"];
  /**
   * The address of the reverse proxy in front of the server (several separated by commas, a
   * CIDR such as 10.0.0.0/8, or "loopback"). X-Forwarded-For is believed only from it, so the
   * rate limit counts the client that proxy saw. Default: none, and the header is ignored.
   */
  trustProxy?: string;
  /** DNS and address policy. Default: safeLookup. Tests reach their mock server with another. */
  lookup?: ResolveOptions["lookup"];
  /** Fastify's request log (never the request body). Default false. */
  logger?: boolean;
}

/** Links one client may have resolved at the same time, so that no client takes every place. */
const MAX_PER_CLIENT = 2;
/** Largest result the cache keeps, as JSON: a typical one is well under 1 KiB. */
const MAX_CACHED_SIZE = 16 * 1024;

/**
 * The HTTP API: POST /api/resolve with {"url": "..."} answers with the same result the CLI's
 * --json prints, and GET /api/health with {"status": "ok"}. A link that does not resolve is still
 * answered with 200: the status inside says what happened. Other answers: 400 for a body that is
 * not exactly {"url": "<text>"}, 413 for a body over 16 KiB, 415 for one that is neither JSON nor
 * plain text, 429 for a client over the rate limit or with two links already running, and 503
 * when too many links are being resolved at once.
 */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const {
    rateLimit: perMinute = 30,
    maxConcurrent = 8,
    cacheTtlMs = 0,
    cacheSize = 1000,
    browser,
    trustProxy,
    lookup,
    logger = false,
  } = options;
  const app = Fastify({
    logger,
    trustProxy: trustProxy ?? false,
    bodyLimit: 16 * 1024,
    // Receiving a request (at most 16 KiB) may take this long; the resolution itself is not
    // counted. Without it, Fastify lets a client send its request slowly for ever.
    requestTimeout: 30_000,
    // A strict schema: by default Fastify would turn 42 into "42" and drop unknown fields quietly.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.server.headersTimeout = 10_000;
  await app.register(rateLimit, { global: false });
  const cache = new Map<string, { result: Result; expires: number }>();
  const running = new Map<string, number>();
  let active = 0;

  app.get("/api/health", async () => ({ status: "ok" }));

  app.post(
    "/api/resolve",
    {
      config: { rateLimit: { max: perMinute, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: { url: { type: "string", minLength: 1, maxLength: MAX_URL_LENGTH } },
        },
      },
    },
    async (request, reply) => {
      const { url } = request.body as { url: string };
      // Remembered by the normalized URL, which never holds a user name or password. A link that
      // had one is not remembered at all: its result says they were taken out, which would be
      // wrong for the same link without them.
      const parsed = parseInputUrl(url);
      const key =
        cacheTtlMs > 0 && parsed.ok && !parsed.credentialsRemoved ? parsed.url.href : null;
      const kept = key === null ? undefined : cache.get(key);
      if (kept !== undefined && kept.expires > Date.now()) {
        reply.header("x-cache", "hit");
        return kept.result;
      }
      // Counted the way the rate limit counts clients (IPv6 by network).
      const client = normalizeIP(request.ip);
      const mine = running.get(client) ?? 0;
      if (mine >= MAX_PER_CLIENT) {
        reply.code(429);
        return refusal(
          429,
          `Wait until one of your ${MAX_PER_CLIENT} links being resolved is done.`,
        );
      }
      if (active >= maxConcurrent) {
        reply.code(503).header("retry-after", "1");
        return refusal(503, "Too many links are being resolved at the moment. Try again shortly.");
      }
      // A client that leaves stops its resolution, so that it does not keep one of the places.
      const stop = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) stop.abort();
      });
      active += 1;
      running.set(client, mine + 1);
      try {
        const result = await resolveUrl(url, { browser, lookup, signal: stop.signal });
        if (key !== null && result.status === "RESOLVED") {
          if (JSON.stringify(result).length <= MAX_CACHED_SIZE) {
            // set() on a key already there keeps its old place, so it is deleted first: then it
            // counts as the newest. A Map keeps that order, so the first keys are the oldest.
            cache.delete(key);
            cache.set(key, { result, expires: Date.now() + cacheTtlMs });
            for (const oldest of cache.keys()) {
              if (cache.size <= cacheSize) break;
              cache.delete(oldest);
            }
          }
        }
        if (key !== null) reply.header("x-cache", "miss");
        return result;
      } finally {
        active -= 1;
        const left = (running.get(client) as number) - 1;
        if (left === 0) running.delete(client);
        else running.set(client, left);
      }
    },
  );
  return app;
}

/** The same shape as Fastify's own error answers. */
function refusal(statusCode: 429 | 503, message: string) {
  const error = statusCode === 429 ? "Too Many Requests" : "Service Unavailable";
  return { statusCode, error, message };
}

/** The settings of `pnpm api`, from environment variables (see .env.example). */
export function settingsFromEnv(env: Record<string, string | undefined>) {
  /** A whole number of at least `min`, or undefined when the variable is unset or empty. */
  const number = (name: string, min = 0) => {
    const text = env[name];
    if (text === undefined || text === "") return undefined;
    if (!/^\d+$/.test(text) || Number(text) < min) {
      throw new Error(`${name} must be a whole number, ${min} or more (got "${text}")`);
    }
    return Number(text);
  };
  /** 1 is on; 0, empty or unset is off. */
  const flag = (name: string) => {
    const text = env[name];
    if (text === undefined || text === "" || text === "0") return false;
    if (text === "1") return true;
    throw new Error(`${name} must be 0 or 1 (got "${text}")`);
  };
  const ttlSeconds = number("URLRESOLVE_CACHE_TTL_SECONDS");
  return {
    // This computer only, unless told otherwise: the API is opened to others on purpose.
    host: env.HOST || "127.0.0.1",
    port: number("PORT") ?? 3000,
    browser: flag("URLRESOLVE_BROWSER"),
    options: {
      rateLimit: number("URLRESOLVE_RATE_LIMIT", 1),
      maxConcurrent: number("URLRESOLVE_MAX_CONCURRENT", 1),
      cacheTtlMs: ttlSeconds === undefined ? undefined : ttlSeconds * 1000,
      cacheSize: number("URLRESOLVE_CACHE_SIZE"),
      trustProxy: env.URLRESOLVE_TRUST_PROXY || undefined,
    } satisfies ServerOptions,
  };
}
