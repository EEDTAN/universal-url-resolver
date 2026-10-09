import type { LookupFunction } from "node:net";
import { type LogEntry, type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string)): Route =>
  (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(typeof body === "string" ? body : body());
  };

const server = await startMockServer({
  "a.test/start": (_req, res) => {
    res.writeHead(301, { location: "/meta" }).end();
  },
  "a.test/meta": html('<meta http-equiv="refresh" content="0; url=/js">'),
  "a.test/js": html(
    () => `<script>location.href = "${at("dest.test", "/page?id=1&utm_source=x")}";</script>`,
  ),
  "dest.test/page?id=1&utm_source=x": html("<p>destination</p>"),
  "dest.test/page": html("<p>destination</p>"),
  // Sets a session cookie, and redirects to a URL with a password in it.
  "a.test/session": (_req, res) => {
    const location = at("a.test", "/plain").replace("//", "//u:hunter2@");
    res.writeHead(302, { "set-cookie": "sid=topsecret; Path=/", location }).end();
  },
  // The name of a tracking parameter with a line break in it.
  "dest.test/page?utm_%0Aevil=1": html("<p>destination</p>"),
  "a.test/plain": html("<p>a page</p>"),
  "a.test/to-inside": (_req, res) => {
    res.writeHead(302, { location: "http://inside.test/" }).end();
  },
  "a.test/fetch": html('<script>fetch("/api").then(() => { location.href = "/x"; });</script>'),
});
afterAll(() => server.close());

/** *.test is 127.0.0.1; inside.test is refused, as safeLookup refuses a private address. */
const policy: LookupFunction = (hostname, options, callback) => {
  if (hostname === "inside.test") {
    const error = new Error(`${hostname} is a private or reserved address`);
    callback(Object.assign(error, { code: "BLOCKED" }), "");
  } else {
    fakeLookup(hostname, options, callback);
  }
};

async function logOf(input: string, options: ResolveOptions = {}) {
  const lines: string[] = [];
  const log = ({ tag, message }: LogEntry) => lines.push(`[${tag}] ${message}`);
  const result = await resolveUrl(input, { lookup: policy, log, ...options });
  return { lines, result };
}

describe("the progress log", () => {
  it("tells every step of a chain, in order", async () => {
    const final = at("dest.test", "/page?id=1&utm_source=x");
    expect((await logOf(at("a.test", "/start"))).lines).toEqual([
      `[URL] ${at("a.test", "/start")}`,
      `[HTTP] 301 ${at("a.test", "/start")}`,
      `[REDIRECT] to ${at("a.test", "/meta")}`,
      `[HTTP] 200 ${at("a.test", "/meta")}`,
      `[HTML] a refresh leads to ${at("a.test", "/js")}`,
      `[HTTP] 200 ${at("a.test", "/js")}`,
      `[JAVASCRIPT] a script goes to ${final}`,
      `[HTTP] 200 ${final}`,
      "[TRACKING] 1 tracking parameter: utm_source",
      `[FINAL] RESOLVED ${final}`,
    ]);
  });

  it("never holds a password or a cookie", async () => {
    const { lines, result } = await logOf(at("a.test", "/session").replace("//", "//user:s3cret@"));
    expect(result.status).toBe("RESOLVED");
    // Once for the link as typed, once for the redirect.
    const removed = "[SECURITY] A user name or password in the URL was taken out";
    expect(lines.filter((line) => line === removed)).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/s3cret|topsecret|hunter2/);
  });

  it("writes the names of tracking parameters as a URL would", async () => {
    expect((await logOf(at("dest.test", "/page?utm_%0Aevil=1"))).lines).toContain(
      "[TRACKING] 1 tracking parameter: utm_%0Aevil",
    );
  });

  it("says why a URL was blocked", async () => {
    expect((await logOf(at("a.test", "/to-inside"))).lines.slice(-2)).toEqual([
      "[SECURITY] inside.test is a private or reserved address",
      "[FINAL] BLOCKED: inside.test is a private or reserved address",
    ]);
  });

  it("ends a link it cannot read with its reason", async () => {
    expect((await logOf("javascript:alert(1)")).lines).toEqual([
      '[FINAL] INVALID_URL: Only http and https links can be resolved (got "javascript:")',
    ]);
  });

  it("names the adapter that gave the way on", async () => {
    const adapter = {
      name: "example",
      matches: (url: URL) => url.pathname === "/plain",
      next: () => at("dest.test", "/page"),
    };
    expect((await logOf(at("a.test", "/plain"), { adapters: [adapter] })).lines).toContain(
      `[REDIRECT] adapter "example" says the page leads to ${at("dest.test", "/page")}`,
    );
  });

  it("follows the browser, without a password it came across", async () => {
    const browser = {
      visit: async (url: URL) => ({
        ok: true as const,
        chain: [url.href, at("dest.test", "/page").replace("//", "//user:pw@")],
        statusCode: 200,
        challenge: false,
        refresh: null,
        html: "<p>destination</p>",
      }),
    };
    const { lines } = await logOf(at("a.test", "/fetch"), { browser });
    expect(lines.filter((line) => /^\[(BROWSER|SECURITY)\]/.test(line))).toEqual([
      `[BROWSER] opens ${at("a.test", "/fetch")}`,
      "[SECURITY] A user name or password in the URL was taken out",
      `[BROWSER] went to ${at("dest.test", "/page")}`,
    ]);
    expect(lines.join("\n")).not.toContain("pw@");
  });
});
