import { setTimeout as delay } from "node:timers/promises";
import { type HopOptions, MAX_HTML_SIZE, REDIRECT_STATUSES } from "@urlresolve/http-resolver";
import { safeLookup } from "@urlresolve/security";
import type { BrowserResolver, BrowserVisit } from "@urlresolve/types";
import { type Browser, type BrowserContext, chromium, type Request } from "playwright-core";
import { type ProxyProblem, startVisitProxy, type VisitProxy } from "./proxy.ts";

/** How long a page must stay put after it has loaded before it counts as the destination. */
export const DEFAULT_SETTLE_MS = 3000;
/** Pages open at the same time. More visits wait for their turn. */
export const DEFAULT_MAX_PAGES = 2;
const POLL_MS = 50;

export interface BrowserResolverOptions {
  /** DNS and the address policy for every connection the browser makes. Default: safeLookup. */
  lookup?: HopOptions["lookup"];
  /** Default DEFAULT_SETTLE_MS. */
  settleMs?: number;
  /** Default DEFAULT_MAX_PAGES. */
  maxPages?: number;
  /** A Chromium to use instead of the one Playwright installed. */
  executablePath?: string;
}

export interface ClosableBrowserResolver extends BrowserResolver {
  /** Closes the browser. A visit after this starts a new one. */
  close(): Promise<void>;
}

/**
 * A browser for @urlresolve/core, for pages its static readers cannot settle. Chromium starts on
 * the first visit and is shared by the visits after it, but every visit gets a new, empty profile
 * that is thrown away afterwards, so no cookie or stored data outlives the visit. Every request
 * the browser makes goes through a proxy that checks it with `lookup` (see startVisitProxy).
 * Chromium's own DNS answers nothing, and QUIC and WebRTC over UDP, which could go around the
 * proxy, are switched off. Service workers are blocked, downloads refused and popups closed.
 */
