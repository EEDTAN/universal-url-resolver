/** Longest URL accepted anywhere: user input, Location headers and (later) URLs found in pages. */
export const MAX_URL_LENGTH = 8192;

export type ParseResult =
  | { ok: true; url: URL; credentialsRemoved: boolean }
  | {
      ok: false;
      status: "INVALID_URL" | "BLOCKED" | "ERROR";
      error: string;
      /** The input for display: any user:password part removed, cut to MAX_URL_LENGTH. Safe to show or log. */
      safeInput: string;
      /**
       * The URL parser found a username or password. Input it never read (empty, too long, not a URL)
       * reports false, even when safeInput had a user:password-like part cut out.
       */
      credentialsRemoved: boolean;
    };

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// URL reads "localhost:8080/x" and "bit.ly:443/x" as the schemes "localhost:" and "bit.ly:", but
// they are host:port. The lookahead (a dot before the first colon) keeps the match linear.
const HOST_AND_PORT = /^(?:localhost|(?=[^:]*\.[^:])[^\s/?#@:]+):\d+(?:[/?#]|$)/i;
const TOO_LONG = `URL is longer than ${MAX_URL_LENGTH} characters`;

export function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** User input -> absolute http(s) URL. "bit.ly/x" and "//bit.ly/x" become "https://bit.ly/x". */
export function parseInputUrl(input: string): ParseResult {
  // trim() also removes Unicode spaces that often come along when a link is copied.
  const text = withoutIgnoredCharacters(input).trim();
  if (text === "") return fail("INVALID_URL", "URL is empty", text);
  if (text.length > MAX_URL_LENGTH) return fail("INVALID_URL", TOO_LONG, text);
  const hasScheme = HAS_SCHEME.test(text) && !HOST_AND_PORT.test(text);
  const url = URL.parse(hasScheme ? text : `https://${text}`);
  if (url === null) return fail("INVALID_URL", "Not a valid URL", text);
  if (!isHttpUrl(url)) {
    const error = `Only http and https links can be resolved (got "${url.protocol}")`;
    const credentialsRemoved = removeCredentials(url); // before url.href is read
    return fail("INVALID_URL", error, url.href, credentialsRemoved);
  }
  return withoutCredentials(url, "INVALID_URL");
}

/**
 * A redirect target resolved against the URL that sent it, the way a browser does it.
 * "example.com/x" is therefore a relative path, not a host. An HTTP redirect without its own
 * #fragment keeps the original one (RFC 9110, section 10.2.2); a target taken from a page (a meta
 * refresh, a link) does not, so pass { inheritFragment: false } for those.
 */
export function resolveLocation(
  location: string,
  base: URL,
  { inheritFragment = true } = {},
): ParseResult {
  if (location.length > MAX_URL_LENGTH) return fail("ERROR", TOO_LONG, location);
  const url = URL.parse(location, base.href);
  if (url === null) return fail("ERROR", "Redirect target is not a valid URL", location);
  if (!isHttpUrl(url)) {
    const error = `Redirect to a "${url.protocol}" URL was not followed (only http and https)`;
    const credentialsRemoved = removeCredentials(url); // before url.href is read
    return fail("BLOCKED", error, url.href, credentialsRemoved);
  }
  if (inheritFragment && !location.includes("#")) url.hash = base.hash;
  return withoutCredentials(url, "ERROR");
}

// node:http would send user:password as an Authorization header, so it is removed. The flag keeps
// the signal: "https://paypal.com@evil.example/" is a classic phishing trick. MAX_URL_LENGTH is
// checked again on the final href, because percent-encoding can make it much longer than the input.
function withoutCredentials(url: URL, tooLongStatus: "INVALID_URL" | "ERROR"): ParseResult {
  const credentialsRemoved = removeCredentials(url);
  if (url.href.length > MAX_URL_LENGTH) {
    return fail(tooLongStatus, TOO_LONG, url.href, credentialsRemoved);
  }
  return { ok: true, url, credentialsRemoved };
}

/** Clears user:password from `url` and tells whether there was any. */
function removeCredentials(url: URL): boolean {
  const found = url.username !== "" || url.password !== "";
  url.username = "";
  url.password = "";
  return found;
}

function fail(
  status: "INVALID_URL" | "BLOCKED" | "ERROR",
  error: string,
  text: string,
  credentialsRemoved = false,
): ParseResult {
  return { ok: false, status, error, safeInput: withoutUserinfo(text), credentialsRemoved };
}

// Display only, so it also has to work on text the URL parser could not read. Everything between
// "scheme:" (with its slashes) and the last "@" is removed, because it may be a username and
// password, and a password can itself contain / ? # or \ ("https://key:a/b@host", or
// "blob:https://user:pw@host"). This sometimes cuts more than needed from a rejected input; that
// is fine, showing a password is not. It happens before the text is shortened, so a cut can never
// leave half a password behind.
function withoutUserinfo(input: string): string {
  const text = withoutIgnoredCharacters(input);
  let start = HAS_SCHEME.exec(text)?.[0].length ?? 0;
  while (text[start] === "/" || text[start] === "\\") start += 1;
  const at = text.lastIndexOf("@");
  const cleaned = at < start ? text : text.slice(0, start) + text.slice(at + 1);
  return cleaned.slice(0, MAX_URL_LENGTH);
}

// The URL parser ignores tabs and newlines anywhere, and control characters and spaces (code 0x20
// and below) at either end. Doing the same means the checks here see exactly what the parser sees.
function withoutIgnoredCharacters(input: string): string {
  const text = input.replace(/[\t\n\r]/g, "");
  let from = 0;
  let to = text.length;
  while (from < to && text.charCodeAt(from) <= 0x20) from += 1;
  while (to > from && text.charCodeAt(to - 1) <= 0x20) to -= 1;
  return text.slice(from, to);
}
