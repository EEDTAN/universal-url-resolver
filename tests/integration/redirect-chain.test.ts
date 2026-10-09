import { DEFAULT_MAX_REDIRECTS, type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

/** The absolute URL of a mock site. Routes call it at request time, once the port is known. */
const at = (host: string, path: string) => server.url(host, path).href;

const ok: Route = (_req, res) => {
  res.end("ok");
};

const answer =
  (status: number): Route =>
  (_req, res) => {
    res.writeHead(status).end();
  };

const go =
  (location: string | (() => string), status = 302, headers: Record<string, string> = {}): Route =>
  (_req, res) => {
    const target = typeof location === "string" ? location : location();
    res.writeHead(status, { location: target, ...headers }).end();
  };

/** count.test/n0 -> /n1 -> /n2 ... long enough to pass any limit used below. */
const endlessChain = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`count.test/n${i}`, go(`/n${i + 1}`)]),
);

/** slow.test/s0 -> /s1 -> ... with a pause before every answer. */
const slowChain = Object.fromEntries(
  Array.from({ length: 40 }, (_, i): [string, Route] => [
    `slow.test/s${i}`,
    (_req, res) => {
      setTimeout(() => res.writeHead(302, { location: `/s${i + 1}` }).end(), 60);
    },
  ]),
);

const server = await startMockServer({
  ...Object.fromEntries(
    [301, 302, 303, 307, 308].map((s) => [
      `short.test/r${s}`,
      go(() => at("dest.test", "/page"), s),
    ]),
  ),
  "dest.test/page": ok,
  "a.test/start": go(() => at("b.test", "/1")),
  "b.test/1": go(() => at("c.test", "/2")),
  "c.test/2": go(() => at("dest.test", "/page")),
  "short.test/relative": go("/landing"),
  "short.test/landing": ok,
  "short.test/protocol-relative": go(() => `//dest.test:${server.port}/page`),
  "loop.test/a": go("/b"),
  "loop.test/b": go("/c"),
  "loop.test/c": go("/a"),
  "loop.test/self": go("/self"),
  "loop.test/hash": go("#again"),
  // Sets a cookie and redirects to itself; only a request that sends the cookie back gets through.
  "cookie.test/check": (req, res) => {
    if (req.headers.cookie === "seen=1") go(() => at("dest.test", "/page"))(req, res);
    else go("/check", 302, { "set-cookie": "seen=1; Path=/; HttpOnly" })(req, res);
  },
  "cookie.test/set": go("/delete", 302, { "set-cookie": "temp=1" }),
  "cookie.test/delete": go("/after", 302, { "set-cookie": "temp=; Max-Age=0" }),
  "cookie.test/after": ok,
  "cookie.test/elsewhere": go(() => at("other.test", "/page"), 302, { "set-cookie": "a=1" }),
  "other.test/page": ok,
  // A new cookie value every time, so no two requests are alike.
  "cookie.test/counter": (req, res) => {
    const n = Number(/n=(\d+)/.exec(req.headers.cookie ?? "")?.[1] ?? 0);
    go("/counter", 302, { "set-cookie": `n=${n + 1}` })(req, res);
  },
  ...endlessChain,
  ...slowChain,
  "short.test/to-missing": go("/missing"), // no such route: 404
  "short.test/no-location": answer(302),
  "short.test/multiple-choices": go("/landing", 300), // 300 is not followed, even with a Location
  "short.test/no-content": answer(204),
  "short.test/to-ftp-credentials": go("ftp://user:s3cret@files.test/x"),
  "short.test/error": answer(500),
  "short.test/bare101": (_req, res) => {
    res.socket?.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  },
  "short.test/hang": () => {
    // never answers
  },
  "short.test/to-javascript": go("javascript:alert(1)"),
  "short.test/to-broken": go("http://["),
  "short.test/to-port-25": go("http://dest.test:25/"),
  "short.test/to-credentials": go(() => at("dest.test", "/page").replace("://", "://u:s3cret@")),
  "short.test/endless-body": (_req, res) => {
    res.writeHead(200);
    res.write("x".repeat(64 * 1024));
  },
  "short.test/big-header": (_req, res) => {
    res.setHeader("x-big", "a".repeat(20_000));
    res.end();
  },
  // What tinyurl.com and is.gd sent to this project's requests when this test was written.
  "short.test/challenge": (_req, res) => {
    res.writeHead(403, { "cf-mitigated": "challenge", server: "cloudflare" }).end();
  },
  "short.test/to-challenge": go(() => at("protected.test", "/article")),
  "protected.test/article": (_req, res) => {
    res.writeHead(403, { "cf-mitigated": "challenge" }).end();
  },
  // A challenge page that also redirects: the redirect is not followed.
  "short.test/challenge-redirect": go(() => at("dest.test", "/page"), 302, {
    "cf-mitigated": "challenge",
  }),
});
afterAll(() => server.close());

