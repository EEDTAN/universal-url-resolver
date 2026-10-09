import { type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

// Real services' answers, recorded on 2026-10-09 and cut down to what decides the outcome. Tokens
// and IDs are replaced. The live links are checked by `pnpm test:compat` (tests/compat/links.json).

const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string), status = 200, headers: Record<string, string> = {}): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(typeof body === "string" ? body : body());
  };

// https://ouo.io/NcVfJ9: Cloudflare's "Just a moment..." challenge. The page reloads itself every
// 360 seconds, and its script fetches the challenge; the header says what it is.
const OUO_CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="360"></head><body>
<div class="main-wrapper" role="main"><div class="main-content"><noscript><div class="h2">
<span id="challenge-error-text">Enable JavaScript and cookies to continue</span>
</div></noscript></div></div>
<script>(function(){window._cf_chl_opt = {cType: 'managed', cRay: 'RAY', cH: 'TOKEN'};
var a = document.createElement('script');
a.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=RAY';
document.getElementsByTagName('head')[0].appendChild(a);
}());</script></body></html>`;

// https://www.linkedin.com/safety/go?url=...: "You're leaving LinkedIn", with a real link on.
const linkedInWarning = (destination: string) => `<!DOCTYPE html><html lang="en"><head>
<meta name="pageKey" content="d_trust_safety_inpage"><title>LinkedIn</title>
<meta name="description" content="You’re leaving LinkedIn"></head><body>
<main class="in-page__container"><h1 class="in-page__header">You’re leaving LinkedIn</h1>
<span class="in-page__description">If you trust this link, select it to continue.</span>
<a class="in-page__destination-link" href="${destination}" rel="noopener"
  data-tracking-control-name="in_page_external_link_click">${destination}</a>
<a class="in-page__go-back-link" href="https://www.linkedin.com?trk=in_page_go_back_click">Go back</a>
</main></body></html>`;

// https://www.linkedin.com/redir/redirect?url=... without a valid urlhash: a "Link Error" page
// that names the URL, but only links back to LinkedIn.
const linkedInLinkError = (destination: string) => `<!DOCTYPE html><html class="artdeco" lang="en">
<head><meta name="pageKey" content="redirect"><title>Link Error | LinkedIn</title></head><body>
<div class="data-container"><h3 class="title">Link Error</h3>
<p class="content">We’re sorry, there was a problem with the link you followed.
<span class="t-bold">${destination}</span></p>
<div class="buttons-container"><a class="medium-button" href="/">Go back to LinkedIn</a></div>
</div></body></html>`;

const routes: Record<string, Route> = {
  "ouo.test/NcVfJ9": html(OUO_CHALLENGE, 403, {
    "cf-mitigated": "challenge",
    server: "cloudflare",
  }),
  "dest.test/": html("<p>destination</p>"),
};
const server = await startMockServer(routes);
afterAll(() => server.close());

// These pages name a mock URL in their own address, so their routes need the server's port.
const named = encodeURIComponent(at("dest.test", "/"));
routes[`linkedin.test/safety/go?url=${named}`] = html(() => linkedInWarning(at("dest.test", "/")));
routes[`linkedin.test/redir/redirect?url=${named}`] = html(() =>
  linkedInLinkError(at("dest.test", "/")),
);

function resolve(url: string, options: ResolveOptions = {}) {
  return resolveUrl(url, { lookup: fakeLookup, ...options });
}

describe("services, as recorded", () => {
  it("stops at Ouo's Cloudflare challenge, which only a person can pass", async () => {
    // An adapter that knows Ouo is never asked: the challenge comes first.
    const seen: string[] = [];
    const adapter = {
      name: "ouo",
      matches: (url: URL) => url.hostname === "ouo.test",
      next: ({ url }: { url: URL }) => {
        seen.push(url.href);
        return at("dest.test", "/");
      },
    };
    expect(await resolve(at("ouo.test", "/NcVfJ9"), { adapters: [adapter] })).toMatchObject({
      status: "UNRESOLVED",
      httpStatus: 403,
      error: "Human verification required",
      chain: [at("ouo.test", "/NcVfJ9")],
    });
    expect(seen).toEqual([]);
  });

  it("follows the link on LinkedIn's 'You're leaving LinkedIn' page", async () => {
    const start = at("linkedin.test", `/safety/go?url=${named}`);
    expect(await resolve(start)).toMatchObject({
      status: "RESOLVED",
      method: "html",
      chain: [start, at("dest.test", "/")],
    });
  });

  it("does not resolve LinkedIn's 'Link Error' page, which only names the URL", async () => {
    const start = at("linkedin.test", `/redir/redirect?url=${named}`);
    expect(await resolve(start)).toMatchObject({
      status: "UNRESOLVED",
      finalUrl: null,
      chain: [start],
    });
  });
});
