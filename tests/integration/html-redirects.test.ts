import { type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

/** The absolute URL of a mock site. Routes call it at request time, once the port is known. */
const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string), status = 200, headers: Record<string, string> = {}): Route =>
  (_req, res) => {
    const text = typeof body === "string" ? body : body();
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(text);
  };

const metaRefresh = (content: string) => `<meta http-equiv="refresh" content="${content}">`;

const ok: Route = (_req, res) => {
  res.end("ok");
};

const routes: Record<string, Route> = {
  "dest.test/page": ok,
  "meta.test/landing": ok,
  "meta.test/start": html(() => metaRefresh(`0;url=${at("dest.test", "/page")}`)),
  "meta.test/relative": html(metaRefresh("3; url=/landing")),
  "meta.test/header": (_req, res) => {
    res.writeHead(200, { refresh: "0; url=/landing" }).end();
  },
  // What t.co sends to a browser: a script for those with JavaScript, a meta refresh for the rest.
  "meta.test/tco": html(
    () =>
      `<noscript>${metaRefresh(`0;URL=${at("dest.test", "/page")}`)}</noscript>` +
      `<script>location.replace("${at("dest.test", "/page")}")</script>`,
  ),
  "meta.test/slow": html(metaRefresh("900; url=/logout")),
  "meta.test/reload": html(metaRefresh("30")),
  "meta.test/loop-a": html(metaRefresh("0; url=/loop-b")),
  "meta.test/loop-b": html(metaRefresh("0; url=/loop-a")),
  "meta.test/to-javascript": html(metaRefresh("0; url=javascript:alert(1)")),
  "meta.test/to-credentials": html(() =>
    metaRefresh(`0; url=${at("dest.test", "/page").replace("://", "://u:s3cret@")}`),
  ),
  "meta.test/http-first": (_req, res) => {
    res.writeHead(302, { location: "/relative" }).end();
  },
  "meta.test/meta-first": html(metaRefresh("0; url=/http-to-landing")),
  "meta.test/http-to-landing": (_req, res) => {
    res.writeHead(301, { location: "/landing" }).end();
  },
  "meta.test/captcha": html('<form><div class="cf-turnstile" data-sitekey="k"></div></form>'),
  "meta.test/captcha-403": html('<div class="g-recaptcha" data-sitekey="k"></div>', 403),
  // An error page never sends anyone on, so its refresh cannot hide the CAPTCHA either.
  "meta.test/captcha-403-with-refresh": html(
    () =>
      `${metaRefresh(`0; url=${at("dest.test", "/page")}`)}<div class="g-recaptcha" data-sitekey="k"></div>`,
    403,
  ),
  "meta.test/error-with-refresh": html(metaRefresh("0; url=/landing"), 404),
  "meta.test/error-with-header": html("", 404, { refresh: "0; url=/landing" }),
  // The Refresh header comes first: a browser acts on it before reading the page.
  "meta.test/header-and-meta": html(metaRefresh("0; url=/elsewhere"), 200, {
    refresh: "0; url=/landing",
  }),
  "meta.test/header-and-captcha": html('<div class="g-recaptcha"></div>', 200, {
    refresh: "0; url=/landing",
  }),
  // A <noscript> refresh to the same site leads to a "please turn on JavaScript" page.
  "meta.test/needs-javascript": html(
    `<noscript>${metaRefresh("0; url=/enable-javascript")}</noscript><script>location="/x"</script>`,
  ),
  "meta.test/x": ok,
  "meta.test/private": (_req, res) => {
    res.writeHead(302, { location: "/login?next=/private" }).end();
  },
  "meta.test/login?next=/private": html(
    '<form method="post"><input name="user"><input type="password" name="pw"></form>',
  ),
  "meta.test/frames": html(() => `<frameset><frame src="${at("dest.test", "/page")}"></frameset>`),
  "meta.test/text": (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" }).end(metaRefresh("0; url=/landing"));
  },
  "meta.test/huge": html(() => `${"x".repeat(2 * 1024 * 1024)}${metaRefresh("0; url=/landing")}`),
  "meta.test/stalled": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<p>still loading"); // and never ends
  },
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [
      `meta.test/n${i}`,
      html(metaRefresh(`0;url=/n${i + 1}`)),
    ]),
  ),
};
const server = await startMockServer(routes);
afterAll(() => server.close());

