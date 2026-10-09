import type { LookupFunction } from "node:net";
import { createBrowserResolver } from "@urlresolve/browser-resolver";
import { type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string), status = 200, headers: Record<string, string> = {}): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(typeof body === "string" ? body : body());
  };
const script = (code: string | (() => string)) =>
  html(
    () =>
      `<!doctype html><p>Wait...</p><script>${typeof code === "string" ? code : code()}</script>`,
  );

const server = await startMockServer({
  "dest.test/": html("<p>destination</p>"),
  "dest.test/file": (_req, res) => {
    res.writeHead(200, { "content-disposition": "attachment; filename=a.bin" }).end("data");
  },
  "app.test/api": (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: at("dest.test", "/") }));
  },
  // A short link whose page asks its server where to go, then goes there.
  "app.test/fetch": script(
    'fetch("/api").then((r) => r.json()).then((d) => { location.href = d.url; })',
  ),
  "app.test/data": html(
    () =>
      `<div id="d" data-u="${btoa(at("dest.test", "/"))}"></div><script>location.href = atob(document.getElementById("d").dataset.u);</script>`,
  ),
  "app.test/choose": script(
    `if (/iPhone/.test(navigator.userAgent)) location.href = "/apps"; else location.href = "${"/web"}";`,
  ),
  "app.test/web": html("<p>the web version</p>"),
  "app.test/gate": (req, res) => {
    if (req.headers.cookie?.includes("ok=1")) {
      res.writeHead(302, { location: at("dest.test", "/") }).end();
    } else {
      script(
        'if (!document.cookie.includes("ok=1")) { document.cookie = "ok=1"; location.reload(); }',
      )(req, res);
    }
  },
  // The way on is only shown once a person has passed the CAPTCHA the script puts up.
  "app.test/captcha": script(
    'fetch("/api").then((d) => { if (d.passed) location.href = d.url; else document.body.innerHTML = \'<div class="g-recaptcha"></div>\'; })',
  ),
  "app.test/challenge": html("<p>Just a moment...</p>", 403, { "cf-mitigated": "challenge" }),
  "app.test/to-challenge": script('fetch("/api").then(() => { location.href = "/challenge"; })'),
  "app.test/to-inside": script(
    () => `fetch("/api").then(() => { location.href = "${at("inside.test", "/secret")}"; })`,
  ),
  "app.test/never": () => {},
  "app.test/hang": script('fetch("/api").then(() => { location.href = "/never"; })'),
  "app.test/ping": script('fetch("/api").then(() => { location.href = "/pong"; })'),
  "app.test/pong": script('fetch("/api").then(() => { location.href = "/ping"; })'),
  "app.test/blank": script('fetch("/api").then(() => { location.href = "about:blank"; })'),
  "app.test/download": script(
    () => `fetch("/api").then(() => { location.href = "${at("dest.test", "/file")}"; })`,
  ),
  "app.test/slow-refresh": html('<meta http-equiv="refresh" content="10; url=/web">'),
  "app.test/to-slow-refresh": script(
    'fetch("/api").then(() => { location.href = "/slow-refresh"; })',
  ),
  "app.test/leaving?u=https://dest.example/": html(
    "<p>You are leaving for https://dest.example/</p>",
  ),
  "app.test/to-leaving": script(
    'fetch("/api").then(() => { location.href = "/leaving?u=https://dest.example/"; })',
  ),
  "app.test/gone": html("<p>not here</p>", 404),
  "app.test/to-gone": script('fetch("/api").then(() => { location.href = "/gone"; })'),
  "app.test/creds": (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`http://user:s3cret@dest.test:${server.port}/`);
  },
  "app.test/to-creds": script(
    'fetch("/creds").then((r) => r.text()).then((u) => { location.href = u; })',
  ),
  "app.test/stays": script(
    'fetch("/api").then((r) => { if (r.status >= 500) location.href = "/oops"; })',
  ),
  "app.test/leaving-maybe?u=https://dest.example/": html(
    '<p>You are leaving for https://dest.example/</p><script>fetch("/api").then(() => { location.href = "/web"; })</script>',
  ),
  // A link to an app, then the web page for a browser without the app.
  "app.test/deeplink": script(
    'fetch("/api").then(() => { location.href = "myapp://open"; setTimeout(() => { location.href = "/web"; }, 100); })',
  ),
  "app.test/empty": (_req, res) => {
    res.writeHead(204).end();
  },
  "app.test/to-empty": script('fetch("/api").then(() => { location.href = "/empty"; })'),
  "app.test/stop": script(
    'fetch("/api").then(() => { location.href = "/never"; setTimeout(() => window.stop(), 100); })',
  ),
  "app.test/refresh-header": html("<p>wait</p>", 200, { refresh: "10; url=/web" }),
  "app.test/to-refresh-header": script(
    'fetch("/api").then(() => { location.href = "/refresh-header"; })',
  ),
  "app.test/login": (_req, res) => {
    res.writeHead(302, { "set-cookie": "sid=42; Path=/", location: "/session" }).end();
  },
  "app.test/session": script('fetch("/api").then(() => { location.href = "/members"; })'),
  "app.test/members": (req, res) => {
    if (req.headers.cookie?.includes("sid=42")) {
      res.writeHead(302, { location: at("dest.test", "/") }).end();
    } else {
      html("<p>please log in</p>")(req, res);
    }
  },
  // Two countdowns longer than the browser waits: a script, then a meta refresh.
  "app.test/to-countdown": script('fetch("/api").then(() => { location.href = "/countdown"; })'),
  "app.test/countdown": script(
    'setTimeout(function () { location.href = "/countdown-2"; }, 10000);',
  ),
  "app.test/countdown-2": html('<meta http-equiv="refresh" content="10; url=/web">'),
  // Leaves for a place only the page knows, but not before the browser has stopped waiting.
  "app.test/slow-unknown": script(
    "setTimeout(function () { location.href = document.title; }, 10000);",
  ),
  "app.test/to-hash": script('fetch("/api").then(() => { location.href = "/web#part-2"; })'),
  "app.test/multi": (_req, res) => {
    res.writeHead(300, { location: "/web", "content-type": "text/html" }).end("<p>choose</p>");
  },
  "app.test/to-multi": script('fetch("/api").then(() => { location.href = "/multi"; })'),
});

