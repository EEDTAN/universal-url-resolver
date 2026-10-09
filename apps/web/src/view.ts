import type { ResolveMethod, ResolveResult } from "@urlresolve/types";

// How each method is named on the page.
const METHODS: Record<ResolveMethod, string> = {
  http: "HTTP redirects",
  html: "Read from the page",
  "meta-refresh": "Meta refresh",
  javascript: "JavaScript, read without running it",
  browser: "Browser fallback",
  adapter: "Service adapter",
};

/** One line of the security list: a check that passed, or one that did not. */
export interface Check {
  ok: boolean;
  text: string;
}

/** What the page shows for one result. */
export interface View {
  resolved: boolean;
  /** The final URL, or the status when the link did not resolve. */
  headline: string;
  /** Why it did not resolve; null when it did. */
  reason: string | null;
  /** Every URL on the way, with its host for the short form. */
  chain: { position: number; host: string; href: string }[];
  security: Check[];
  /** The names of the tracking parameters, and the final URL without them. */
  tracking: { names: string[]; cleanUrl: string | null };
  /** Redirect count, time, method and HTTP status, as short lines. */
  technical: string[];
}

export function view(result: ResolveResult): View {
  const resolved = result.status === "RESOLVED";
  const security: Check[] = [];
  if (result.status === "RESOLVED") {
    const https = result.finalUrl.startsWith("https:");
    security.push({ ok: https, text: https ? "HTTPS" : "Not HTTPS" });
    security.push({ ok: true, text: "Public destination" });
  } else if (result.status === "BLOCKED") {
    security.push({ ok: false, text: `Blocked: ${result.error}` });
  }
  if (result.security.credentialsRemoved) {
    // A user name in front of the host is an old trick to make a link look like another site's.
    security.push({ ok: false, text: "A user name or password was taken out of the link" });
  }
  const names = (result.tracking?.parameters ?? [])
    .filter(({ kind }) => kind === "tracking")
    .map(({ name }) => visible(name));
  const technical = [
    result.redirectCount === 1 ? "1 redirect" : `${result.redirectCount} redirects`,
    `${(result.timing.elapsedMs / 1000).toFixed(2)} seconds`,
    result.method === null ? "No answer from the link" : METHODS[result.method],
  ];
  if (result.httpStatus !== null) technical.push(`HTTP ${result.httpStatus}`);
  return {
    resolved,
    headline: result.status === "RESOLVED" ? result.finalUrl : result.status,
    reason: result.status === "RESOLVED" ? null : result.error,
    chain: result.chain.map((href, i) => ({ position: i + 1, host: new URL(href).host, href })),
    security,
    tracking: {
      names,
      cleanUrl: result.status === "RESOLVED" && names.length > 0 ? result.tracking.cleanUrl : null,
    },
    technical,
  };
}

/** What to tell the person when the API itself refused, by its HTTP status. */
export function apiProblem(status: number): string {
  if (status === 400 || status === 413) return "That is not a link the server can take.";
  if (status === 429) return "Too many links at once: wait a minute, then try again.";
  if (status === 503) return "The server is busy right now: try again in a moment.";
  return `The server answered with HTTP ${status}.`;
}

/**
 * Text from a link, made safe to show: control and invisible formatting characters (such as one
 * that reverses the text after it) are written as \u{...}. A decoded query parameter can hold
 * any of them; URLs themselves cannot.
 */
export function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (found) => `\\u{${found.codePointAt(0)?.toString(16)}}`);
}