// "You are leaving this site" pages. Their paths name the destination, which includes the port,
// so these routes can only be added once the server runs.
const destination = encodeURIComponent(at("dest.test", "/page"));
const leavingPath = `/l.php?u=${destination}`;
routes[`out.test${leavingPath}`] = html(
  () => `<p>You are leaving.</p><a href="${at("dest.test", "/page")}">Continue</a>`,
);
// Facebook's way: the warning page links to a redirector on another host, which then refreshes.
const warningPath = `/flx/warn/?u=${destination}`;
const handOffPath = `/l.php?u=${destination}&h=signature`;
routes[`warn.test${warningPath}`] = html(
  () => `<a href="${at("shim.test", handOffPath)}">Follow</a>`,
);
routes[`shim.test${handOffPath}`] = (_req, res) => {
  res.writeHead(200, { refresh: `1;URL=${at("dest.test", "/page")}` }).end();
};
// LinkedIn's way: the page shows the URL, and only JavaScript adds the button to go there.
const clickPath = `/redir/redirect?url=${destination}`;
routes[`click.test${clickPath}`] = html(
  () => `<p>This link leads to <span>${at("dest.test", "/page")}</span></p><a href="/">Back</a>`,
);

function resolve(url: string, options: ResolveOptions = {}) {
  return resolveUrl(url, { lookup: fakeLookup, timeoutMs: 2000, ...options });
}

