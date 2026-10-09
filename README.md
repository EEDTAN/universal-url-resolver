# Universal Shortlink Resolver

Designed to resolve a broad range of short-link and redirect mechanisms. You give it a short link (bit.ly, t.co, a self-hosted shortener, or one nobody has heard of yet) and it tries to find where the link really goes. It uses one generic pipeline instead of a list of known domains. When the destination can't be found safely, the result says so and explains why.

**Status:** work in progress, phase 5 of 13. The engine follows HTTP redirects, redirects written into HTML pages and simple JavaScript redirects, and it can open the pages it cannot read in a real browser. There is no command-line tool, API or web page yet.

## What exists so far

- `packages/types`: the JSON result contract.
- `packages/url-parser`: normalizes user input and turns redirect targets into absolute URLs.
- `packages/http-resolver`: sends a single HTTP request and reports the status, `Location` and `Refresh` headers, and the page itself when it is HTML (at most 1 MiB). It never follows redirects by itself.
- `packages/html-resolver`: reads a page the way a browser without JavaScript does. It finds meta refresh redirects, single-frame framesets and "you are leaving this site" pages. It notices CAPTCHA and Turnstile widgets, and sign-in forms on pages whose address says where to return afterwards (`?next=`). Ordinary links on a page are never followed. Not yet handled: sign-in pages that ask for an e-mail address first or are built with JavaScript.
- `packages/js-resolver`: reads a page's own scripts without running them and finds a redirect they make by themselves (`location.href = ...`, `location.replace(...)` and the like), at once, after a timer of up to a minute, a countdown or the page's load event. The URL may be built from plain text, `+`, variables, `decodeURIComponent`, base64 (`atob`), JSON or the page's own query string. Only the scripts a browser would run are read. A redirect that waits for a click, or that only some browsers make (after `if (isMobile)`, for example), is not followed. When a script certainly leaves the page but its destination cannot be worked out this way, the result says so. That includes a page that sends each visitor somewhere else, such as an app store chooser. It also notices scripts that may move on in a way only running them shows: a destination fetched first, a cookie and a reload, a form submitted by the page, code built with `eval`.
- `packages/browser-resolver`: opens those pages in Chromium (through Playwright) and waits until the page stays put. Chromium starts once and is reused, but every visit gets an empty profile that is thrown away afterwards, so no cookie outlives it. Every connection the browser makes goes through a small local proxy that applies the same address rules as the HTTP requests, so a page cannot reach localhost or a private network, not even through images, frames, `fetch` or WebSockets. Chromium's own DNS, QUIC and WebRTC over UDP are switched off so that nothing goes around the proxy. A Cloudflare challenge or a CAPTCHA on the page the browser ends on stops the resolution, as everywhere else.
- `packages/security`: decides which hosts may be contacted. Only public addresses are allowed. Localhost, private networks (10.x, 172.16-31.x, 192.168.x), link-local and cloud metadata addresses, IPv6 private ranges and internal host names are refused, and the check runs again for every redirect, every URL found in a page and every DNS answer.
- `packages/core`: `resolveUrl()` follows the chain with one overall time limit (10 seconds by default) and a limit of 20 redirects of any kind. It detects loops, keeps cookies for the length of one resolution only, and stops at a "verify you are human" page instead of trying to pass it. Given a browser (`createBrowserResolver()`), it hands over the pages the readers above cannot settle, and only those.

## Development

Requires Node.js 24 or newer and pnpm 12.

    pnpm install
    pnpm install-browser
    pnpm verify

`pnpm install-browser` downloads the Chromium build Playwright expects, once (about 280 MB on disk). `pnpm verify` runs lint, typecheck, the tests with coverage, and the build. The tests never touch the internet. They run against a local mock server, the browser tests included.

## License

MIT
