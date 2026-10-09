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

/** The JSON shown by the CLI, API and web UI. finalUrl is set exactly when status is "RESOLVED". */
export type ResolveResult =
  | (ResultFields & { status: "RESOLVED"; finalUrl: string; error: null })
  | (ResultFields & {
      status: Exclude<ResolveStatus, "RESOLVED">;
      finalUrl: null;
      /** Why it failed, shown as `${status}: ${error}`, e.g. "BLOCKED: Destination resolves to private network". */
      error: string;
    });
