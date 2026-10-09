import { findJsTarget } from "@urlresolve/js-resolver";
import { isHttpUrl } from "@urlresolve/url-parser";
import { Parser } from "htmlparser2";

/**
 * A refresh that waits longer than this is a page reloading itself or a session timeout
 * ("log out after 15 minutes"), not a redirect page ("you will be sent on in 5 seconds").
 */
export const MAX_REFRESH_DELAY_SECONDS = 60;

/**
 * ponytail: elements nested deeper than this end the reading, and the rest of the page is ignored,
 * like the part after MAX_HTML_SIZE. Chrome stops nesting at the same depth. htmlparser2 slows down
 * quadratically on unclosed tags (1 MiB of "<b>" blocked Node for over a minute), so without the cap
 * one hostile page could freeze every resolution running in the process.
 */
const MAX_DEPTH = 512;

// The visible widgets of Cloudflare Turnstile, Google reCAPTCHA and hCaptcha. Only a person can
// complete them. Their scripts alone prove nothing: the invisible versions run on ordinary pages.
const CAPTCHA_CLASSES = ["cf-turnstile", "g-recaptcha", "h-captcha"];

const WHITESPACE = "\t\n\f\r "; // what HTML calls ASCII whitespace
const DIGITS = "0123456789";

// <script type="..."> values a browser runs: the HTML standard's JavaScript MIME types, compared
// whole. Anything else is data or not run at all: JSON-LD, templates, "text/javascript; charset=".
const SCRIPT_TYPES = new Set([
  "",
  "module",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

export type HtmlFinding =
  /** The page sends the visitor on to `url` (absolute, not yet checked for safety). */
  | { kind: "redirect"; url: string; method: "meta-refresh" | "html" | "javascript" }
  /** The page wants a person to prove they are human, or to sign in. */
  | { kind: "human-check" }
  /** A script leaves the page by itself, but where to could not be worked out without running it. */
  | { kind: "unknown-script" }
  /** A "you are leaving" page that shows where it leads but has no link there: it waits for a click. */
  | { kind: "needs-click" }
  /** Nothing found: as far as the page shows, it is the destination. */
  | { kind: "none" };

/**
 * Where a Refresh header or a <meta http-equiv="refresh"> sends the browser, as an absolute URL.
 * null when it does not redirect: no URL or the same page again (a reload), a delay above
 * MAX_REFRESH_DELAY_SECONDS, or a value browsers ignore. Relative URLs use `base`.
 */
export function refreshTarget(content: string, page: URL, base: URL = page): string | null {
  const refresh = parseRefresh(content);
  if (refresh === null || refresh.url === null || refresh.delay > MAX_REFRESH_DELAY_SECONDS) {
    return null;
  }
  const target = URL.parse(refresh.url, base.href);
  if (target === null || withoutFragment(target) === withoutFragment(page)) return null;
  return target.href;
}

/**
 * Reads a page that answered without an HTTP redirect and decides whether it sends the visitor
 * on. The HTML is read the way a browser with JavaScript turned off sees it; the scripts are read
 * without running them (see @urlresolve/js-resolver). In this order:
 * 1. a meta refresh, which the browser follows by itself (also one in <noscript> that leaves the
 *    site; one that stays on it leads to a "please turn on JavaScript" page);
 * 2. a CAPTCHA or Turnstile widget, or a sign-in form on a page whose address says where to go
 *    back to afterwards (?next=/doc): stop, a person is needed;
 * 3. a frameset with a single frame: the visitor only ever sees that frame;
 * 4. a "you are leaving this site" page: the page's own address names an external URL in a
 *    query parameter (?u=, ?url=, ?q= ...), and the page either links to exactly that URL or
 *    hands the visitor to a redirector on another host whose address names the same URL
 *    (Facebook's warning page does this);
 * 5. a script that leaves the page by itself, such as location.replace("...");
 * 6. a "you are leaving" page that only shows the URL as text: a click is needed.
 * No other link is followed: a page full of links is simply a page.
 * With onlyHumanCheck (an error page, which sends nobody on), only rule 2 is applied.
 */
export function findHtmlTarget(
  html: string,
  page: URL,
  { onlyHumanCheck = false } = {},
): HtmlFinding {
  const named = namedUrls(page); // usually empty, and then neither links nor text are collected
  const leavingTo = new Map(named.map((url) => [url.key, url.href]));
  let base = page;
  let baseFound = false;
  let humanCheck = false;
  let password = false;
  let frameset = false;
  let depth = 0; // elements open right now
  let templateDepth = 0;
  let noscriptDepth = 0;
  let codeDepth = 0; // inside <script> or <style>, whose text is not shown
  let text = "";
  let script: string | null = null; // the script being read right now
  const scripts: string[] = [];
  const refreshes: { content: string; base: URL }[] = [];
  const frames: string[] = [];
  const links: string[] = [];

  const parser = new Parser({
    ontext(data) {
      if (script !== null) script += data;
      else if (named.length > 0 && templateDepth === 0 && codeDepth === 0) text += data;
    },
    onopentag(name, attributes) {
      depth += 1;
      if (depth > MAX_DEPTH) {
        parser.pause(); // parser.write() stops here
        return;
      }
      if (name === "template") templateDepth += 1;
      if (name === "noscript") noscriptDepth += 1;
      if (name === "script" || name === "style") codeDepth += 1;
      if (templateDepth > 0) return; // the content of a <template> is inert in browsers too
      // A browser that runs scripts never runs one inside <noscript>.
      if (noscriptDepth === 0) {
        if (name === "script" && runsInline(attributes)) script = "";
        const onload = attributes.onload;
        if ((name === "body" || name === "frameset") && onload) scripts.push(onload);
      }
      if (name === "base" && !baseFound && attributes.href !== undefined) {
        baseFound = true;
        const url = URL.parse(attributes.href, page.href);
        if (url !== null && isHttpUrl(url)) base = url;
      }
      if (name === "meta" && attributes["http-equiv"]?.trim().toLowerCase() === "refresh") {
        const content = attributes.content ?? "";
        const refresh = parseRefresh(content);
        const target = refresh?.url ? URL.parse(refresh.url, base.href) : null;
        // Browsers skip a refresh they cannot read, including one whose URL does not parse.
        const readable = refresh !== null && (!refresh.url || target !== null);
        const javascriptNotice = noscriptDepth > 0 && target?.hostname === page.hostname;
        if (readable && !javascriptNotice) refreshes.push({ content, base });
      }
      if (isHumanCheck(name, attributes)) humanCheck = true;
      if (name === "input" && attributes.type?.trim().toLowerCase() === "password") password = true;
      if (name === "frameset") frameset = true;
      const source = attributes.src?.trim();
      if (name === "frame" && source && source !== "about:blank") frames.push(source);
      if (named.length > 0) links.push(...linkValues(name, attributes));
    },
    onclosetag(name, isImplied) {
      depth -= 1;
      if (name === "script" && script !== null) {
        // A script still open where the page ends never runs: the browser waits for </script>.
        if (!isImplied) scripts.push(script);
        script = null;
      }
      if (name === "template" && templateDepth > 0) templateDepth -= 1;
      if (name === "noscript" && noscriptDepth > 0) noscriptDepth -= 1;
      if ((name === "script" || name === "style") && codeDepth > 0) codeDepth -= 1;
    },
  });
  parser.write(html);
  parser.end();

  // Browsers act on the first refresh they can read and ignore any after it.
  const [refresh] = refreshes;
  const refreshed = refresh && refreshTarget(refresh.content, page, refresh.base);
  if (refreshed && !onlyHumanCheck)
    return { kind: "redirect", url: refreshed, method: "meta-refresh" };
  const returnTo = [...page.searchParams.values()].some(
    (value) => value.startsWith("/") || /^https?:\/\//i.test(value),
  );
  if (humanCheck || (password && returnTo)) return { kind: "human-check" };
  if (onlyHumanCheck) return { kind: "none" };

  const [onlyFrame, ...otherFrames] = frames;
  if (frameset && onlyFrame !== undefined && otherFrames.length === 0) {
    const frame = URL.parse(onlyFrame, base.href);
    if (frame !== null && withoutFragment(frame) !== withoutFragment(page)) {
      return { kind: "redirect", url: frame.href, method: "html" };
    }
  }
  const targets = links.flatMap((link) => URL.parse(link, base.href) ?? []);
  for (const target of targets) {
    const href = leavingTo.get(withoutFragment(target));
    if (href) return { kind: "redirect", url: href, method: "html" };
  }
  for (const target of targets) {
    // Another host's redirector for the same URL. A search page that wraps its results in its own
    // redirector (google.com/url?q=...) stays on its host, so it is not taken for one of these.
    if (target.hostname === page.hostname) continue;
    if (namedUrls(target).some((url) => leavingTo.has(url.key))) {
      return { kind: "redirect", url: target.href, method: "html" };
    }
  }
  const scripted = findJsTarget(scripts, page, base);
  if (scripted.kind === "redirect") {
    return { kind: "redirect", url: scripted.url, method: "javascript" };
  }
  if (scripted.kind === "unknown") return { kind: "unknown-script" };
  // Shown as the address wrote it, as the URL parser rewrites it, or without the trailing slash.
  const shown = named.flatMap((url) => [url.written, url.href, url.href.replace(/\/$/, "")]);
  if (shown.some((form) => text.includes(form))) return { kind: "needs-click" };
  return { kind: "none" };
}

/**
 * The HTML standard's "shared declarative refresh steps": "5; url=/next" is { delay: 5,
 * url: "/next" }. The "url=" part, quotes and a fraction on the delay are all optional.
 * url is null when there is none (a reload). Returns null for a value browsers ignore.
 */
function parseRefresh(input: string): { delay: number; url: string | null } | null {
  let position = 0;
  const skip = (allowed: string) => {
    while (position < input.length && allowed.includes(input.charAt(position))) position += 1;
  };
  skip(WHITESPACE);
  const timeStart = position;
  skip(DIGITS);
  const time = input.slice(timeStart, position);
  if (time === "" && input.charAt(position) !== ".") return null;
  skip(`${DIGITS}.`); // a fraction of a second is ignored
  const delay = time === "" ? 0 : Number(time);
  if (position < input.length) {
    if (!`;,${WHITESPACE}`.includes(input.charAt(position))) return null;
    skip(WHITESPACE);
    if (input.charAt(position) === ";" || input.charAt(position) === ",") position += 1;
    skip(WHITESPACE);
  }
  if (position >= input.length) return { delay, url: null };

  let url = input.slice(position);
  const prefix = /^url[\t\n\f\r ]*=[\t\n\f\r ]*/i.exec(url);
  // Starting with "u" without being "url=": the standard uses the text as it is, quotes and all.
  if (prefix === null && /^u/i.test(url)) return { delay, url };
  if (prefix !== null) url = url.slice(prefix[0].length);
  const quote = url.charAt(0);
  if (quote === '"' || quote === "'") {
    url = url.slice(1);
    const end = url.indexOf(quote);
    if (end !== -1) url = url.slice(0, end);
  }
  return { delay, url };
}

/** Whether a browser runs the text inside a <script> with these attributes. */
function runsInline(attributes: Record<string, string>): boolean {
  // The type, or for old pages "text/" and the language (language="JavaScript").
  const language = attributes.language ? `text/${attributes.language}` : "";
  const type = (attributes.type ?? language).trim().toLowerCase();
  if (!SCRIPT_TYPES.has(type)) return false;
  // With src the browser runs that file instead. nomodule is for browsers without modules.
  return attributes.src === undefined && (type === "module" || attributes.nomodule === undefined);
}

function isHumanCheck(name: string, attributes: Record<string, string>): boolean {
  const classes = (attributes.class ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
  if (CAPTCHA_CLASSES.some((widget) => classes.includes(widget))) {
    return attributes["data-size"]?.toLowerCase() !== "invisible";
  }
  // A home-made CAPTCHA: a text box whose name or id says "captcha".
  const field = `${attributes.name ?? ""} ${attributes.id ?? ""}`;
  return name === "input" && attributes.type?.toLowerCase() !== "hidden" && /captcha/i.test(field);
}

/** What an element points to: a link, a form target, a frame, the canonical URL, data-* values. */
function linkValues(name: string, attributes: Record<string, string>): string[] {
  const canonical = name === "link" && /(^|\s)canonical(\s|$)/i.test(attributes.rel ?? "");
  return Object.entries(attributes)
    .filter(
      ([key]) =>
        key.startsWith("data-") ||
        (key === "href" && (name === "a" || name === "area" || canonical)) ||
        (key === "action" && name === "form") ||
        (key === "src" && (name === "iframe" || name === "frame")),
    )
    .map(([, value]) => value);
}

/**
 * The absolute http(s) URLs on another host that `url` names in its query string, as a parameter
 * name or value. Each comes with its key (no #fragment), its href, and how the address wrote it.
 *
 * ponytail: a search results page for a URL that links straight to it would read as "leaving to"
 * it. Search engines wrap result links for clients without JavaScript, so this rarely matches.
 */
function namedUrls(url: URL): { key: string; href: string; written: string }[] {
  const found: { key: string; href: string; written: string }[] = [];
  for (const [name, value] of url.searchParams) {
    // URLSearchParams reads an unencoded "+" as a space, so the "+" spelling is tried as well.
    for (const written of [name, value, value.replaceAll(" ", "+")]) {
      const named = URL.parse(written);
      if (named !== null && isHttpUrl(named) && named.hostname !== url.hostname) {
        found.push({ key: withoutFragment(named), href: named.href, written });
      }
    }
  }
  return found;
}

function withoutFragment(url: URL): string {
  return url.href.replace(/#.*/s, "");
}
