import { findHtmlTarget, refreshTarget } from "@urlresolve/html-resolver";
import { type HopOptions, type HopResult, requestHop } from "@urlresolve/http-resolver";
import { safeLookup } from "@urlresolve/security";
import { analyzeTracking } from "@urlresolve/tracking";
import type {
  BrowserResolver,
  ResolveMethod,
  ResolveResult,
  ResolveStatus,
} from "@urlresolve/types";
import { parseInputUrl, resolveLocation } from "@urlresolve/url-parser";
import { CookieJar } from "./cookie-jar.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
/** The same limit browsers use (Fetch standard). It counts every hop, however it was found. */
export const DEFAULT_MAX_REDIRECTS = 20;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolver steps from lightest to heaviest, as in the spec's pipeline. */
const METHOD_ORDER: ResolveMethod[] = [
  "http",
  "html",
  "meta-refresh",
  "javascript",
  "browser",
  "adapter",
];

export interface ResolveOptions {
  /** Time limit for the whole resolution, in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Most redirects to follow, whether HTTP, meta refresh or HTML. Default 20. */
  maxRedirects?: number;
  /** Stops the resolution early, for example when the user cancels it. */
  signal?: AbortSignal;
  /**
   * DNS and address policy for every connection. Default: safeLookup from @urlresolve/security,
   * which only allows public addresses. Tests pass their own to reach a local mock server.
   */
  lookup?: HopOptions["lookup"];
  /**
   * A real browser for the pages the readers above cannot settle: a script that certainly leaves
   * for a place that cannot be worked out, or one that may move on in a way only running it
   * shows. Default: none. Then the first kind ends UNRESOLVED and the second counts as the
   * destination. createBrowserResolver from @urlresolve/browser-resolver makes one; it checks
   * every connection with its own lookup.
   */
  browser?: BrowserResolver;
}

/**
 * Follows a link redirect by redirect and reports where it ends. Never throws for a bad link or a
 * failing server: the result's status says what happened. Throws only for invalid options.
 */
export async function resolveUrl(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    lookup = safeLookup,
    browser,
  } = options;
  // Node turns a longer timer (about 24.8 days) into 1 ms, which would be a false TIMEOUT.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs must be a whole number from 1 to ${MAX_TIMER_MS}`);
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError("maxRedirects must be a whole number, 0 or more");
  }
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  // One deadline for every hop together, so a long chain cannot run over the limit.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

  const parsed = parseInputUrl(input);
  if (!parsed.ok) {
    return {
      originalUrl: parsed.safeInput,
      finalUrl: null,
      status: parsed.status,
      method: null,
      redirectCount: 0,
      chain: [],
      httpStatus: null,
      timing: { elapsedMs: elapsedMs() },
      security: { credentialsRemoved: parsed.credentialsRemoved },
      tracking: null,
      error: parsed.error,
    };
  }

  let url = parsed.url;
  const chain = [url.href];
  let method: ResolveMethod | null = null;
  let httpStatus: number | null = null;
  let credentialsRemoved = parsed.credentialsRemoved;
  const cookies = new CookieJar();
  const requestsSent = new Set<string>();

  const finish = (status: ResolveStatus, error = ""): ResolveResult => {
    const fields = {
      method,
      redirectCount: chain.length - 1,
      chain,
      httpStatus,
      timing: { elapsedMs: elapsedMs() },
      security: { credentialsRemoved },
    };
    // Keys in the order the JSON output shows them.
    const originalUrl = parsed.url.href;
    return status === "RESOLVED"
      ? {
          originalUrl,
          finalUrl: url.href,
          status,
          ...fields,
          tracking: analyzeTracking(url),
          error: null,
        }
      : { originalUrl, finalUrl: null, status, ...fields, tracking: null, error };
  };

  for (;;) {
    const cookie = cookies.header(url);
    // The same URL with the same cookies is the same request, so its answer would repeat too.
    // The #fragment is never sent, so it does not count.
    const request = `${url.href.split("#")[0]} ${cookie ?? ""}`;
    if (requestsSent.has(request)) return finish("REDIRECT_LOOP", LOOP_ERROR);
    requestsSent.add(request);
    if (chain.length - 1 > maxRedirects) {
      return finish("UNRESOLVED", `More than ${maxRedirects} redirects`);
    }

    const hop = await requestHop(url, { lookup, signal, cookie });
    if (!hop.ok) return finish(hop.status, hop.error);
    httpStatus = hop.statusCode;
    method ??= "http";
    cookies.store(url, hop.setCookies);

    let step = nextStep(hop, url);
    if (step.kind !== "follow" && step.tryBrowser && browser) {
      // The browser opens this page again, with the cookies this resolution has for it, and
      // follows it to wherever it stays.
      const remaining = maxRedirects - (chain.length - 1);
      const visit = await browser.visit(url, {
        signal,
        maxNavigations: remaining,
        cookie: cookies.header(url),
      });
      method = "browser";
      for (const href of visit.chain.slice(1)) {
        // Every page the browser went to: only http(s), and never a password.
        const next = resolveLocation(href, url, { inheritFragment: false });
        credentialsRemoved ||= next.credentialsRemoved;
        if (!next.ok) return finish(next.status, next.error);
        url = next.url;
        chain.push(url.href);
      }
      if (chain.length - 1 > maxRedirects) {
        return revisits(visit.chain)
          ? finish("REDIRECT_LOOP", LOOP_ERROR)
          : finish("UNRESOLVED", `More than ${maxRedirects} redirects`);
      }
      if (!visit.ok) {
        const timedOut = visit.status === "TIMEOUT";
        return finish(
          visit.status,
          timedOut ? `Browser navigation exceeded ${timeoutMs / 1000} seconds` : visit.error,
        );
      }
      const { statusCode, challenge, refresh, html } = visit;
      httpStatus = statusCode;
      // The page the browser stayed on, read like any other: a slow countdown or refresh is
      // followed from here, and a script that certainly leaves for a place unknown still ends
      // UNRESOLVED. A page that only may move on counts as arrived: the browser saw it stay.
      const page = { statusCode, location: null, setCookies: [], challenge, refresh, html };
      step = nextStep({ ok: true, ...page }, url);
    }
    if (step.kind === "arrived") return finish("RESOLVED");
    if (step.kind === "stop") return finish(step.status, step.error);
    method = heavier(method, step.method);
    // An HTTP redirect passes the #fragment of the link on (RFC 9110); a page's own links do not.
    const next = resolveLocation(step.target, url, { inheritFragment: step.method === "http" });
    credentialsRemoved ||= next.credentialsRemoved;
    if (!next.ok) return finish(next.status, next.error);
    url = next.url;
    chain.push(url.href);
  }
}