type Browser = NonNullable<ResolveOptions["browser"]>;
type Visit = Awaited<ReturnType<Browser["visit"]>>;

/** A stand-in for the browser: records what it is asked and answers with `answer`. */
function standIn(
  answer: (url: URL) => Visit = (url) => ({
    ok: true,
    chain: [url.href],
    statusCode: 200,
    challenge: false,
    refresh: null,
    html: "<p>stayed</p>",
  }),
) {
  const visits: { url: string; maxNavigations: number; cookie: string | undefined }[] = [];
  const stub: Browser = {
    async visit(url, { maxNavigations, cookie }) {
      visits.push({ url: url.href, maxNavigations, cookie });
      return answer(url);
    },
  };
  return { stub, visits };
}

/** *.test is 127.0.0.1, inside.test and every IP address are refused, as safeLookup refuses one. */
const policy: LookupFunction = (hostname, options, callback) => {
  if (hostname.endsWith(".test") && hostname !== "inside.test") {
    fakeLookup(hostname, options, callback);
  } else {
    const error = new Error(`${hostname} is a private or reserved address`);
    callback(Object.assign(error, { code: "BLOCKED" }), "");
  }
};

const browser = createBrowserResolver({ lookup: policy, settleMs: 300 });
afterAll(async () => {
  await browser.close();
  await server.close();
});

function resolve(path: string, options: ResolveOptions = {}) {
  return resolveUrl(at("app.test", path), {
    lookup: policy,
    browser,
    timeoutMs: 10_000,
    ...options,
  });
}

