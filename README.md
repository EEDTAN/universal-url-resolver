# Universal Shortlink Resolver

[![CI](https://github.com/EEDTAN/universal-url-resolver/actions/workflows/ci.yml/badge.svg)](https://github.com/EEDTAN/universal-url-resolver/actions/workflows/ci.yml)

Designed to resolve a broad range of short-link and redirect mechanisms. You give it a short link (bit.ly, t.co, a self-hosted shortener, or one nobody has heard of yet) and it tries to find where the link really goes. It uses one generic pipeline instead of a list of known domains. When the destination can't be found safely, the result says so and explains why.

**Status:** work in progress, phase 12 of 13. The engine follows HTTP redirects, redirects written into HTML pages and simple JavaScript redirects, and it can open the pages it cannot read in a real browser. For the link it ends at, it lists the tracking parameters and gives the same link without them. Knowledge about particular shortener services can be added as adapters. What happened with real links of real services is in [docs/compatibility.md](docs/compatibility.md). It runs from the command line (`urlresolve`), as an HTTP API and as a web page.

## Command line

From a copy of this repository (see Development below for the setup):

    pnpm urlresolve https://bit.ly/example
    pnpm urlresolve https://bit.ly/example --json

It prints the original and final URL, the status (with the reason when the link did not resolve), the method that found the way, the number of redirects, the time, the tracking parameters and every URL on the way.

| Option | What it does |
| --- | --- |
| `--json` | prints the whole result as JSON, for programs |
| `--verbose`, `-v` | prints every detail of the final URL, and every step as it happens (on stderr, so `--json --verbose` still prints pure JSON) |
| `--security` | prints what the security checks found |
| `--clean` | prints the final URL without its tracking parameters |
| `--no-browser` | never opens a browser, even for a page that needs one |
| `--timeout <seconds>` | time limit for the whole link (default 10) |
| `--max-redirects <n>` | most redirects to follow (default 20) |

The exit code is 0 when the link resolved, 1 when it did not, 2 for a mistake in the command, and 130 when it was stopped with Ctrl-C (it prints no report then: a visit cut short says nothing about the link). Text that comes from the link, such as a decoded query parameter, is printed with control and invisible formatting characters escaped, so a link cannot send commands to the terminal.

## API

    pnpm api

starts the API server on http://127.0.0.1:3000. Its settings are environment variables, listed with their defaults in [.env.example](.env.example); `pnpm api` reads a `.env` file next to it.

    curl -X POST http://127.0.0.1:3000/api/resolve -H "content-type: application/json" -d '{"url": "https://bit.ly/example"}'
    curl http://127.0.0.1:3000/api/health

`POST /api/resolve` takes exactly `{"url": "..."}` (at most 8192 characters) and answers with the same JSON as `urlresolve --json`. A link that does not resolve is still answered with 200, and the `status` inside says what happened. The other answers are:

| Code | When |
| --- | --- |
| 400 | the body is not exactly `{"url": "<text>"}` |
| 413 | the body is over 16 KiB |
| 415 | the body is sent as something other than JSON or plain text |
| 429 | the client is over the rate limit (30 requests a minute by default), or already has 2 links being resolved |
| 503 | too many links are being resolved at once (8 by default), with `Retry-After` |

The server protects itself and the network around it:
- Every request goes through the same address policy as the command line, so the API cannot be used to reach localhost or a private network.
- The browser is off unless `URLRESOLVE_BROWSER=1`.
- A request must arrive within 30 seconds, and a link whose client disconnects stops being resolved at once.
- The request body is never logged.
- An optional cache (`URLRESOLVE_CACHE_TTL_SECONDS`, off by default) keeps resolved links for a limited time and number, and only small results. It never keeps a link with a user name or password in it, and marks its answers with `X-Cache: hit` or `miss`.

Two things are left to whoever runs it. Behind a reverse proxy, set `URLRESOLVE_TRUST_PROXY` to that proxy's address (127.0.0.1, or `loopback`, for a proxy on the same computer), so that the rate limit counts each client and not the proxy. X-Forwarded-For is then believed only from that address. A public server also tells its users whether a host name exists in its DNS and points to a private address (`BLOCKED`) or does not exist at all, which the rate limit only slows down.

## Web page

    pnpm build
    pnpm api

then open http://127.0.0.1:3000. The page has one box for the link and shows what the spec asks for: the final URL, every host on the way, the security checks, the tracking parameters with the link without them, and the technical details. It is served by the API server, with headers that let it load only its own files and keep other sites from showing it in a frame. The final URL is shown as text, not as a link, so that checking a link never means visiting it.

While working on the page, run `pnpm api` and `pnpm web` side by side and open http://localhost:5173: Vite reloads the page on every change and passes its `/api` calls to the API server.

## What exists so far

- `packages/types`: the JSON result contract.
- `packages/url-parser`: normalizes user input and turns redirect targets into absolute URLs.
- `packages/http-resolver`: sends a single HTTP request and reports the status, `Location` and `Refresh` headers, and the page itself when it is HTML (at most 1 MiB). It never follows redirects by itself.
- `packages/html-resolver`: reads a page the way a browser without JavaScript does. It finds meta refresh redirects, single-frame framesets and "you are leaving this site" pages. It notices CAPTCHA and Turnstile widgets, and sign-in forms on pages whose address says where to return afterwards (`?next=`). Ordinary links on a page are never followed. Not yet handled: sign-in pages that ask for an e-mail address first or are built with JavaScript.
- `packages/js-resolver`: reads a page's own scripts without running them and finds a redirect they make by themselves (`location.href = ...`, `location.replace(...)` and the like), at once, after a timer of up to a minute, a countdown or the page's load event. The URL may be built from plain text, `+`, variables, `decodeURIComponent`, base64 (`atob`), JSON or the page's own query string. Only the scripts a browser would run are read. A redirect that waits for a click, or that only some browsers make (after `if (isMobile)`, for example), is not followed. When a script certainly leaves the page but its destination cannot be worked out this way, the result says so. That includes a page that sends each visitor somewhere else, such as an app store chooser. It also notices scripts that may move on in a way only running them shows: a destination fetched first, a cookie and a reload, a form submitted by the page, code built with `eval`.
- `packages/browser-resolver`: opens those pages in Chromium (through Playwright) and waits until the page stays put. Chromium starts once and is reused, but every visit gets an empty profile that is thrown away afterwards, so no cookie outlives it. Every connection the browser makes goes through a small local proxy that applies the same address rules as the HTTP requests, so a page cannot reach localhost or a private network, not even through images, frames, `fetch` or WebSockets. Chromium's own DNS, QUIC and WebRTC over UDP are switched off so that nothing goes around the proxy. A Cloudflare challenge or a CAPTCHA on the page the browser ends on stops the resolution, as everywhere else.
- `packages/tracking`: sorts the query parameters of the final URL into tracking (`utm_*` tags, ad click IDs such as `gclid` and `fbclid`, e-mail IDs such as `mc_eid`), functional (`id`, `q`, `page` and a few more) and unknown ones, and builds a clean URL that leaves out the tracking ones only. Unknown parameters stay, because the page may need them, and the parameters that stay keep their order and exact spelling. Codes that only some sites use for tracking (`ref`, `si`, X's `s`) count as unknown, and so does Marketo's `mkt_tok`, which its unsubscribe pages need.
- `packages/adapters`: the place for what is known about one particular shortener service, for a page of it that the readers above get wrong. An adapter only says where the page leads next. `resolveUrl()` asks one only about a page on which the readers find no way on, never about an error page or a page it sees asking for human verification, and checks the URL it gives like any redirect. An adapter must only name where the service itself sends the visitor, which a URL in the address does not prove: for a link without a valid `urlhash`, LinkedIn's `/redir/redirect?url=...` answers with a "Link Error" page (HTTP 200) that names the URL but does not go there. There are no built-in adapters yet.
- `packages/security`: decides which hosts may be contacted. Only public addresses are allowed. Localhost, private networks (10.x, 172.16-31.x, 192.168.x), link-local and cloud metadata addresses, IPv6 private ranges and internal host names are refused, and the check runs again for every redirect, every URL found in a page and every DNS answer.
- `packages/core`: `resolveUrl()` follows the chain with one overall time limit (10 seconds by default) and a limit of 20 redirects of any kind. It detects loops, keeps cookies for the length of one resolution only, and stops at a "verify you are human" page instead of trying to pass it. When the readers find no way on, an adapter that knows the service is asked before the browser. Given a browser (`createBrowserResolver()`), core then hands over the pages the readers above cannot settle, and only those. A resolved result carries the tracking report for its final URL. An optional `log` callback hears every step, tagged `[URL]`, `[HTTP]`, `[REDIRECT]`, `[HTML]`, `[JAVASCRIPT]`, `[BROWSER]`, `[SECURITY]`, `[TRACKING]` or `[FINAL]`; its messages hold URLs without passwords, statuses, methods, adapter names and the names of tracking parameters (encoded again, as in a URL), never a header, a cookie or the text of a page.
- `apps/cli`: the `urlresolve` command, built on `resolveUrl()`.
- `apps/api`: the HTTP API (Fastify), built on `resolveUrl()` too.
- `apps/web`: the web page (React, built with Vite), which only talks to the API.

## Development

Requires Node.js 24 or newer and pnpm 12.

    pnpm install
    pnpm install-browser
    pnpm verify

`pnpm install-browser` downloads the Chromium build Playwright expects, once (about 280 MB on disk). `pnpm verify` runs lint, typecheck, the tests with coverage, and the build. The tests never touch the internet. They run against a local mock server, the browser tests included.

`pnpm test:compat` is the one check that does use the internet. It resolves the real links in `tests/compat/links.json`, without and with a browser, and writes the results with the date to [docs/compatibility.md](docs/compatibility.md). It is not part of `pnpm verify`, because a service can change its pages at any time.

Every push and pull request runs `pnpm verify` and a dependency audit on GitHub Actions (`.github/workflows/ci.yml`), and CodeQL scans the code for security problems (`.github/workflows/codeql.yml`). Each action is pinned to a commit, and Dependabot proposes newer versions once they are a week old.

## License

MIT
