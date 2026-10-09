import type { ParameterKind, TrackingReport } from "@urlresolve/types";

// Ad click IDs, share codes, analytics and e-mail tracking IDs. Like the utm_ campaign tags, they
// say where a visit came from and never what the page shows, so the page is the same without them.
const TRACKING = new Set([
  // Google Ads, Campaign Manager and Merchant Center, and Google Analytics' cross-domain linker
  "gclid",
  "gclsrc",
  "gad_source",
  "dclid",
  "gbraid",
  "wbraid",
  "srsltid",
  "_ga",
  "_gl",
  // Ad clicks from Meta, Microsoft, X, TikTok, LinkedIn, Pinterest and Yandex
  "fbclid",
  "msclkid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "epik",
  "yclid",
  // Instagram's share codes
  "igshid",
  "igsh",
  // E-mail: Mailchimp, HubSpot, Vero and Omeda. Not Marketo's mkt_tok: its unsubscribe and
  // web-view pages read it to know who clicked.
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "vero_conv",
  "oly_anon_id",
  "oly_enc_id",
]);

// Names that choose what a page shows wherever they appear: an item, a search, a page of results,
// a language, a video (YouTube's v).
const FUNCTIONAL = new Set(["id", "q", "query", "search", "page", "lang", "v"]);

/**
 * Sorts the query parameters of `url` into tracking, functional and unknown ones (names are
 * matched without regard to case), and gives the same URL without the tracking ones. The other
 * parameters keep their order and exact spelling, and the #fragment stays. Once something is
 * taken out, empty pieces ("a=1&&b=2", a trailing "&") go too; when nothing is, the URL comes
 * back exactly as it was.
 */
export function analyzeTracking(url: URL): TrackingReport {
  const parameters: TrackingReport["parameters"] = [];
  const kept: string[] = [];
  // Only "&" separates parameters, as for URLSearchParams and most servers: a ";" is part of a value.
  for (const piece of url.search.slice(1).split("&")) {
    // Decoded the way a server reads a query ("+" is a space). Unlike decodeURIComponent,
    // URLSearchParams never throws on a stray "%". The "&" in front keeps a "?" at the start of
    // the piece, which URLSearchParams would otherwise drop.
    const [pair] = new URLSearchParams(`&${piece}`);
    if (pair === undefined) continue; // an empty piece, as in "a=1&&b=2"
    const [name, value] = pair;
    const kind = kindOf(name);
    parameters.push({ name, value, kind });
    if (kind !== "tracking") kept.push(piece);
  }
  if (kept.length === parameters.length) return { cleanUrl: url.href, parameters };
  const clean = new URL(url.href);
  // The setter drops one "?" at the start, so it gets one of ours: a kept piece may begin with
  // its own "?". An empty search removes the "?" as well.
  clean.search = kept.length === 0 ? "" : `?${kept.join("&")}`;
  return { cleanUrl: clean.href, parameters };
}

function kindOf(name: string): ParameterKind {
  const lower = name.toLowerCase();
  if (lower.startsWith("utm_") || TRACKING.has(lower)) return "tracking";
  return FUNCTIONAL.has(lower) ? "functional" : "unknown";
}
