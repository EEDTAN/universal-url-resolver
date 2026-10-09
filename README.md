# Universal Shortlink Resolver

Designed to resolve a broad range of short-link and redirect mechanisms. You give it a short link (bit.ly, t.co, a self-hosted shortener, or one nobody has heard of yet) and it tries to find where the link really goes. It uses one generic pipeline instead of a list of known domains. When the destination can't be found safely, the result says so and explains why.

**Status:** work in progress, phase 2 of 13. The engine follows HTTP redirects, but there is no command-line tool, API or web page yet.

## What exists so far

- `packages/types`: the JSON result contract.
- `packages/url-parser`: normalizes user input and turns redirect `Location` values into absolute URLs.
- `packages/http-resolver`: sends a single HTTP request and reports the status and `Location`, without following redirects.
- `packages/security`: decides which hosts may be contacted. Only public addresses are allowed. Localhost, private networks (10.x, 172.16-31.x, 192.168.x), link-local and cloud metadata addresses, IPv6 private ranges and internal host names are refused, and the check runs again for every redirect and every DNS answer.
- `packages/core`: `resolveUrl()` follows the redirect chain with one overall time limit (10 seconds by default) and a redirect limit (20 by default). It detects loops, keeps cookies for the length of one resolution only, and stops at a "verify you are human" page instead of trying to pass it.

## Development

Requires Node.js 24 or newer and pnpm 12.

    pnpm install
    pnpm verify

`pnpm verify` runs lint, typecheck, the tests with coverage, and the build. The tests never touch the internet. They run against a local mock server.

## License

MIT