/** resolveUrl against the mock server: fake DNS and a short time limit. */
function resolve(url: string, options: ResolveOptions = {}) {
  return resolveUrl(url, { lookup: fakeLookup, timeoutMs: 2000, ...options });
}

describe("redirect chain", () => {
  it.each([301, 302, 303, 307, 308])("follows a %i redirect", async (status) => {
    const start = at("short.test", `/r${status}`);
    expect(await resolve(start)).toEqual({
      originalUrl: start,
      finalUrl: at("dest.test", "/page"),
      status: "RESOLVED",
      method: "http",
      redirectCount: 1,
      chain: [start, at("dest.test", "/page")],
      httpStatus: 200,
      timing: { elapsedMs: expect.any(Number) },
      security: { credentialsRemoved: false },
      tracking: null,
      error: null,
    });
  });

  it("follows a chain across several hosts (A -> B -> C -> D)", async () => {
    const result = await resolve(at("a.test", "/start"));
    expect(result).toMatchObject({ status: "RESOLVED", redirectCount: 3 });
    expect(result.chain).toEqual([
      at("a.test", "/start"),
      at("b.test", "/1"),
      at("c.test", "/2"),
      at("dest.test", "/page"),
    ]);
  });

  it("resolves a link that does not redirect to itself", async () => {
    expect(await resolve(at("dest.test", "/page"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      redirectCount: 0,
      chain: [at("dest.test", "/page")],
    });
  });

  it("follows a relative Location", async () => {
    expect(await resolve(at("short.test", "/relative"))).toMatchObject({
      status: "RESOLVED",
      chain: [at("short.test", "/relative"), at("short.test", "/landing")],
    });
  });

  it("follows a protocol-relative Location", async () => {
    expect(await resolve(at("short.test", "/protocol-relative"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
    });
  });

  it("keeps the #fragment of the link through the redirects", async () => {
    expect(await resolve(at("short.test", "/relative#top"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("short.test", "/landing#top"),
    });
  });

  it("puts the keys of the result in the order of the JSON output", async () => {
    const keys = [
      "originalUrl",
      "finalUrl",
      "status",
      "method",
      "redirectCount",
      "chain",
      "httpStatus",
      "timing",
      "security",
      "tracking",
      "error",
    ];
    expect(Object.keys(await resolve(at("dest.test", "/page")))).toEqual(keys);
    expect(Object.keys(await resolve(at("short.test", "/error")))).toEqual(keys);
    expect(Object.keys(await resolve("javascript:alert(1)"))).toEqual(keys);
  });

  it("reports the time taken in whole milliseconds", async () => {
    const { timing } = await resolve(at("short.test", "/r302"));
    expect(Number.isInteger(timing.elapsedMs)).toBe(true);
    expect(timing.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("loop detection", () => {
  it("stops a loop through several URLs (A -> B -> C -> A)", async () => {
    expect(await resolve(at("loop.test", "/a"))).toMatchObject({
      status: "REDIRECT_LOOP",
      finalUrl: null,
      error: "The redirects lead back to a URL that was already visited",
      redirectCount: 3,
      httpStatus: 302,
      chain: [
        at("loop.test", "/a"),
        at("loop.test", "/b"),
        at("loop.test", "/c"),
        at("loop.test", "/a"),
      ],
    });
  });

  it("stops a URL that redirects to itself", async () => {
    expect(await resolve(at("loop.test", "/self"))).toMatchObject({
      status: "REDIRECT_LOOP",
      chain: [at("loop.test", "/self"), at("loop.test", "/self")],
    });
  });

  it("ignores the #fragment, which is never sent to the server", async () => {
    expect(await resolve(at("loop.test", "/hash"))).toMatchObject({
      status: "REDIRECT_LOOP",
      chain: [at("loop.test", "/hash"), at("loop.test", "/hash#again")],
    });
  });

  it("is not fooled by a redirect that only sets a cookie", async () => {
    const before = server.requests.length;
    expect(await resolve(at("cookie.test", "/check"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      chain: [at("cookie.test", "/check"), at("cookie.test", "/check"), at("dest.test", "/page")],
    });
    const cookies = server.requests.slice(before).map((req) => req.headers.cookie);
    expect(cookies).toEqual([undefined, "seen=1", undefined]);
  });

  it("forgets a cookie the server deletes", async () => {
    const before = server.requests.length;
    expect(await resolve(at("cookie.test", "/set"))).toMatchObject({ status: "RESOLVED" });
    const cookies = server.requests.slice(before).map((req) => req.headers.cookie);
    expect(cookies).toEqual([undefined, "temp=1", undefined]);
  });

  it("sends a cookie only back to the site that set it", async () => {
    const before = server.requests.length;
    expect(await resolve(at("cookie.test", "/elsewhere"))).toMatchObject({ status: "RESOLVED" });
    expect(server.requests.slice(before).map((req) => req.headers.cookie)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("still ends a self-redirect whose cookie changes every time", async () => {
    expect(await resolve(at("cookie.test", "/counter"), { maxRedirects: 5 })).toMatchObject({
      status: "UNRESOLVED",
      error: "More than 5 redirects",
      redirectCount: 6,
    });
  });
});

describe("redirect limit", () => {
  it("stops after maxRedirects, without requesting the next target", async () => {
    const before = server.requests.length;
    const result = await resolve(at("count.test", "/n0"), { maxRedirects: 3 });
    expect(result).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error: "More than 3 redirects",
      httpStatus: 302,
    });
    expect(result.chain).toEqual([0, 1, 2, 3, 4].map((i) => at("count.test", `/n${i}`)));
    expect(server.requests.slice(before).map((req) => req.url)).toEqual([
      "/n0",
      "/n1",
      "/n2",
      "/n3",
    ]);
  });

  it(`allows ${DEFAULT_MAX_REDIRECTS} redirects by default, like browsers`, async () => {
    const result = await resolve(at("count.test", "/n0"));
    expect(result).toMatchObject({ status: "UNRESOLVED", error: "More than 20 redirects" });
    expect(result.chain).toHaveLength(DEFAULT_MAX_REDIRECTS + 2);
  });

  it("follows no redirect at all with maxRedirects 0", async () => {
    const before = server.requests.length;
    expect(await resolve(at("short.test", "/r302"), { maxRedirects: 0 })).toMatchObject({
      status: "UNRESOLVED",
      error: "More than 0 redirects",
      chain: [at("short.test", "/r302"), at("dest.test", "/page")],
    });
    // The target shows up in the chain, but it was never contacted.
    expect(server.requests.slice(before).map((req) => req.url)).toEqual(["/r302"]);
  });

  it.each([
    [{ maxRedirects: -1 }],
    [{ maxRedirects: 1.5 }],
    [{ maxRedirects: Number.NaN }],
    [{ timeoutMs: 0 }],
    [{ timeoutMs: -5 }],
    [{ timeoutMs: 1.5 }],
    [{ timeoutMs: Number.POSITIVE_INFINITY }],
    // Node would quietly run a timer this long after 1 ms, which would be a false TIMEOUT.
    [{ timeoutMs: 2 ** 31 }],
  ])("throws for the invalid option %o", async (options) => {
    await expect(resolve(at("short.test", "/r302"), options)).rejects.toThrow(RangeError);
  });
});

describe("timeout", () => {
  it("gives up on a server that never answers", async () => {
    const result = await resolve(at("short.test", "/hang"), { timeoutMs: 200 });
    expect(result).toMatchObject({
      status: "TIMEOUT",
      finalUrl: null,
      error: "Request timed out",
      method: null,
      httpStatus: null,
      chain: [at("short.test", "/hang")],
    });
    expect(result.timing.elapsedMs).toBeGreaterThanOrEqual(150);
    expect(result.timing.elapsedMs).toBeLessThan(1500);
  });

  it("counts the time of the whole chain, not of each hop", async () => {
    const result = await resolve(at("slow.test", "/s0"), { timeoutMs: 300 });
    expect(result).toMatchObject({ status: "TIMEOUT", method: "http", httpStatus: 302 });
    // Each hop takes about 60 ms, so the chain gets a few hops in, never all 40.
    expect(result.chain.length).toBeGreaterThan(1);
    expect(result.chain.length).toBeLessThan(10);
  });

  it("keeps the overall time limit when the caller passes a signal too", async () => {
    const neverCancelled = new AbortController().signal;
    const result = await resolve(at("short.test", "/hang"), {
      timeoutMs: 200,
      signal: neverCancelled,
    });
    expect(result).toMatchObject({ status: "TIMEOUT", error: "Request timed out" });
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await resolve(at("short.test", "/hang"), { signal: controller.signal })).toMatchObject({
      status: "ERROR",
      error: "Request was cancelled",
    });
  });
});

describe("how a chain can end", () => {
  it("is UNRESOLVED when the last server answers with an error", async () => {
    expect(await resolve(at("short.test", "/to-missing"))).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error: "The server answered with HTTP 404",
      method: "http",
      httpStatus: 404,
      chain: [at("short.test", "/to-missing"), at("short.test", "/missing")],
    });
    expect(await resolve(at("short.test", "/error"))).toMatchObject({
      status: "UNRESOLVED",
      error: "The server answered with HTTP 500",
      httpStatus: 500,
    });
  });

  it.each([
    ["/no-location", "The server answered with HTTP 302 without a redirect to follow"],
    ["/multiple-choices", "The server answered with HTTP 300 without a redirect to follow"],
  ])("is UNRESOLVED for %s: the page is elsewhere, but not said where", async (path, error) => {
    expect(await resolve(at("short.test", path))).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error,
      chain: [at("short.test", path)],
    });
  });

  it("is RESOLVED for any 2xx answer", async () => {
    expect(await resolve(at("short.test", "/no-content"))).toMatchObject({
      status: "RESOLVED",
      httpStatus: 204,
    });
  });

  it("is UNRESOLVED for an informational status that never became an answer", async () => {
    expect(await resolve(at("short.test", "/bare101"))).toMatchObject({
      status: "UNRESOLVED",
      error: "The server answered with HTTP 101",
    });
  });

  it("blocks a redirect to a non-http URL and leaves it out of the chain", async () => {
    expect(await resolve(at("short.test", "/to-javascript"))).toMatchObject({
      status: "BLOCKED",
      error: 'Redirect to a "javascript:" URL was not followed (only http and https)',
      chain: [at("short.test", "/to-javascript")],
    });
  });

  it("reports a Location that is not a URL", async () => {
    expect(await resolve(at("short.test", "/to-broken"))).toMatchObject({
      status: "ERROR",
      error: "Redirect target is not a valid URL",
      chain: [at("short.test", "/to-broken")],
    });
  });

  it("blocks a redirect to a port browsers refuse", async () => {
    expect(await resolve(at("short.test", "/to-port-25"))).toMatchObject({
      status: "BLOCKED",
      error: "Port 25 is not allowed",
      chain: [at("short.test", "/to-port-25"), "http://dest.test:25/"],
    });
  });

  it("does not wait for a response body", async () => {
    const result = await resolve(at("short.test", "/endless-body"));
    expect(result).toMatchObject({ status: "RESOLVED", httpStatus: 200 });
    expect(result.timing.elapsedMs).toBeLessThan(1000);
  });

  it("stops at a human verification page instead of trying to pass it", async () => {
    expect(await resolve(at("short.test", "/challenge"))).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error: "Human verification required",
      httpStatus: 403,
      chain: [at("short.test", "/challenge")],
    });
  });

  it("keeps the chain that led to a human verification page", async () => {
    expect(await resolve(at("short.test", "/to-challenge"))).toMatchObject({
      status: "UNRESOLVED",
      error: "Human verification required",
      chain: [at("short.test", "/to-challenge"), at("protected.test", "/article")],
    });
  });

  it("does not follow a redirect that comes with a human verification marker", async () => {
    expect(await resolve(at("short.test", "/challenge-redirect"))).toMatchObject({
      status: "UNRESOLVED",
      error: "Human verification required",
      chain: [at("short.test", "/challenge-redirect")],
    });
  });

  it("refuses oversized response headers", async () => {
    expect(await resolve(at("short.test", "/big-header"))).toMatchObject({
      status: "ERROR",
      error: "Request failed (HPE_HEADER_OVERFLOW)",
    });
  });

  it.each([
    ["", "URL is empty"],
    ["javascript:alert(1)", 'Only http and https links can be resolved (got "javascript:")'],
  ])("reports the invalid input %j without any request", async (input, error) => {
    const before = server.requests.length;
    expect(await resolve(input)).toEqual({
      originalUrl: input,
      finalUrl: null,
      status: "INVALID_URL",
      method: null,
      redirectCount: 0,
      chain: [],
      httpStatus: null,
      timing: { elapsedMs: expect.any(Number) },
      security: { credentialsRemoved: false },
      tracking: null,
      error,
    });
    expect(server.requests.length).toBe(before);
  });
});

describe("credentials in a link", () => {
  it("never sends or shows a username and password from the input", async () => {
    const before = server.requests.length;
    const start = at("short.test", "/r302").replace("://", "://user:s3cret@");
    const result = await resolve(start);
    expect(result).toMatchObject({
      status: "RESOLVED",
      originalUrl: at("short.test", "/r302"),
      security: { credentialsRemoved: true },
    });
    expect(JSON.stringify(result)).not.toContain("s3cret");
    const sent = server.requests.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent.map((req) => req.headers.authorization)).toEqual([undefined, undefined]);
  });

  it("never sends or shows a username and password from a Location", async () => {
    const before = server.requests.length;
    const result = await resolve(at("short.test", "/to-credentials"));
    expect(result).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      security: { credentialsRemoved: true },
    });
    expect(JSON.stringify(result)).not.toContain("s3cret");
    expect(server.requests.slice(before).map((req) => req.headers.authorization)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("flags credentials in a redirect target that is refused", async () => {
    const result = await resolve(at("short.test", "/to-ftp-credentials"));
    expect(result).toMatchObject({
      status: "BLOCKED",
      security: { credentialsRemoved: true },
      chain: [at("short.test", "/to-ftp-credentials")],
    });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("flags credentials in input that is rejected", async () => {
    const result = await resolve("ftp://admin:s3cret@files.example/");
    expect(result).toMatchObject({
      status: "INVALID_URL",
      originalUrl: "ftp://files.example/",
      security: { credentialsRemoved: true },
    });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});
