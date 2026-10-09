import { request, type ServerResponse } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../../../tests/fixtures/mock-server.ts";
import { buildServer, type ServerOptions, settingsFromEnv } from "./server.ts";

const at = (host: string, path: string) => mock.url(host, path).href;

const html =
  (body: string, status = 200): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
  };
const to =
  (location: string): Route =>
  (_req, res) => {
    res.writeHead(301, { location }).end();
  };

// Answers only when the test lets it go.
const held: ServerResponse[] = [];
const release = () => {
  for (const res of held.splice(0)) html("<p>held</p>")(undefined as never, res);
};
// A final URL so long that its result is too big for the cache.
const BIG = `/page?${"a=1&".repeat(1900)}z=1`;

const mock = await startMockServer({
  "short.test/abc": to("/page?id=1&utm_source=x"),
  "short.test/other": to("/page?id=1&utm_source=x"),
  "short.test/third": to("/page?id=1&utm_source=x"),
  "short.test/page?id=1&utm_source=x": html("<p>destination</p>"),
  "short.test/big": to(BIG),
  [`short.test${BIG}`]: html("<p>big</p>"),
  "short.test/gone": html("<p>not here</p>", 404),
  "short.test/inside": (_req, res) => {
    res.writeHead(302, { location: "http://inside.test/" }).end();
  },
  "short.test/held": (_req, res) => {
    held.push(res);
  },
  "short.test/slow": () => {}, // never answers
});
afterAll(() => {
  release();
  return mock.close();
});

/** *.test is 127.0.0.1; inside.test is refused, as safeLookup refuses a private address. */
const lookup: LookupFunction = (hostname, options, callback) => {
  if (hostname === "inside.test") {
    const error = new Error(`${hostname} is a private or reserved address`);
    callback(Object.assign(error, { code: "BLOCKED" }), "");
  } else {
    fakeLookup(hostname, options, callback);
  }
};

const requestsFor = (path: string) => mock.requests.filter((req) => req.url === path).length;

async function api(options: ServerOptions = {}) {
  const app = await buildServer({ lookup, ...options });
  const resolve = (
    body: unknown,
    extra: { remoteAddress?: string; headers?: Record<string, string> } = {},
  ) => app.inject({ method: "POST", url: "/api/resolve", payload: body as object, ...extra });
  return { app, resolve };
}

describe("GET /api/health", () => {
  it("answers ok, and is not rate limited", async () => {
    const { app } = await api();
    const reply = await app.inject({ method: "GET", url: "/api/health" });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ status: "ok" });
    expect(reply.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("POST /api/resolve", () => {
  it("answers with the resolver's result", async () => {
    const { resolve } = await api();
    const reply = await resolve({ url: at("short.test", "/abc") });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      originalUrl: at("short.test", "/abc"),
      finalUrl: at("short.test", "/page?id=1&utm_source=x"),
      status: "RESOLVED",
      tracking: { cleanUrl: at("short.test", "/page?id=1") },
    });
  });

  it.each([
    ["/gone", "UNRESOLVED"],
    ["/inside", "BLOCKED"],
  ])("answers %s with 200 and the status inside (%s)", async (path, status) => {
    const { resolve } = await api();
    const reply = await resolve({ url: at("short.test", path) });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().status).toBe(status);
  });

  it("answers a link it cannot read with INVALID_URL", async () => {
    const { resolve } = await api();
    expect((await resolve({ url: "javascript:alert(1)" })).json()).toMatchObject({
      status: "INVALID_URL",
      finalUrl: null,
    });
  });

  it("keeps the address policy of safeLookup when it is given no lookup", async () => {
    const app = await buildServer();
    const before = requestsFor("/abc");
    const reply = await app.inject({
      method: "POST",
      url: "/api/resolve",
      payload: { url: `http://127.0.0.1:${mock.port}/abc` },
    });
    expect(reply.json().status).toBe("BLOCKED");
    expect(requestsFor("/abc")).toBe(before);
  });

  it.each([
    ["no url", {}],
    ["a url that is not text", { url: 42 }],
    ["an empty url", { url: "" }],
    ["anything besides url", { url: "https://a.test/", maxRedirects: 99 }],
  ])("refuses a body with %s with 400", async (_what, body) => {
    const { resolve } = await api();
    expect((await resolve(body)).statusCode).toBe(400);
  });

  it("takes a url of up to 8192 characters", async () => {
    const { resolve } = await api();
    const of = (length: number) => `javascript:${"x".repeat(length - "javascript:".length)}`;
    expect((await resolve({ url: of(8192) })).statusCode).toBe(200);
    expect((await resolve({ url: of(8193) })).statusCode).toBe(400);
  });

  it.each([
    ["text/plain", "https://a.test/", 400],
    ["application/xml", "<url>https://a.test/</url>", 415],
    ["application/json", `{"url": "javascript:1"}${" ".repeat(20_000)}`, 413],
  ])("answers a body sent as %s the way the README says", async (type, payload, status) => {
    const { app } = await api();
    const reply = await app.inject({
      method: "POST",
      url: "/api/resolve",
      headers: { "content-type": type },
      payload,
    });
    expect(reply.statusCode).toBe(status);
  });

  it("gives up on a request that is received too slowly", async () => {
    const { app } = await api();
    expect([app.server.requestTimeout, app.server.headersTimeout]).toEqual([30_000, 10_000]);
  });
});

