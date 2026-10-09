import { type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

/** The absolute URL of a mock site. Routes call it at request time, once the port is known. */
const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string), status = 200): Route =>
  (_req, res) => {
    const text = typeof body === "string" ? body : body();
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(text);
  };

const script = (code: string | (() => string)) =>
  html(() => `<script>${typeof code === "string" ? code : code()}</script>`);

const ok: Route = (_req, res) => {
  res.end("ok");
};

const server = await startMockServer({
  "dest.test/page": ok,
  "js.test/landing": ok,
  // What t.co sends to a browser, without the <noscript> part.
  "js.test/tco": script(
    () =>
      `window.opener = null; location.replace("${at("dest.test", "/page").replaceAll("/", "\\/")}")`,
  ),
  "js.test/countdown": script(
    'var n = 3; var t = setInterval(function () { if (--n <= 0) { clearInterval(t); location.href = "/landing"; } }, 1000);',
  ),
  "js.test/go?to=/landing": script(
    'location.replace(new URLSearchParams(location.search).get("to"));',
  ),
  "js.test/base64": script(() => `location.href = atob("${btoa(at("dest.test", "/page"))}");`),
  "js.test/onload": html("<body onload=\"location.href='/landing'\"><p>Wait...</p></body>"),
  "js.test/unknown": script("location.href = pickMirror();"),
  "js.test/click-only": html(
    '<button id="b">Go</button><script>b.onclick = function () { location.href = "/landing"; };</script>',
  ),
  "js.test/loop-a": script('location.replace("/loop-b")'),
  "js.test/loop-b": script('location.replace("/loop-a")'),
  "js.test/to-javascript": script('location.href = "javascript:alert(1)"'),
  "js.test/error-page": html('<script>location.replace("/landing")</script>', 404),
  "js.test/http-first": (_req, res) => {
    res.writeHead(302, { location: "/meta" }).end();
  },
  "js.test/meta": html('<meta http-equiv="refresh" content="0; url=/script">'),
  "js.test/script": script('location.replace("/landing")'),
  "js.test/app": script(
    'if (/iPhone/.test(navigator.userAgent)) location.href = "https://apps.test/"; else location.href = "https://play.test/";',
  ),
  "js.test/session": script(
    'setTimeout(function () { location.href = "/logout"; }, 15 * 60 * 1000);',
  ),
  "js.test/old-browsers": html(
    '<script type="module" src="/app.js"></script><script nomodule>location.replace("/unsupported")</script>',
  ),
  // About 256 KiB of one name over and over, and a redirect that needs a self chain 13,000 long.
  "js.test/heavy": html(
    () =>
      `${`<script>location;${"a;".repeat(32_490)}</script>`.repeat(3)}<script>${"self.".repeat(13_000)}location.href = "/landing"</script>`,
  ),
});
afterAll(() => server.close());

function resolve(url: string, options: ResolveOptions = {}) {
  return resolveUrl(url, { lookup: fakeLookup, timeoutMs: 2000, ...options });
}

describe("JavaScript redirects", () => {
  it("follows location.replace with escaped slashes, the way t.co writes it", async () => {
    expect(await resolve(at("js.test", "/tco"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      method: "javascript",
      chain: [at("js.test", "/tco"), at("dest.test", "/page")],
    });
  });

  it.each([
    ["/countdown", "a countdown timer"],
    ["/go?to=/landing", "a URL taken from the page's own query string"],
    ["/onload", "a body onload attribute"],
  ])("follows %s (%s)", async (path) => {
    expect(await resolve(at("js.test", path))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("js.test", "/landing"),
      method: "javascript",
    });
  });

  it("follows a base64 destination", async () => {
    expect(await resolve(at("js.test", "/base64"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
    });
  });

  it("names the heaviest step of a chain: HTTP, then meta refresh, then JavaScript", async () => {
    expect(await resolve(at("js.test", "/http-first"))).toMatchObject({
      status: "RESOLVED",
      method: "javascript",
      redirectCount: 3,
      finalUrl: at("js.test", "/landing"),
    });
  });

  it("says so when a script leaves for a place it cannot work out", async () => {
    expect(await resolve(at("js.test", "/unknown"))).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error: "JavaScript destination could not be determined",
      chain: [at("js.test", "/unknown")],
    });
  });

  it("does not follow a redirect that needs a click", async () => {
    expect(await resolve(at("js.test", "/click-only"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("js.test", "/click-only"),
      method: "http",
    });
  });

  it("stops a loop of script redirects", async () => {
    expect(await resolve(at("js.test", "/loop-a"))).toMatchObject({
      status: "REDIRECT_LOOP",
      chain: [at("js.test", "/loop-a"), at("js.test", "/loop-b"), at("js.test", "/loop-a")],
    });
  });

  it("blocks a script redirect to a javascript: URL", async () => {
    expect(await resolve(at("js.test", "/to-javascript"))).toMatchObject({
      status: "BLOCKED",
      method: "javascript",
      error: 'Redirect to a "javascript:" URL was not followed (only http and https)',
    });
  });

  it("does not run the scripts of an error page", async () => {
    expect(await resolve(at("js.test", "/error-page"))).toMatchObject({
      status: "UNRESOLVED",
      error: "The server answered with HTTP 404",
    });
  });

  it("says so when the destination depends on the visitor's phone", async () => {
    expect(await resolve(at("js.test", "/app"))).toMatchObject({
      status: "UNRESOLVED",
      error: "JavaScript destination could not be determined",
    });
  });

  it.each([
    ["/session", "a session timeout of 15 minutes"],
    ["/old-browsers", "a redirect only browsers without modules run"],
  ])("stays on %s (%s)", async (path) => {
    expect(await resolve(at("js.test", path))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("js.test", path),
      method: "http",
    });
  });

  it("still answers in time for a page built to slow the analysis down", async () => {
    const started = performance.now();
    expect(await resolve(at("js.test", "/heavy"), { timeoutMs: 5000 })).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("js.test", "/landing"),
      method: "javascript",
    });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