export function createBrowserResolver(
  options: BrowserResolverOptions = {},
): ClosableBrowserResolver {
  const {
    lookup = safeLookup,
    settleMs = DEFAULT_SETTLE_MS,
    maxPages = DEFAULT_MAX_PAGES,
    executablePath,
  } = options;
  const turns = new Turns(maxPages);
  let launching: Promise<Browser> | undefined;

  const browser = (): Promise<Browser> => {
    if (launching) return launching;
    const attempt = chromium.launch({
      executablePath,
      chromiumSandbox: true,
      // Every visit's context sets its own proxy. This one is never meant to be used: its name
      // cannot be looked up (see below), so a request outside a context's proxy goes nowhere.
      proxy: { server: "http://per-context" },
      args: [
        // Chromium's own DNS answers nothing. Only the proxy looks names up.
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        // QUIC (HTTP/3) and WebRTC over UDP could leave without the proxy.
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    launching = attempt;
    // A browser that crashed or failed to start is replaced on the next visit.
    const forget = () => {
      if (launching === attempt) launching = undefined;
    };
    attempt.then((instance) => instance.on("disconnected", forget), forget);
    return attempt;
  };

  return {
    async visit(url, { signal, maxNavigations, cookie }) {
      const chain = [url.href];
      try {
        await turns.take(signal);
      } catch {
        return aborted(signal, chain);
      }
      let proxy: VisitProxy | undefined;
      let context: BrowserContext | undefined;
      try {
        const instance = await untilAborted(browser(), signal);
        proxy = await startVisitProxy({ lookup });
        // Not raced with the signal: it takes milliseconds, and a context that arrived after an
        // abort would never be closed.
        context = await instance.newContext({
          // "<-loopback>": also send localhost and 127.0.0.1 through the proxy, which Chromium
          // would otherwise reach directly.
          proxy: { server: proxy.server, bypass: "<-loopback>" },
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        // The cookies this resolution already has for the page, such as a session a redirect set.
        // A cookie Chromium will not take is left out rather than ending the visit.
        if (cookie) await context.addCookies(cookieList(cookie, url)).catch(() => {});
        return await follow(context, url, chain, {
          signal,
          maxNavigations,
          settleMs,
          problems: proxy.problems,
        });
      } catch (error) {
        if (signal.aborted) return aborted(signal, chain);
        return { ok: false, status: "ERROR", error: describe(error), chain };
      } finally {
        await context?.close().catch(() => {});
        await proxy?.close();
        turns.give();
      }
    },

    async close() {
      const attempt = launching;
      launching = undefined;
      const instance = await attempt?.catch(() => undefined);
      await instance?.close();
    },
  };
}

interface FollowOptions {
  signal: AbortSignal;
  maxNavigations: number;
  settleMs: number;
  problems: ReadonlyMap<string, ProxyProblem>;
}

/**
 * Opens `url` and watches the main frame: every navigation request (HTTP redirects included) is
 * added to `chain`. The page has arrived when no navigation is under way, its HTML has been read
 * (DOMContentLoaded) and nothing has happened for settleMs, or when it turned into a download.
 */
async function follow(
  context: BrowserContext,
  url: URL,
  chain: string[],
  { signal, maxNavigations, settleMs, problems }: FollowOptions,
): Promise<BrowserVisit> {
  const page = await untilAborted(context.newPage(), signal);
  const mainFrame = page.mainFrame();
  // Popups and new tabs play no part in where the link goes.
  context.on("page", (other) => {
    if (other !== page) other.close().catch(() => {});
  });
  const state = {
    /** The main-frame navigation request that has not been answered yet. */
    pending: null as Request | null,
    /** The current page's HTML has been read. */
    ready: false,
    quietSince: performance.now(),
    /** HTTP status and Refresh header of the answer the page came from. */
    statusCode: 0,
    refresh: null as string | null,
    challenge: false,
    download: false,
    failure: null as ProxyProblem | null,
    /** The first request, for `url` itself, has been seen; chain already starts with it. */
    opened: false,
  };
  const busy = () => {
    state.quietSince = performance.now();
  };
  // Back to the page the browser shows. A navigation that ended without a page (204, stopped,
  // a link to an app) leaves its URL at the end of the chain, but the browser stayed put.
  const keepShown = () => {
    const shown = withoutFragment(mainFrame.url());
    const at = chain.findLastIndex((href) => withoutFragment(href) === shown);
    if (at !== -1) chain.length = at + 1;
  };

  page.on("request", (request) => {
    if (!request.isNavigationRequest() || request.frame() !== mainFrame) return;
    if (state.opened) {
      if (request.redirectedFrom() === null) keepShown(); // a new navigation, not a redirect hop
      chain.push(request.url());
    }
    state.opened = true;
    state.pending = request;
    state.ready = false;
    busy();
  });
  page.on("response", (response) => {
    if (response.request() !== state.pending) return;
    const headers = response.headers();
    const status = response.status();
    // Cloudflare's marker for its "verify you are human" page: only a person can pass it.
    if (headers["cf-mitigated"] === "challenge") {
      state.challenge = true;
      state.statusCode = status;
    }
    // A redirect is followed by the next request. Any other answer is the page itself, except
    // 204 and 205, after which the browser stays on the page it had.
    if (REDIRECT_STATUSES.has(status) && headers.location) return busy();
    state.pending = null;
    if (status === 204 || status === 205) {
      state.ready = true;
    } else {
      state.statusCode = status;
      state.refresh = headers.refresh ?? null;
    }
    busy();
  });
  page.on("requestfailed", (request) => {
    if (request !== state.pending) return;
    state.pending = null;
    // A failed request always has a failure().
    const reason = (request.failure() as { errorText: string }).errorText;
    // ERR_ABORTED: the page stopped the navigation, another one took over, or the answer
    // turned into a download. The page the browser had stays.
    if (reason === "net::ERR_ABORTED") state.ready = true;
    else
      state.failure = problems.get(hostAndPort(request.url())) ?? {
        status: "ERROR",
        error: `Request failed (${reason})`,
      };
    busy();
  });
  page.on("framenavigated", (frame) => {
    if (frame !== mainFrame) return;
    const where = frame.url();
    // A navigation without a request, to about:blank say, is recorded so that the page before
    // it is not taken for the destination. Chromium's own error page is not a navigation.
    const other = !/^https?:/i.test(where) && !where.startsWith("chrome-error:");
    if (other && where !== chain.at(-1)) chain.push(where);
    busy();
  });
  page.on("domcontentloaded", () => {
    state.ready = true;
    busy();
  });
  page.on("load", busy);
  page.on("download", () => {
    state.download = true;
  });
  page.on("crash", () => {
    state.failure = { status: "ERROR", error: "The page crashed" };
  });
  // close() was called, or Chromium died. The visit closes the page itself only after follow().
  page.on("close", () => {
    state.failure ??= { status: "ERROR", error: "The browser closed during the visit" };
  });

  // Errors of the first navigation arrive through the events above.
  await untilAborted(
    page.goto(url.href, { waitUntil: "commit", timeout: 0 }).catch(() => null),
    signal,
  );
  for (;;) {
    const { statusCode, challenge, refresh } = state;
    if (challenge) return { ok: true, chain, statusCode, challenge, refresh: null, html: null };
    if (state.failure) return { ok: false, ...state.failure, chain };
    if (chain.length - 1 > maxNavigations) {
      return {
        ok: false,
        status: "ERROR",
        error: `More than ${maxNavigations} navigations`,
        chain,
      };
    }
    if (state.download) return { ok: true, chain, statusCode, challenge, refresh, html: null };
    if (settled(state, settleMs)) {
      const html = await untilAborted(page.content(), signal).catch(() => null);
      // A navigation that started while the page was being read starts the wait again.
      if (html !== null && settled(state, settleMs)) {
        keepShown();
        // The browser's own URL keeps the #fragment, which requests never carry.
        const shown = mainFrame.url();
        const last = chain.length - 1;
        if (last > 0 && withoutFragment(chain.at(-1) as string) === withoutFragment(shown)) {
          chain[last] = shown;
        }
        return {
          ok: true,
          chain,
          statusCode,
          challenge,
          refresh,
          html: html.slice(0, MAX_HTML_SIZE),
        };
      }
    }
    await delay(POLL_MS, undefined, { signal });
  }
}

function settled(
  state: { pending: Request | null; ready: boolean; quietSince: number },
  settleMs: number,
): boolean {
  return state.pending === null && state.ready && performance.now() - state.quietSince >= settleMs;
}

function withoutFragment(href: string): string {
  return href.replace(/#.*/s, "");
}

/** "a=1; b=2" for url, as cookies for the browser: host only and for the whole site, as core's jar keeps them. */
function cookieList(header: string, url: URL): { name: string; value: string; url: string }[] {
  return header.split("; ").map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: `${url.origin}/` };
  });
}

/** "host:port" with the default port written out, the way the proxy records problems. */
function hostAndPort(href: string): string {
  const url = new URL(href);
  return `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
}

function aborted(signal: AbortSignal, chain: string[]): BrowserVisit {
  return signal.reason?.name === "TimeoutError"
    ? { ok: false, status: "TIMEOUT", error: "Browser navigation timed out", chain }
    : { ok: false, status: "ERROR", error: "Request was cancelled", chain };
}

/** Playwright's error, first line only (the rest is a long box of advice). */
function describe(error: unknown): string {
  const [message] = String((error as Error).message).split("\n");
  if (/executable doesn't exist/i.test(message as string)) {
    return "Chromium is not installed (in this repository: pnpm install-browser)";
  }
  return `The browser failed (${message})`;
}

/**
 * The promise, or a rejection as soon as `signal` aborts. Only for work that the visit stops by
 * closing its browser context, or that is worth finishing anyway (starting Chromium).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    signal.throwIfAborted(); // an abort that came before: the listener below would never fire
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** At most `size` visits at once. The others wait in line, and leave it when they are aborted. */
class Turns {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async take(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#free > 0) {
      this.#free -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        this.#waiting.splice(this.#waiting.indexOf(start), 1);
        reject(signal.reason);
      };
      this.#waiting.push(start);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /** Passes the turn to the next visit in line, or frees it. */
  give(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}