describe("rate limit", () => {
  it("answers 429 to a client over the limit, for the rest of the minute", async () => {
    const { resolve } = await api({ rateLimit: 2 });
    const replies = [];
    for (let i = 0; i < 3; i += 1) replies.push(await resolve({ url: "javascript:1" }));
    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200, 429]);
    expect(replies[2]?.headers["retry-after"]).toBe("60");
  });

  it("counts every client on its own", async () => {
    const { resolve } = await api({ rateLimit: 1 });
    const codes = [];
    for (const remoteAddress of ["10.0.0.1", "10.0.0.1", "10.0.0.2"]) {
      codes.push((await resolve({ url: "javascript:1" }, { remoteAddress })).statusCode);
    }
    expect(codes).toEqual([200, 429, 200]);
  });

  it("ignores X-Forwarded-For when no proxy is named", async () => {
    const { resolve } = await api({ rateLimit: 1 });
    const codes = [];
    for (const forwarded of ["1.1.1.1", "2.2.2.2"]) {
      const headers = { "x-forwarded-for": forwarded };
      codes.push((await resolve({ url: "javascript:1" }, { headers })).statusCode);
    }
    expect(codes).toEqual([200, 429]);
  });

  it("counts the client a named proxy saw, whatever the client wrote before it", async () => {
    const { resolve } = await api({ rateLimit: 1, trustProxy: "127.0.0.1" });
    const codes = [];
    for (const forwarded of [
      "198.51.100.1, 203.0.113.7",
      "198.51.100.2, 203.0.113.7",
      "198.51.100.2, 203.0.113.8",
    ]) {
      const headers = { "x-forwarded-for": forwarded };
      codes.push((await resolve({ url: "javascript:1" }, { headers })).statusCode);
    }
    expect(codes).toEqual([200, 429, 200]);
  });
});