describe("browser fallback", { timeout: 30_000 }, () => {
  it("finds a destination a script fetches first", async () => {
    expect(await resolve("/fetch")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/"),
      method: "browser",
      redirectCount: 1,
      chain: [at("app.test", "/fetch"), at("dest.test", "/")],
      httpStatus: 200,
    });
  });

  it("finds a destination a script reads from the page", async () => {
    expect(await resolve("/data")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/"),
      method: "browser",
    });
  });

  it("takes the way a desktop browser goes when the page chooses by device", async () => {
    expect(await resolve("/choose")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("app.test", "/web"),
      method: "browser",
    });
  });

  it("follows a cookie the page sets before it reloads", async () => {
    expect(await resolve("/gate")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/"),
      chain: [at("app.test", "/gate"), at("app.test", "/gate"), at("dest.test", "/")],
    });
  });

  it("stays on a page that may move on but does not", async () => {
    expect(await resolve("/stays")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("app.test", "/stays"),
      method: "browser",
      redirectCount: 0,
    });
  });

  it("goes on from a slow meta refresh where the browser stopped", async () => {
    expect(await resolve("/to-slow-refresh")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("app.test", "/web"),
      method: "browser",
      chain: [
        at("app.test", "/to-slow-refresh"),
        at("app.test", "/slow-refresh"),
        at("app.test", "/web"),
      ],
    });
  });

  it("ends at a file the page downloads", async () => {
    expect(await resolve("/download")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/file"),
      method: "browser",
    });
  });

  it("removes a password from a URL the browser went to", async () => {
    const result = await resolve("/to-creds");
    expect(result).toMatchObject({ security: { credentialsRemoved: true } });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("takes the web page when a link to an app goes nowhere", async () => {
    expect(await resolve("/deeplink")).toMatchObject({
      status: "RESOLVED",
      chain: [at("app.test", "/deeplink"), at("app.test", "/web")],
    });
  });

  it.each([
    ["/to-empty", "an answer without a page (204)"],
    ["/stop", "a navigation the page stopped"],
  ])("stays on the page after %s (%s)", async (path) => {
    expect(await resolve(path)).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("app.test", path),
      redirectCount: 0,
      httpStatus: 200,
    });
  });

  it("follows the Refresh header of the page the browser ended on", async () => {
    expect(await resolve("/to-refresh-header")).toMatchObject({
      status: "RESOLVED",
      chain: [
        at("app.test", "/to-refresh-header"),
        at("app.test", "/refresh-header"),
        at("app.test", "/web"),
      ],
    });
  });

  it("brings the cookies a redirect set into the browser", async () => {
    expect(await resolve("/login")).toMatchObject({
      status: "RESOLVED",
      chain: [
        at("app.test", "/login"),
        at("app.test", "/session"),
        at("app.test", "/members"),
        at("dest.test", "/"),
      ],
    });
  });

  it("goes on through countdowns too slow for the browser to wait for", async () => {
    expect(await resolve("/to-countdown")).toMatchObject({
      status: "RESOLVED",
      method: "browser",
      chain: [
        at("app.test", "/to-countdown"),
        at("app.test", "/countdown"),
        at("app.test", "/countdown-2"),
        at("app.test", "/web"),
      ],
    });
  });

  it("keeps the #fragment of the page the browser ended on", async () => {
    expect(await resolve("/to-hash")).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("app.test", "/web#part-2"),
    });
  });

  it("can use every redirect it is allowed", async () => {
    expect(await resolve("/fetch", { maxRedirects: 1 })).toMatchObject({
      status: "RESOLVED",
      redirectCount: 1,
    });
  });
});

describe("browser fallback: where it stops", { timeout: 30_000 }, () => {
  it.each([
    ["/captcha", "a CAPTCHA the script shows"],
    ["/to-challenge", "a Cloudflare challenge"],
  ])("stops at %s (%s)", async (path) => {
    expect(await resolve(path)).toMatchObject({
      status: "UNRESOLVED",
      method: "browser",
      error: "Human verification required",
    });
  });

  it("says so when the browser ends on a page that waits for a click", async () => {
    expect(await resolve("/to-leaving")).toMatchObject({
      status: "UNRESOLVED",
      error: "The page asks for a click to continue to another site",
    });
  });

  it("reports the HTTP error of the page the browser ended on", async () => {
    expect(await resolve("/to-gone")).toMatchObject({
      status: "UNRESOLVED",
      httpStatus: 404,
      error: "The server answered with HTTP 404",
    });
  });

  it("does not take a 300 answer for a redirect, as browsers do not", async () => {
    expect(await resolve("/to-multi")).toMatchObject({
      status: "UNRESOLVED",
      httpStatus: 300,
      error: "The server answered with HTTP 300 without a redirect to follow",
    });
  });

  it("still cannot tell where a script goes that leaves after the browser stopped waiting", async () => {
    expect(await resolve("/slow-unknown")).toMatchObject({
      status: "UNRESOLVED",
      method: "browser",
      error: "JavaScript destination could not be determined",
    });
  });

  it("blocks a page the browser is sent into the private network", async () => {
    expect(await resolve("/to-inside")).toMatchObject({
      status: "BLOCKED",
      method: "browser",
      error: "inside.test is a private or reserved address",
      chain: [at("app.test", "/to-inside"), at("inside.test", "/secret")],
    });
  });

  it("refuses a page that is not http(s)", async () => {
    expect(await resolve("/blank")).toMatchObject({
      status: "BLOCKED",
      error: 'Redirect to a "about:" URL was not followed (only http and https)',
      chain: [at("app.test", "/blank")],
    });
  });

  it("names a loop the browser goes round", async () => {
    expect(await resolve("/ping", { maxRedirects: 5 })).toMatchObject({
      status: "REDIRECT_LOOP",
      error: "The redirects lead back to a URL that was already visited",
    });
  });

  it("counts the browser's redirects against maxRedirects", async () => {
    expect(await resolve("/gate", { maxRedirects: 1 })).toMatchObject({
      status: "UNRESOLVED",
      error: "More than 1 redirects",
    });
  });

  it("says how long the browser had when time runs out", async () => {
    expect(await resolve("/hang", { timeoutMs: 3000 })).toMatchObject({
      status: "TIMEOUT",
      method: "browser",
      error: "Browser navigation exceeded 3 seconds",
    });
  });
});

