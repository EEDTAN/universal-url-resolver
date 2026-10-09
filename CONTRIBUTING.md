# Contributing

Thanks for taking a look. This project tries to find where a short link really
goes, for as many kinds of link as it safely can, and to be honest when it
cannot. A few things keep it that way, so please read this before a change.

## The ground rules

- **Never defeat a human check.** CAPTCHAs, Cloudflare challenges, Turnstile and
  login walls stay in the way on purpose. A page that asks for a person ends
  `UNRESOLVED` with "Human verification required". A change that tries to get
  past one will not be merged.
- **Never report a destination you cannot prove.** The result is where the link
  really leads, not a guess. When the destination cannot be worked out, the
  status says so.
- **Keep the security checks whole.** Every URL, every redirect and every page
  the browser visits goes through the address policy. Nothing may reach
  localhost or a private network.
- **Tests must not touch the internet.** They run against a local mock server.
  Real links are tried only by `pnpm test:compat`, which writes what happened to
  [docs/compatibility.md](docs/compatibility.md) with the date.

## Before you open a pull request

    pnpm install
    pnpm install-browser   # once, downloads Chromium (about 280 MB)
    pnpm verify            # lint, typecheck, tests with coverage, build

`pnpm verify` must pass. The same checks run on every pull request (see
[.github/workflows/ci.yml](.github/workflows/ci.yml)). Coverage is 100% for the
packages that read untrusted input (URLs, pages, scripts), for the address
policy, and for the browser's proxy and the API server; keep it there.

The code is formatted and linted with Biome: `pnpm format` fixes most things.

## Adding to the project

Each kind of change has a home, so you rarely need to touch the core engine.

- **A new resolver** (a new way to read a page) belongs in its own package under
  `packages/`, behind the same pipeline. The core calls it in order, lightest
  method first.
- **A new adapter** for one shortener service is a file in
  `packages/adapters/src/` plus a line in its list. The rules are on the
  `ShortenerAdapter` type in `packages/types`. An adapter only names where the
  service itself sends the visitor, never a URL the page merely contains, and
  never gets past a human check.
- **A new test fixture** for a shortener mechanism goes under `tests/`, served by
  the mock server in `tests/fixtures/mock-server.ts`. A real service's recorded
  answer, cut down and with its tokens replaced, can become an offline test (see
  `tests/integration/services.test.ts`).
- **A new security rule** belongs in `packages/security`, with a test in
  `tests/security/`.

Non-trivial logic leaves a test behind, and a change that could break a rule
leaves a test that would fail without it. The commit messages describe what
changed and why, in plain words.

## Reporting a problem

Open an issue on GitHub. For something that looks like a security hole, follow
[SECURITY.md](SECURITY.md) instead, so it can be fixed before it is public.
