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
  /** The heaviest step that was needed; null when nothing was requested. */
  method: ResolveMethod | null;
  /** Redirects followed: chain.length - 1, or 0 when chain is empty. */
  redirectCount: number;
  /** Every URL in order, starting with originalUrl. Empty only for INVALID_URL. */
  chain: string[];
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
