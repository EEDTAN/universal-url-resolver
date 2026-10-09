# Universal Shortlink Resolver

Designed to resolve a broad range of short-link and redirect mechanisms. You give it a short link (bit.ly, t.co, a self-hosted shortener, or one nobody has heard of yet) and it tries to find where the link really goes. It uses one generic pipeline instead of a list of known domains. When the destination can't be found safely, the result says so and explains why.

**Status:** work in progress, phase 3 of 13. The engine follows HTTP redirects and redirects written into HTML pages, but there is no command-line tool, API or web page yet.

## What exists so far

- `packages/types`: the JSON result contract.
- `packages/url-parser`: normalizes user input and turns redirect targets into absolute URLs.
- `packages/http-resolver`: sends a single HTTP request and reports the status, `Location` and `Refresh` headers, and the page itself when it is HTML (at most 1 MiB). It never follows redirects by itself.
- `packages/html-resolver`: reads a page the way a browser without JavaScript does. It finds meta refresh redirects, single-frame framesets and "you are leaving this site" pages. It notices CAPTCHA and Turnstile widgets, and sign-in forms on pages whose address says where to return afterwards (`?next=`). Ordinary links on a page are never followed. Not yet handled: redirects done with JavaScript (phase 4), and sign-in pages that ask for an e-mail address first or are built with JavaScript.
- `packages/security`: decides which hosts may be contacted. Only public addresses are allowed. Localhost, private networks (10.x, 172.16-31.x, 192.168.x), link-local and cloud metadata addresses, IPv6 private ranges and internal host names are refused, and the check runs again for every redirect, every URL found in a page and every DNS answer.
- `packages/core`: `resolveUrl()` follows the chain with one overall time limit (10 seconds by default) and a limit of 20 redirects of any kind. It detects loops, keeps cookies for the length of one resolution only, and stops at a "verify you are human" page instead of trying to pass it.

## Development

Requires Node.js 24 or newer and pnpm 12.

    pnpm install
    pnpm verify

`pnpm verify` runs lint, typecheck, the tests with coverage, and the build. The tests never touch the internet. They run against a local mock server.

## License

MIT