describe("links being resolved at once", () => {
  it("answers 503 when every place is taken, and resolves nothing for it", async () => {
    const { resolve } = await api({ maxConcurrent: 1 });
    const before = requestsFor("/held");
    const first = resolve({ url: at("short.test", "/held") }, { remoteAddress: "10.0.0.1" });
    await vi.waitFor(() => expect(requestsFor("/held")).toBe(before + 1));
    const abc = requestsFor("/abc");
    for (const remoteAddress of ["10.0.0.2", "10.0.0.3"]) {
      const busy = await resolve({ url: at("short.test", "/abc") }, { remoteAddress });
      expect(busy.statusCode).toBe(503);
      expect(busy.headers["retry-after"]).toBe("1");
      expect(busy.json()).toEqual({
        statusCode: 503,
        error: "Service Unavailable",
        message: expect.any(String),
      });
    }
    expect(requestsFor("/abc")).toBe(abc);
    release();
    expect((await first).json().status).toBe("RESOLVED");
  });

  it("lets one client have two links resolved at once, not more", async () => {
    const { resolve } = await api();
    const before = requestsFor("/held");
    const mine = { remoteAddress: "10.0.0.1" };
    const first = resolve({ url: at("short.test", "/held") }, mine);
    const second = resolve({ url: at("short.test", "/held") }, mine);
    await vi.waitFor(() => expect(requestsFor("/held")).toBe(before + 2));
    const third = await resolve({ url: at("short.test", "/abc") }, mine);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
    const other = await resolve({ url: at("short.test", "/abc") }, { remoteAddress: "10.0.0.2" });
    expect(other.statusCode).toBe(200);
    release();
    await Promise.all([first, second]);
    // Both places are free again.
    expect((await resolve({ url: at("short.test", "/abc") }, mine)).statusCode).toBe(200);
  });

  it("stops a resolution when its client leaves, and frees its place", async () => {
    const { app, resolve } = await api({ maxConcurrent: 1 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const { port } = app.server.address() as AddressInfo;
      const leaving = request({ host: "127.0.0.1", port, method: "POST", path: "/api/resolve" });
      leaving.on("error", () => {});
      leaving.setHeader("content-type", "application/json");
      leaving.end(JSON.stringify({ url: at("short.test", "/slow") }));
      await new Promise((done) => setTimeout(done, 200));
      leaving.destroy();
      await new Promise((done) => setTimeout(done, 200));
      // Over a real connection too, so that a reply that ends normally is seen as well.
      const status = await new Promise<number | undefined>((done) => {
        const next = request({ host: "127.0.0.1", port, method: "POST", path: "/api/resolve" });
        next.setHeader("content-type", "application/json");
        next.on("response", (answer) => {
          answer.resume();
          answer.on("end", () => done(answer.statusCode));
        });
        next.end(JSON.stringify({ url: at("short.test", "/abc") }));
      });
      expect(status).toBe(200);
      expect((await resolve({ url: at("short.test", "/abc") })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("the cache", () => {
  const hitOrMiss = async (resolve: Awaited<ReturnType<typeof api>>["resolve"], path: string) =>
    (await resolve({ url: at("short.test", path) })).headers["x-cache"];

  it("is off unless asked for", async () => {
    const { resolve } = await api();
    const before = requestsFor("/abc");
    expect(await hitOrMiss(resolve, "/abc")).toBeUndefined();
    await resolve({ url: at("short.test", "/abc") });
    expect(requestsFor("/abc") - before).toBe(2);
  });

  it("remembers a resolved link for its time, and no longer", async () => {
    const { resolve } = await api({ cacheTtlMs: 300 });
    const before = requestsFor("/abc");
    const first = await resolve({ url: at("short.test", "/abc") });
    const second = await resolve({ url: at("short.test", "/abc") });
    expect([first.headers["x-cache"], second.headers["x-cache"]]).toEqual(["miss", "hit"]);
    expect(second.json()).toEqual(first.json());
    expect(requestsFor("/abc") - before).toBe(1);
    await new Promise((done) => setTimeout(done, 400));
    expect(await hitOrMiss(resolve, "/abc")).toBe("miss");
  });

  it("remembers only resolved links", async () => {
    const { resolve } = await api({ cacheTtlMs: 60_000 });
    const before = requestsFor("/gone");
    await resolve({ url: at("short.test", "/gone") });
    await resolve({ url: at("short.test", "/gone") });
    expect(requestsFor("/gone") - before).toBe(2);
  });

  it("never keeps a link with a user name or password in it", async () => {
    const { resolve } = await api({ cacheTtlMs: 60_000 });
    const withUser = at("short.test", "/abc").replace("//", "//user:s3cret@");
    await resolve({ url: at("short.test", "/abc") });
    const reply = await resolve({ url: withUser });
    expect(reply.headers["x-cache"]).toBeUndefined();
    expect(reply.json().security.credentialsRemoved).toBe(true);
  });

  it("does not keep a result too big to keep", async () => {
    const { resolve } = await api({ cacheTtlMs: 60_000 });
    expect([await hitOrMiss(resolve, "/big"), await hitOrMiss(resolve, "/big")]).toEqual([
      "miss",
      "miss",
    ]);
  });

  it("forgets the oldest link when it is full", async () => {
    const { resolve } = await api({ cacheTtlMs: 60_000, cacheSize: 1 });
    await resolve({ url: at("short.test", "/abc") });
    await resolve({ url: at("short.test", "/other") });
    expect(await hitOrMiss(resolve, "/other")).toBe("hit");
    expect(await hitOrMiss(resolve, "/abc")).toBe("miss");
  });

  it("counts a link resolved again as the newest", async () => {
    const { resolve } = await api({ cacheTtlMs: 500, cacheSize: 2 });
    await resolve({ url: at("short.test", "/abc") });
    await new Promise((done) => setTimeout(done, 550)); // /abc's time is up
    await resolve({ url: at("short.test", "/other") });
    expect(await hitOrMiss(resolve, "/abc")).toBe("miss"); // now newer than /other
    await resolve({ url: at("short.test", "/third") }); // pushes /other out
    expect(await hitOrMiss(resolve, "/abc")).toBe("hit");
    expect(await hitOrMiss(resolve, "/other")).toBe("miss");
  });
});

describe("settingsFromEnv", () => {
  it("leaves every setting to buildServer when nothing is set", () => {
    expect(settingsFromEnv({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      browser: false,
      options: {
        rateLimit: undefined,
        maxConcurrent: undefined,
        cacheTtlMs: undefined,
        cacheSize: undefined,
        trustProxy: undefined,
      },
    });
  });

  it("reads every variable", () => {
    expect(
      settingsFromEnv({
        HOST: "0.0.0.0",
        PORT: "8080",
        URLRESOLVE_BROWSER: "1",
        URLRESOLVE_RATE_LIMIT: "60",
        URLRESOLVE_MAX_CONCURRENT: "4",
        URLRESOLVE_CACHE_TTL_SECONDS: "300",
        URLRESOLVE_CACHE_SIZE: "50",
        URLRESOLVE_TRUST_PROXY: "10.0.0.0/8",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 8080,
      browser: true,
      options: {
        rateLimit: 60,
        maxConcurrent: 4,
        cacheTtlMs: 300_000,
        cacheSize: 50,
        trustProxy: "10.0.0.0/8",
      },
    });
  });

  it.each([
    [{ PORT: "one" }, 'PORT must be a whole number, 0 or more (got "one")'],
    [{ URLRESOLVE_RATE_LIMIT: "0" }, "URLRESOLVE_RATE_LIMIT must be a whole number, 1 or more"],
    [{ URLRESOLVE_MAX_CONCURRENT: "0" }, "URLRESOLVE_MAX_CONCURRENT must be a whole number, 1"],
    [{ URLRESOLVE_BROWSER: "true" }, 'URLRESOLVE_BROWSER must be 0 or 1 (got "true")'],
  ])("refuses %j", (env, message) => {
    expect(() => settingsFromEnv(env)).toThrow(message);
  });
});
