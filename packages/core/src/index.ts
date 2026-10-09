import { type HopOptions, requestHop } from "@urlresolve/http-resolver";
import { safeLookup } from "@urlresolve/security";
import type { ResolveMethod, ResolveResult, ResolveStatus } from "@urlresolve/types";
import { parseInputUrl, resolveLocation } from "@urlresolve/url-parser";
import { CookieJar } from "./cookie-jar.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
/** The same limit browsers use (Fetch standard). */
export const DEFAULT_MAX_REDIRECTS = 20;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ResolveOptions {
  /** Time limit for the whole resolution, in milliseconds. Default 10 000. */
  timeoutMs?: number;
  /** Most redirects to follow. Default 20. */
  maxRedirects?: number;
  /** Stops the resolution early, for example when the user cancels it. */
  signal?: AbortSignal;
  /**
   * DNS and address policy for every connection. Default: safeLookup from @urlresolve/security,
   * which only allows public addresses. Tests pass their own to reach a local mock server.
   */
  lookup?: HopOptions["lookup"];
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
  let httpStatus: number | null = null;
  let credentialsRemoved = parsed.credentialsRemoved;
  const cookies = new CookieJar();
  const requestsSent = new Set<string>();

  const finish = (status: ResolveStatus, error = ""): ResolveResult => {
    const method: ResolveMethod | null = httpStatus === null ? null : "http";
    const fields = {
      method,
      redirectCount: chain.length - 1,
      chain,
      httpStatus,
      timing: { elapsedMs: elapsedMs() },
      security: { credentialsRemoved },
      tracking: null,
    };
    // Keys in the order the JSON output shows them.
    return status === "RESOLVED"
      ? { originalUrl: parsed.url.href, finalUrl: url.href, status, ...fields, error: null }
      : { originalUrl: parsed.url.href, finalUrl: null, status, ...fields, error };
  };

  for (;;) {
    const cookie = cookies.header(url);
    // The same URL with the same cookies is the same request, so its answer would repeat too.
    // The #fragment is never sent, so it does not count.
    const request = `${url.href.split("#")[0]} ${cookie ?? ""}`;
    if (requestsSent.has(request)) {
      return finish("REDIRECT_LOOP", "The redirects lead back to a URL that was already visited");
    }
    requestsSent.add(request);
    if (chain.length - 1 > maxRedirects) {
      return finish("UNRESOLVED", `More than ${maxRedirects} redirects`);
    }

    const hop = await requestHop(url, { lookup, signal, cookie });
    if (!hop.ok) return finish(hop.status, hop.error);
    httpStatus = hop.statusCode;
    cookies.store(url, hop.setCookies);

    // Only a person can pass this check, and getting around it is not this project's job.
    if (hop.challenge) return finish("UNRESOLVED", "Human verification required");
    if (hop.location === null) {
      // Nothing to follow. Only a 2xx answer is the page itself; a 3xx without a usable Location
      // says the page is somewhere else without saying where, and 4xx/5xx are errors.
      if (httpStatus >= 200 && httpStatus < 300) return finish("RESOLVED");
      const detail = httpStatus >= 300 && httpStatus < 400 ? " without a redirect to follow" : "";
      return finish("UNRESOLVED", `The server answered with HTTP ${httpStatus}${detail}`);
    }
    const next = resolveLocation(hop.location, url);
    credentialsRemoved ||= next.credentialsRemoved;
    if (!next.ok) return finish(next.status, next.error);
    url = next.url;
    chain.push(url.href);
  }
}
