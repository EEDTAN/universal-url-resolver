/** How a resolution ended. Only "RESOLVED" is a success. */
export type ResolveStatus =
  | "RESOLVED"
  | "UNRESOLVED"
  | "TIMEOUT"
  | "BLOCKED"
  | "INVALID_URL"
  | "REDIRECT_LOOP"
  | "ERROR";

/** Resolver steps, lightest first. Lowercase, as in the JSON output ("method": "browser"). */
export type ResolveMethod = "http" | "html" | "meta-refresh" | "javascript" | "browser" | "adapter";

interface ResultFields {
  /**
   * The normalized input ("https://" added, username and password removed).
   * For INVALID_URL it is url-parser's safeInput: credentials removed and cut to MAX_URL_LENGTH,
   * so it can differ from the exact text that was typed.
   */
  originalUrl: string;
  /** The heaviest step that got an answer; null when no request was answered. */
  method: ResolveMethod | null;
  /** Redirects in the chain: chain.length - 1, or 0 when chain is empty. */
  redirectCount: number;
  /**
   * originalUrl, then every redirect target in order. The last entry is where resolution stopped.
   * After a failure that can be a URL that was refused or never answered. Only http(s) URLs appear
   * here: a redirect to any other scheme is described in `error` instead. Empty only for INVALID_URL.
   */
  chain: string[];
  /** Status code of the last HTTP response, or null when no response arrived. */
  httpStatus: number | null;
  timing: { elapsedMs: number };
  /** credentialsRemoved: a URL contained user:password@ (a common phishing trick). It was never sent. */
  security: { credentialsRemoved: boolean };
}

/**
 * What a query parameter is for. "tracking": it only says where the visit came from (utm_source,
 * fbclid). "functional": it chooses what the page shows (id, q). "unknown": anything else, which
 * may well matter to the page. Only tracking parameters are ever taken out.
 */
export type ParameterKind = "tracking" | "functional" | "unknown";

/** The query parameters of the final URL. */
export interface TrackingReport {
  /** The final URL without its tracking parameters; the final URL itself when it has none. */
  cleanUrl: string;
  /** Every parameter in the final URL's query, in order, with name and value decoded. */
  parameters: { name: string; value: string; kind: ParameterKind }[];
}

/**
 * What a real browser saw when it opened a page and waited until the page stopped navigating.
 * `chain` is the URL it opened, then every page the browser was sent to, HTTP redirects included,
 * in order. Its last entry is where the browser stopped. It can hold a URL that is not http(s),
 * such as about:blank, for the caller to refuse.
 */
export type BrowserVisit =
  | {
      ok: true;
      chain: string[];
      /** HTTP status of the page the browser ended on, or of the file it ended up downloading. */
      statusCode: number;
      /** A page asked for human verification (Cloudflare's cf-mitigated: challenge header). */
      challenge: boolean;
      /** The Refresh header of the page the browser ended on, or null. */
      refresh: string | null;
      /**
       * The page as the browser shows it, after its scripts ran (at most MAX_HTML_SIZE characters);
       * null for a download or a human verification page.
       */
      html: string | null;
    }
  | { ok: false; status: "BLOCKED" | "TIMEOUT" | "ERROR"; error: string; chain: string[] };

/** Opens pages in a real browser. @urlresolve/browser-resolver makes one. */
export interface BrowserResolver {
  /**
   * Opens `url` in a fresh, empty browser profile and follows it until it stays put.
   * Stops after `maxNavigations` navigations, and when `signal` aborts. `cookie` holds the
   * cookies this resolution already has for url (a Cookie header value), which the browser
   * starts with; nothing else carries over from one visit to the next.
   */
  visit(
    url: URL,
    options: { signal: AbortSignal; maxNavigations: number; cookie?: string },
  ): Promise<BrowserVisit>;
}

/** What an adapter is shown: a page that answered with a 2xx status. */
export interface AdapterContext {
  /** The page's URL. A copy of its own: changing it changes nothing for the resolution. */
  url: URL;
  /** The page's HTML (at most MAX_HTML_SIZE characters), or null when the answer was not HTML. */
  html: string | null;
}

/**
 * Knowledge about one shortener service, for a page of it on which the generic readers find no
 * way on. Core asks the first adapter whose matches() is true, and only then: never about a page
 * the readers can follow, an error page, or a page it sees asking for human verification
 * (Cloudflare's challenge header, or a CAPTCHA widget or sign-in form in the HTML as served).
 * The adapter answers with the next URL, and core treats that like any redirect: http(s) only, the
 * address policy, loop detection and maxRedirects all apply, and the resolution goes on from there.
 *
 * Rules for an adapter:
 * - It never gets past a CAPTCHA, a login or any other human check. Core cannot see one that a
 *   script puts up, or one on a page that is not HTML, so look at the service's real page in a
 *   browser: where it asks for a person, next() answers null.
 * - It answers only with the URL the service itself sends the visitor to next (a link, frame or
 *   form of the page, or a redirect the service is known to make), never with a URL the page
 *   merely names or loads (an API, a script), and never with a guess. A URL in the page's own
 *   address proves nothing: LinkedIn's "Link Error" page names one it does not go to.
 * - It makes no requests of its own, and it is quick. html is up to 1 MiB written by the page's
 *   owner, and timeoutMs cannot stop code that never waits, so a slow adapter holds up every
 *   resolution. Search with indexOf or htmlparser2, never with a pattern that has two .* or .*?
 *   in it.
 */
export interface ShortenerAdapter {
  /** Short and unique, such as "example-shortener". */
  name: string;
  /**
   * Whether `url` is a page of the service this adapter knows. Quick, with no side effects.
   * Keep it narrow: core asks again about every page on the way, the destination included.
   */
  matches(url: URL): boolean;
  /** The next URL (absolute, or relative to context.url), or null when this page shows none. */
  next(context: AdapterContext): string | null;
}

/**
 * The JSON shown by the CLI, API and web UI. finalUrl and tracking are set exactly when status is
 * "RESOLVED".
 */
export type ResolveResult =
  | (ResultFields & {
      status: "RESOLVED";
      finalUrl: string;
      tracking: TrackingReport;
      error: null;
    })
  | (ResultFields & {
      status: Exclude<ResolveStatus, "RESOLVED">;
      finalUrl: null;
      tracking: null;
      /** Why it failed, shown as `${status}: ${error}`, e.g. "BLOCKED: Destination resolves to private network". */
      error: string;
    });
