# Security

This project takes a URL from a stranger and goes to fetch it, so security is
part of the job, not an afterthought.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Instead, use GitHub's
private report: on the repository, open the **Security** tab and choose **Report
a vulnerability**. That reaches the maintainer privately, so the problem can be
fixed before it is known.

Tell us what you found, how to reproduce it, and what it lets someone do. You
will get a reply as soon as the maintainer can, and credit in the release notes
if you would like it.

## What the project defends against

- **SSRF.** Only `http` and `https` are followed. Localhost, `127.0.0.1`,
  `0.0.0.0`, the private ranges (`10/8`, `172.16/12`, `192.168/16`), link-local
  and cloud-metadata addresses, the IPv6 loopback and private ranges, and
  internal host names are all refused. The check runs again for the original
  URL, every redirect, every URL found in a page, and every page the browser
  visits, and it rejects a DNS answer with any private address in it, so DNS
  rebinding and odd IP encodings do not get through.
- **The browser.** When a page is opened in Chromium, every connection it
  makes — including images, frames, `fetch` and WebSockets — goes through a
  local proxy that applies the same policy. Chromium's own DNS answers nothing,
  and QUIC and WebRTC over UDP are switched off, so nothing slips around the
  proxy. Each visit gets an empty profile that is thrown away, so no cookie
  outlives it.
- **Secrets.** A user name or password in a URL is removed and never sent, and
  the result says so. Headers, cookies and page text are never logged.
- **The API.** A rate limit, a cap on how many links are resolved at once (and
  how many per client), a request timeout and a body-size limit protect the
  server. The browser is off by default. See the API section of the
  [README](README.md).
- **The web page.** It is served with a Content-Security-Policy that lets it
  load only its own files, and it shows every URL as text, never as a link, so
  looking at a result never means visiting it.

## What is left to the operator

A public API tells its users whether a host name resolves to a private address
(`BLOCKED`) or does not exist at all; the rate limit only slows down anyone
probing for internal names. Behind a reverse proxy, set `URLRESOLVE_TRUST_PROXY`
to the proxy's address so the rate limit counts the real client.

The project never tries to defeat CAPTCHAs, Cloudflare challenges or login
walls. That is a deliberate limit, not a gap: a link behind one ends
`UNRESOLVED`.
