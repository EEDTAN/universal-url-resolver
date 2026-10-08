# Universal Shortlink Resolver

Designed to resolve a broad range of short-link and redirect mechanisms. You give it a short link (bit.ly, t.co, a self-hosted shortener, or one nobody has heard of yet) and it tries to find where the link really goes. It uses one generic pipeline instead of a list of known domains. When the destination can't be found safely, the result says so and explains why.

**Status:** work in progress, phase 1 of 13. Nothing is usable yet.

## What exists so far

- `packages/types`: the JSON result contract.
- `packages/url-parser`: normalizes user input and turns redirect `Location` values into absolute URLs.
- `packages/http-resolver`: sends a single HTTP request and reports the status and `Location`, without following redirects.

## Development

Requires Node.js 24 or newer and pnpm 12.

    pnpm install
    pnpm verify

`pnpm verify` runs lint, typecheck, the tests with coverage, and the build. The tests never touch the internet. They run against a local mock server.

## License

MIT
