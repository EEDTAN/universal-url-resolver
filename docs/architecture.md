# Architecture

The project is one engine with three faces. The engine, `resolveUrl()` in
`packages/core`, does all the work; the command-line tool, the HTTP API and the
web page are thin layers on top of it. Nothing in the engine knows about React,
Fastify or a terminal, so the same resolution runs the same way everywhere.

## The pipeline

A link is resolved one hop at a time, lightest method first. For each hop the
engine makes a single HTTP request and then decides what the answer means:

```
URL
 │  parse and check the address
 ▼
HTTP request ──▶ Location header?        ──▶ follow
 │               meta refresh / Refresh?  ──▶ follow
 │               a redirect in the HTML?  ──▶ follow
 │               a redirect in a script?  ──▶ follow (read, not run)
 │               a service adapter knows? ──▶ follow
 │               a page that needs a browser and one was given? ──▶ open it
 │               a human check?           ──▶ stop: UNRESOLVED
 │               none of these            ──▶ arrived: the destination
 ▼
repeat until it arrives, stops, loops, or runs out of time or redirects
```

The heavier a method, the later it is tried, and the browser is used only for a
page the readers before it could not settle. This keeps a simple HTTP redirect
fast and saves the browser for the pages that truly need it.

## The packages

Each package does one thing and depends only on the ones below it.

- **`types`** — the shapes everything shares: the result, the browser and
  adapter interfaces. No code, so no dependency runs through it.
- **`url-parser`** — turns a typed link, or a redirect target, into an absolute
  `http(s)` URL, and removes any user name or password.
- **`security`** — decides which hosts may be contacted. Only public addresses;
  the check runs on every URL and every DNS answer.
- **`http-resolver`** — makes one request through the address policy and reports
  the status, the `Location` and `Refresh` headers, and the HTML. It never
  follows a redirect itself.
- **`html-resolver`** — reads a page the way a browser without JavaScript would:
  meta refresh, framesets, "leaving this site" pages, and the CAPTCHA widgets
  and sign-in forms that mean a person is needed.
- **`js-resolver`** — parses a page's inline scripts with `acorn` and finds a
  redirect they make on load, without running them.
- **`browser-resolver`** — opens a page in Chromium through a per-visit proxy
  that applies the address policy to every connection.
- **`tracking`** — sorts the final URL's query parameters and builds the clean
  URL.
- **`adapters`** — the home for per-service knowledge; empty by default.
- **`core`** — `resolveUrl()`, which runs the pipeline and ties the rest
  together.

## The apps

- **`apps/cli`** — the `urlresolve` command (`node:util`'s `parseArgs`).
- **`apps/api`** — the HTTP API (Fastify), with the rate limit, concurrency cap
  and optional cache. It can also serve the built web page.
- **`apps/web`** — the page (React, built with Vite), which only calls the API.

Because all three call the same `resolveUrl()`, a link resolves identically
however you ask.

## Why it is split this way

- **Honesty is in the core.** Every face gets the same status, and the rules
  that decide it — stop at a human check, never report an unprovable
  destination — live in one place.
- **Security is a chokepoint.** Every outward connection, whether from an HTTP
  hop or from inside the browser, passes the one address policy. There is no
  second path to the network.
- **Adding something rarely touches the core.** A new resolver, a new adapter or
  a new face plugs into an edge. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## What crosses the trust boundary

Everything from the link is untrusted: the URL, every redirect target, the
pages, the scripts, the decoded query parameters. So those paths are covered by
tests to the last branch, parsing is bounded against a hostile page, and text
from a link is escaped before it reaches a terminal or the web page. The
packages that handle this input, the address policy, the browser's proxy and the
API server are held at 100% test coverage.