describe("when core asks the browser", () => {
  it.each([
    ["dest.test", "/", "a page without scripts"],
    ["app.test", "/gone", "an error page"],
    ["app.test", "/challenge", "a human check"],
    ["app.test", "/leaving?u=https://dest.example/", "a page that waits for a click"],
  ])("leaves %s%s alone (%s)", async (host, path) => {
    const { stub, visits } = standIn();
    await resolveUrl(at(host, path), { lookup: policy, browser: stub });
    expect(visits).toEqual([]);
  });

  it("asks about a page that waits for a click but may move on by itself", async () => {
    const { stub, visits } = standIn();
    await resolve("/leaving-maybe?u=https://dest.example/", { browser: stub });
    expect(visits).toHaveLength(1);
  });

  it("gives the browser the redirects that are left and the cookies it has", async () => {
    const { stub, visits } = standIn();
    await resolve("/login", { browser: stub });
    expect(visits).toEqual([
      { url: at("app.test", "/session"), maxNavigations: 19, cookie: "sid=42" },
    ]);
  });

  it.each([
    [
      ["/a", "/fetch", "/a", "/fetch"],
      "REDIRECT_LOOP",
      "The redirects lead back to a URL that was already visited",
    ],
    [["/a", "/b", "/c", "/d"], "UNRESOLVED", "More than 3 redirects"],
  ])(
    "tells a loop from a long chain when the browser went too far (%j)",
    async (paths, status, error) => {
      const { stub } = standIn((url) => ({
        ok: false,
        status: "ERROR",
        error: "More than 3 navigations",
        chain: [url.href, ...paths.map((path) => at("app.test", path))],
      }));
      expect(await resolve("/fetch", { browser: stub, maxRedirects: 3 })).toMatchObject({
        status,
        error,
      });
    },
  );

  it("reads the scripts of the page the browser stayed on", async () => {
    const { stub } = standIn((url) => ({
      ok: true,
      chain: [url.href],
      statusCode: 200,
      challenge: false,
      refresh: null,
      html: '<script>setTimeout(function () { location.href = "/web"; }, 10000);</script>',
    }));
    expect(await resolve("/fetch", { browser: stub })).toMatchObject({
      status: "RESOLVED",
      chain: [at("app.test", "/fetch"), at("app.test", "/web")],
    });
  });

  it("asks an adapter that knows the page first, and needs no browser then", async () => {
    const { stub, visits } = standIn();
    const adapter = {
      name: "app",
      matches: (url: URL) => url.hostname === "app.test",
      next: () => at("dest.test", "/"),
    };
    expect(await resolve("/fetch", { browser: stub, adapters: [adapter] })).toMatchObject({
      status: "RESOLVED",
      method: "adapter",
      chain: [at("app.test", "/fetch"), at("dest.test", "/")],
    });
    expect(visits).toEqual([]);
  });

  it("asks an adapter about the page the browser stayed on", async () => {
    const { stub } = standIn((url) => ({
      ok: true,
      chain: [url.href, at("app.test", "/shown")],
      statusCode: 200,
      challenge: false,
      refresh: null,
      html: "<p>a page of the service</p>",
    }));
    const adapter = {
      name: "app",
      matches: (url: URL) => url.pathname === "/shown",
      next: () => at("dest.test", "/"),
    };
    expect(await resolve("/fetch", { browser: stub, adapters: [adapter] })).toMatchObject({
      status: "RESOLVED",
      chain: [at("app.test", "/fetch"), at("app.test", "/shown"), at("dest.test", "/")],
    });
  });

  it("still reports the adapter when the browser comes after it", async () => {
    // The adapter sends the plain page /web to /fetch, which the browser follows to dest.test.
    const { stub } = standIn(() => ({
      ok: true,
      chain: [at("app.test", "/fetch"), at("dest.test", "/")],
      statusCode: 200,
      challenge: false,
      refresh: null,
      html: "<p>destination</p>",
    }));
    const adapter = {
      name: "app",
      matches: (url: URL) => url.hostname === "app.test" && url.pathname === "/web",
      next: () => "/fetch",
    };
    expect(await resolve("/web", { browser: stub, adapters: [adapter] })).toMatchObject({
      status: "RESOLVED",
      method: "adapter",
      chain: [at("app.test", "/web"), at("app.test", "/fetch"), at("dest.test", "/")],
    });
  });
});

describe("without a browser", () => {
  it("takes a page that may move on for the destination, as before", async () => {
    expect(await resolve("/fetch", { browser: undefined })).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("app.test", "/fetch"),
      method: "http",
    });
  });

  it("says it cannot tell where a script goes", async () => {
    expect(await resolve("/data", { browser: undefined })).toMatchObject({
      status: "UNRESOLVED",
      error: "JavaScript destination could not be determined",
    });
  });
});
