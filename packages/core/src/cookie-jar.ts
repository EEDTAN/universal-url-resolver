// Most servers refuse a Cookie header much over 8 KB, and browsers allow about 4 KB per cookie.
// Holding each origin to 8 KB keeps the header small, and with it every loop-detection key built
// from it, even when a site sets new cookies on every hop. The oldest cookies go first.
const MAX_BYTES_PER_ORIGIN = 8 * 1024;

/**
 * Cookies for one resolution. They live in memory and are dropped with it: nothing is saved,
 * logged or put in the result. Some links set a cookie and redirect to themselves to check it;
 * without the cookie that would look like a loop.
 *
 * ponytail: simpler than a browser on purpose. A cookie only goes back to the exact origin
 * (scheme, host and port) that set it, and Domain, Path, Secure and SameSite are ignored.
 * Switch to the full RFC 6265 rules once a real link needs a cookie shared between subdomains.
 */
export class CookieJar {
  readonly #byOrigin = new Map<string, Map<string, string>>();

  /** Applies the Set-Cookie headers of a response from `url`. */
  store(url: URL, setCookies: readonly string[]): void {
    const cookies = this.#byOrigin.get(url.origin) ?? new Map<string, string>();
    for (const line of setCookies) {
      const [pair = "", ...attributes] = line.split(";");
      const equals = pair.indexOf("=");
      const name = equals === -1 ? "" : pair.slice(0, equals).trim();
      if (name === "") continue; // browsers keep nameless cookies too, but no redirect needs one
      // Deleted first, so a cookie that is set again counts as the newest.
      cookies.delete(name);
      if (!isExpired(attributes)) cookies.set(name, pair.slice(equals + 1).trim());
    }
    let bytes = 0;
    for (const [name, value] of cookies) bytes += name.length + value.length + 3; // "name=value; "
    for (const [name, value] of cookies) {
      if (bytes <= MAX_BYTES_PER_ORIGIN) break;
      cookies.delete(name); // a Map keeps insertion order, so this is the oldest one left
      bytes -= name.length + value.length + 3;
    }
    this.#byOrigin.set(url.origin, cookies);
  }

  /** The Cookie header for a request to `url`, or undefined when there is nothing to send. */
  header(url: URL): string | undefined {
    const cookies = this.#byOrigin.get(url.origin);
    if (!cookies?.size) return undefined;
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }
}

// "Max-Age=0" (or less) deletes a cookie, and so does an Expires date in the past.
// Max-Age wins when both are there, the way browsers read it.
function isExpired(attributes: string[]): boolean {
  let expires = Number.NaN;
  for (const attribute of attributes) {
    const equals = attribute.indexOf("=");
    const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const value = equals === -1 ? "" : attribute.slice(equals + 1).trim();
    if (key === "max-age" && /^-?\d+$/.test(value)) return Number(value) <= 0;
    // A cookie date needs a time of day (RFC 6265). Without that check Date.parse would read
    // "Expires=0" as the year 2000; browsers ignore such a value, and so does this jar.
    if (key === "expires" && /\d{1,2}:\d{1,2}:\d{1,2}/.test(value)) expires = Date.parse(value);
  }
  return expires <= Date.now();
}
