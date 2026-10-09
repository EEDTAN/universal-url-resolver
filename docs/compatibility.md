# Compatibility

Designed to resolve a broad range of short-link and redirect mechanisms. This page lists only
links that were really tried, and what happened to them.

Written by `pnpm test:compat` on 2026-10-09 15:16 UTC, against the live services from one network. A
service can change its pages at any time, and a DNS block or a firewall can change what one
network sees, so a result says nothing about later days or other networks. The links come
from `tests/compat/links.json`. "With browser" means a browser was there for the pages that
need one; the method in brackets says whether it was used.

| Service | Without browser | With browser | As expected (without / with browser) |
| --- | --- | --- | --- |
| Google redirect | RESOLVED (html) | RESOLVED (html) | yes / yes |
| YouTube redirect | RESOLVED (html) | RESOLVED (html) | yes / yes |
| Facebook link shim | RESOLVED (meta-refresh) | RESOLVED (meta-refresh) | yes / yes |
| Steam link filter | RESOLVED (html) | RESOLVED (html) | yes / yes |
| LinkedIn link warning | RESOLVED (html) | RESOLVED (html) | yes / yes |
| LinkedIn redirect without urlhash | UNRESOLVED (http): The page asks for a click to continue to another site | UNRESOLVED (http): The page asks for a click to continue to another site | yes / yes |
| Ouo | UNRESOLVED (http): Human verification required | UNRESOLVED (http): Human verification required | yes / yes |
| ShrinkMe | TIMEOUT: Request timed out | TIMEOUT: Request timed out | - |

## Links

- **Google redirect**: `https://www.google.com/url?q=https://example.com/&sa=D` ended at `https://example.com/`, expected at `https://example.com/`.
- **YouTube redirect**: `https://www.youtube.com/redirect?q=https://example.com/` ended at `https://example.com/`, expected at `https://example.com/`.
- **Facebook link shim**: `https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F` ended at `https://example.com/`, expected at `https://example.com/`.
- **Steam link filter**: `https://steamcommunity.com/linkfilter/?u=https://example.com/` ended at `https://example.com/`, expected at `https://example.com/`.
- **LinkedIn link warning**: `https://www.linkedin.com/safety/go?url=https%3A%2F%2Fexample.com%2F` ended at `https://example.com/`, expected at `https://example.com/`.
- **LinkedIn redirect without urlhash**: `https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fexample.com%2F` ended UNRESOLVED, expected UNRESOLVED. Note from links.json, not checked by this run: LinkedIn answers with a "Link Error" page that names the URL but does not go there.
- **Ouo**: `https://ouo.io/NcVfJ9` ended UNRESOLVED, expected UNRESOLVED. Note from links.json, not checked by this run: Cloudflare answers with its challenge page (cf-mitigated: challenge), which only a person can pass.
- **ShrinkMe**: `https://shrinkme.click/KNdMTC` ended TIMEOUT. Note from links.json, not checked by this run: On 2026-10-09, from the network of the first run, the DNS answered with an address that never accepted a connection (an ISP block, it seems); public DNS answered with Cloudflare addresses.
