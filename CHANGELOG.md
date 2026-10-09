# Changelog

All notable changes to this project are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Nothing has been released yet. This is everything built so far.

### Added

- **The resolver engine.** `resolveUrl()` follows a link from one hop to the
  next and reports where it ends, with an honest status when it cannot: HTTP
  redirects, meta refresh and the `Refresh` header, redirects written into HTML
  (framesets, "you are leaving this site" pages), and simple JavaScript
  redirects read without running the script. One overall time limit, a redirect
  limit, loop detection, and cookies kept only for the length of one
  resolution.
- **A browser fallback.** Pages the static readers cannot settle are opened in
  Chromium through Playwright, each visit in an empty, throwaway profile, and
  only when needed.
- **Security.** Only `http` and `https`, and a strict address policy that
  refuses localhost, private, link-local and internal addresses — for the
  original URL, every redirect, every URL found in a page, and every connection
  the browser makes. DNS rebinding and odd IP encodings are handled. CAPTCHAs,
  Cloudflare challenges and login walls are never defeated; such a link ends
  `UNRESOLVED`.
- **A tracking analyzer.** It sorts the final URL's query parameters into
  tracking, functional and unknown, and gives the link without the tracking
  ones.
- **A shortener adapter architecture**, so knowledge about one service can be
  added without changing the core.
- **A compatibility check** (`pnpm test:compat`) that resolves real links and
  writes the results to `docs/compatibility.md` with the date.
- **A command-line tool** (`urlresolve`), **an HTTP API** (Fastify, with a rate
  limit, a concurrency cap and an optional cache) and **a web page** (React).
- **Continuous integration** on GitHub Actions: `pnpm verify`, a dependency
  audit and CodeQL on every push and pull request.
