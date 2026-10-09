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
  /** Filled in by the tracking analyzer in a later phase. */
  tracking: null;
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

/** The JSON shown by the CLI, API and web UI. finalUrl is set exactly when status is "RESOLVED". */
export type ResolveResult =
  | (ResultFields & { status: "RESOLVED"; finalUrl: string; error: null })
  | (ResultFields & {
      status: Exclude<ResolveStatus, "RESOLVED">;
      finalUrl: null;
      /** Why it failed, shown as `${status}: ${error}`, e.g. "BLOCKED: Destination resolves to private network". */
      error: string;
    });