describe("meta refresh", () => {
  it("follows a meta refresh to another site", async () => {
    expect(await resolve(at("meta.test", "/start"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      method: "meta-refresh",
      redirectCount: 1,
      chain: [at("meta.test", "/start"), at("dest.test", "/page")],
      httpStatus: 200,
    });
  });

  it.each(["/relative", "/header"])("follows %s to a URL on the same site", async (path) => {
    expect(await resolve(at("meta.test", path))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("meta.test", "/landing"),
      method: "meta-refresh",
    });
  });

  it("follows the <noscript> refresh of a page that also redirects with JavaScript", async () => {
    expect(await resolve(at("meta.test", "/tco"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
    });
  });

  it("names the heaviest step in a chain that mixes HTTP and meta refresh", async () => {
    expect(await resolve(at("meta.test", "/http-first#top"))).toMatchObject({
      status: "RESOLVED",
      method: "meta-refresh",
      // The HTTP redirect passes #top on; the meta refresh does not, as in a browser.
      chain: [
        at("meta.test", "/http-first#top"),
        at("meta.test", "/relative#top"),
        at("meta.test", "/landing"),
      ],
    });
    // The order does not matter: an HTTP redirect after the meta refresh keeps "meta-refresh".
    expect(await resolve(at("meta.test", "/meta-first"))).toMatchObject({
      status: "RESOLVED",
      method: "meta-refresh",
      redirectCount: 2,
    });
  });

  it.each([
    ["/slow", "a refresh that waits 15 minutes (a session timeout)"],
    ["/reload", "a refresh that reloads the page"],
    ["/text", "a refresh in a text/plain answer"],
  ])("treats %s as the destination: %s", async (path) => {
    expect(await resolve(at("meta.test", path))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("meta.test", path),
      method: "http",
      redirectCount: 0,
    });
  });

  it("stops a loop of meta refreshes", async () => {
    expect(await resolve(at("meta.test", "/loop-a"))).toMatchObject({
      status: "REDIRECT_LOOP",
      chain: [at("meta.test", "/loop-a"), at("meta.test", "/loop-b"), at("meta.test", "/loop-a")],
    });
  });

  it("counts meta refreshes against maxRedirects", async () => {
    expect(await resolve(at("meta.test", "/n0"), { maxRedirects: 2 })).toMatchObject({
      status: "UNRESOLVED",
      error: "More than 2 redirects",
    });
  });

  it("blocks a meta refresh to a javascript: URL", async () => {
    expect(await resolve(at("meta.test", "/to-javascript"))).toMatchObject({
      status: "BLOCKED",
      error: 'Redirect to a "javascript:" URL was not followed (only http and https)',
      method: "meta-refresh",
      chain: [at("meta.test", "/to-javascript")],
    });
  });

  it("removes credentials from a meta refresh URL", async () => {
    const result = await resolve(at("meta.test", "/to-credentials"));
    expect(result).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      security: { credentialsRemoved: true },
    });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it.each(["/error-with-refresh", "/error-with-header"])(
    "does not follow the refresh of an error page (%s)",
    async (path) => {
      expect(await resolve(at("meta.test", path))).toMatchObject({
        status: "UNRESOLVED",
        error: "The server answered with HTTP 404",
      });
    },
  );

  it.each(["/header-and-meta", "/header-and-captcha"])(
    "acts on the Refresh header before the page (%s)",
    async (path) => {
      expect(await resolve(at("meta.test", path))).toMatchObject({
        status: "RESOLVED",
        finalUrl: at("meta.test", "/landing"),
      });
    },
  );

  it('goes where the script goes, not to the "turn on JavaScript" page', async () => {
    expect(await resolve(at("meta.test", "/needs-javascript"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("meta.test", "/x"),
      method: "javascript",
      chain: [at("meta.test", "/needs-javascript"), at("meta.test", "/x")],
    });
  });
});

describe("human verification in a page", () => {
  it.each([
    ["/captcha", 200],
    ["/captcha-403", 403],
    ["/captcha-403-with-refresh", 403],
  ])("stops at the CAPTCHA on %s", async (path, httpStatus) => {
    expect(await resolve(at("meta.test", path))).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error: "Human verification required",
      httpStatus,
    });
  });

  it("stops at a login wall the link leads to", async () => {
    expect(await resolve(at("meta.test", "/private"))).toMatchObject({
      status: "UNRESOLVED",
      error: "Human verification required",
      chain: [at("meta.test", "/private"), at("meta.test", "/login?next=/private")],
    });
  });
});

describe("other HTML redirects", () => {
  it("follows a frameset that shows another site", async () => {
    expect(await resolve(at("meta.test", "/frames"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      method: "html",
    });
  });

  it('follows a "you are leaving this site" page', async () => {
    expect(await resolve(at("out.test", leavingPath))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      method: "html",
      chain: [at("out.test", leavingPath), at("dest.test", "/page")],
    });
  });

  it("follows a warning page through another host's redirector", async () => {
    expect(await resolve(at("warn.test", warningPath))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/page"),
      method: "meta-refresh",
      chain: [at("warn.test", warningPath), at("shim.test", handOffPath), at("dest.test", "/page")],
    });
  });

  it("does not report a page that waits for a click as the destination", async () => {
    expect(await resolve(at("click.test", clickPath))).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      error: "The page asks for a click to continue to another site",
      chain: [at("click.test", clickPath)],
    });
  });
});

describe("page size and speed", () => {
  it("reads at most 1 MiB of a page, so a refresh after that is not seen", async () => {
    expect(await resolve(at("meta.test", "/huge"))).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("meta.test", "/huge"),
    });
  });

  it("gives up on a page that never finishes loading", async () => {
    expect(await resolve(at("meta.test", "/stalled"), { timeoutMs: 300 })).toMatchObject({
      status: "TIMEOUT",
      error: "Request timed out",
    });
  });
});