/** tryBrowser: a browser may find out where this page goes, which the readers here could not. */
type Step =
  | { kind: "follow"; target: string; method: ResolveMethod }
  | { kind: "stop"; status: Exclude<ResolveStatus, "RESOLVED">; error: string; tryBrowser?: true }
  | { kind: "arrived"; tryBrowser?: true };

const HUMAN_CHECK: Step = {
  kind: "stop",
  status: "UNRESOLVED",
  error: "Human verification required",
};

const LOOP_ERROR = "The redirects lead back to a URL that was already visited";

/** What one answer means: go on to another URL, stop, or this page is the destination. */
function nextStep(hop: Extract<HopResult, { ok: true }>, url: URL): Step {
  // Only a person can pass this check, and getting around it is not this project's job.
  if (hop.challenge) return HUMAN_CHECK;
  if (hop.location !== null) return { kind: "follow", target: hop.location, method: "http" };

  const ok = hop.statusCode >= 200 && hop.statusCode < 300;
  // Like a browser: a Refresh header first, then what the page itself says.
  const refresh = ok && hop.refresh !== null ? refreshTarget(hop.refresh, url) : null;
  if (refresh !== null) return { kind: "follow", target: refresh, method: "meta-refresh" };
  // An error page never sends anyone on; it is only read to see whether it asks for a person.
  const page = hop.html === null ? null : findHtmlTarget(hop.html, url, { onlyHumanCheck: !ok });
  if (page?.kind === "human-check") return HUMAN_CHECK;
  if (!ok) {
    // A 3xx without a usable Location says the page is elsewhere without saying where.
    const detail =
      hop.statusCode >= 300 && hop.statusCode < 400 ? " without a redirect to follow" : "";
    const error = `The server answered with HTTP ${hop.statusCode}${detail}`;
    return { kind: "stop", status: "UNRESOLVED", error };
  }
  if (page?.kind === "redirect") return { kind: "follow", target: page.url, method: page.method };
  if (page?.kind === "unknown-script") {
    // The page leaves by itself, so it is not the destination, but where it goes is unknown.
    const error = "JavaScript destination could not be determined";
    return { kind: "stop", status: "UNRESOLVED", error, tryBrowser: true };
  }
  // Scripts that may still move on in a way only running them shows.
  const tryBrowser = page?.scriptsMayLeave;
  if (page?.kind === "needs-click") {
    // Not the destination, but it only goes on when a person clicks (with JavaScript).
    const error = "The page asks for a click to continue to another site";
    return { kind: "stop", status: "UNRESOLVED", error, tryBrowser };
  }
  return { kind: "arrived", tryBrowser };
}

function heavier(a: ResolveMethod, b: ResolveMethod): ResolveMethod {
  return METHOD_ORDER.indexOf(a) > METHOD_ORDER.indexOf(b) ? a : b;
}

/**
 * The browser kept going round: a page came up three times (A, B, A, B, A). Twice is not enough,
 * because a page that sets a cookie and reloads itself comes up twice on its way somewhere.
 */
function revisits(chain: string[]): boolean {
  const seen = new Map<string, number>();
  for (const href of chain) {
    const page = href.replace(/#.*/s, "");
    seen.set(page, (seen.get(page) ?? 0) + 1);
  }
  return [...seen.values()].some((times) => times >= 3);
}
