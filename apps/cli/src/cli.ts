import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { type ClosableBrowserResolver, createBrowserResolver } from "@urlresolve/browser-resolver";
import {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type ResolveOptions,
  resolveUrl,
} from "@urlresolve/core";

type Result = Awaited<ReturnType<typeof resolveUrl>>;

export const USAGE = `Usage: urlresolve <url> [options]

Finds where a short link really goes.

Options:
  --json               print the whole result as JSON
  --verbose, -v        print every detail, and every step as it happens (on stderr)
  --security           print what the security checks found
  --clean              print the final URL without its tracking parameters
  --interactive, -i    ask for links one after another, in a loop
  --no-browser         never open a browser, even for a page that needs one
  --timeout <seconds>  time limit for the whole link (default ${DEFAULT_TIMEOUT_MS / 1000})
  --max-redirects <n>  most redirects to follow (default ${DEFAULT_MAX_REDIRECTS})
  --help, -h           print this help

Exit code: 0 when the link resolved, 1 when it did not, 2 for a mistake in the command,
130 when it was stopped with Ctrl-C.`;

/** Where the command writes: the report to out, help for mistakes and the step log to err. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** What main.ts and tests pass in. */
export interface Deps {
  /** DNS and address policy. Default: safeLookup. */
  lookup?: ResolveOptions["lookup"];
  /** Makes the browser. Default: createBrowserResolver(). */
  makeBrowser?: () => ClosableBrowserResolver;
  /** Stops the run, as Ctrl-C does: nothing is printed then. */
  signal?: AbortSignal;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// Longest name=value that sets the width of the query parameter list, so that one long value
// cannot pad every other line to its length.
const MAX_PAIR_WIDTH = 40;

/** Runs `urlresolve` with `args` (what follows the command name) and gives its exit code. */
export async function run(args: string[], io: Io, deps: Deps = {}): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    // The message repeats what was typed.
    return mistake(io, visible((error as Error).message));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const [link, ...more] = positionals;
  if (link === undefined || more.length > 0) {
    const dashes = args.includes("--") ? " Everything after -- counts as a link, options too." : "";
    return mistake(io, `Give exactly one link (got ${positionals.length}).${dashes}`);
  }
  // Plain numbers only: Number() would also take "", "0x10" and "1e3".
  const { timeout = String(DEFAULT_TIMEOUT_MS / 1000) } = values;
  const timeoutMs = /^\d+(\.\d+)?$/.test(timeout) ? Math.round(Number(timeout) * 1000) : 0;
  if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return mistake(io, "--timeout takes a number of seconds above 0, such as 10 or 2.5.");
  }
  const { "max-redirects": redirects = String(DEFAULT_MAX_REDIRECTS) } = values;
  if (!/^\d+$/.test(redirects)) {
    return mistake(io, "--max-redirects takes a whole number, 0 or more.");
  }

  const browser = values["no-browser"] ? undefined : (deps.makeBrowser ?? createBrowserResolver)();
  try {
    const result = await resolveUrl(link, {
      timeoutMs,
      maxRedirects: Number(redirects),
      browser,
      lookup: deps.lookup,
      signal: deps.signal,
      log: values.verbose
        ? ({ tag, message }) => io.err(visible(`[${tag}] ${message}`))
        : undefined,
    });
    // Stopped by hand: what the run ended with says nothing about the link.
    if (deps.signal?.aborted) return 130;
    io.out(values.json ? json(result) : report(result, values));
    return result.status === "RESOLVED" ? 0 : 1;
  } finally {
    await browser?.close();
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      security: { type: "boolean" },
      clean: { type: "boolean" },
      "no-browser": { type: "boolean" },
      timeout: { type: "string" },
      "max-redirects": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function mistake(io: Io, message: string): number {
  io.err(`${message}\n\n${USAGE}`);
  return 2;
}

/**
 * The result as JSON, with every character a terminal could act on written as an escape, such as
 * U+202E, which reverses the text after it. JSON.stringify escapes the first 32 control
 * characters already; the line breaks left are its own layout.
 */
export function json(result: Result): string {
  return JSON.stringify(result, null, 2).replace(/[\p{Cc}\p{Cf}]/gu, (found) =>
    found === "\n"
      ? found
      : // One escape per UTF-16 unit, as JSON wants for a character beyond U+FFFF.
        found
          .split("")
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
  );
}

/**
 * Text from a link, made safe for a terminal: control and invisible formatting characters are
 * shown as \u{...}. A decoded query parameter can hold any of them.
 */
export function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (found) => `\\u{${found.codePointAt(0)?.toString(16)}}`);
}

/** The result for a person to read. --verbose shows everything --security and --clean add. */
export function report(
  result: Result,
  { verbose = false, security = false, clean = false } = {},
): string {
  const lines: string[] = [];
  const row = (label: string, value: string, indent = "") =>
    lines.push(visible(`${indent}${`${label}:`.padEnd(indent ? 20 : 12)}${value}`));

  row("Original", result.originalUrl);
  if (result.status === "RESOLVED") {
    row("Final", result.finalUrl);
    if (clean || verbose) row("Clean", result.tracking.cleanUrl);
  }
  row("Status", result.status);
  if (result.status !== "RESOLVED") row("Reason", result.error);
  row("Method", result.method ?? "none");
  row("Redirects", String(result.redirectCount));
  row("Time", `${(result.timing.elapsedMs / 1000).toFixed(2)}s`);
  const tracking = result.tracking?.parameters.filter(({ kind }) => kind === "tracking") ?? [];
  if (tracking.length > 0) {
    const count =
      tracking.length === 1 ? "1 tracking parameter" : `${tracking.length} tracking parameters`;
    row("Tracking", `${count} (${tracking.map(({ name }) => name).join(", ")})`);
  }
  if (result.chain.length > 0) {
    lines.push("", "Redirect chain:", ...result.chain.map((href, i) => `  ${i + 1}. ${href}`));
  }

  if (verbose && result.status === "RESOLVED") {
    const from = new URL(result.originalUrl);
    const to = new URL(result.finalUrl);
    const defaultPort = to.protocol === "https:" ? "443" : "80";
    lines.push("", "Final URL:");
    row("Original domain", from.hostname, "  ");
    row("Final domain", to.hostname, "  ");
    row("Domain changed", from.hostname === to.hostname ? "no" : "yes", "  ");
    row("Protocol", to.protocol.slice(0, -1), "  ");
    row("Port", to.port || `${defaultPort} (default)`, "  ");
    row("Path", to.pathname, "  ");
    row("Query", to.search || "(none)", "  ");
    row("Fragment", to.hash || "(none)", "  ");
    row("HTTP status", String(result.httpStatus), "  ");
    const pairs = result.tracking.parameters.map(({ name, value, kind }) => ({
      pair: `${name}=${value}`,
      kind,
    }));
    if (pairs.length > 0) {
      const width = Math.min(MAX_PAIR_WIDTH, Math.max(...pairs.map(({ pair }) => pair.length)));
      lines.push("", "Query parameters:");
      for (const { pair, kind } of pairs) lines.push(visible(`  ${pair.padEnd(width)}  ${kind}`));
    }
  }
  // A link that could not be read was never checked.
  if ((security || verbose) && result.status !== "INVALID_URL") {
    lines.push("", "Security:");
    if (result.status === "RESOLVED") {
      row("HTTPS", result.finalUrl.startsWith("https:") ? "yes" : "no", "  ");
      row("Public destination", "yes, every address on the way passed the check", "  ");
    } else if (result.status === "BLOCKED") {
      row("Blocked", result.error, "  ");
    }
    row("User info removed", result.security.credentialsRemoved ? "yes" : "no", "  ");
  }
  return lines.join("\n");
}

/** What `interactive` needs: the same lookup and browser-maker as run(), and a stop signal. */
export interface InteractiveDeps {
  lookup?: ResolveOptions["lookup"];
  makeBrowser?: () => ClosableBrowserResolver;
  signal?: AbortSignal;
  /** Never open a browser, for places where Chromium is not installed. Default false. */
  noBrowser?: boolean;
}

/**
 * Asks for one link after another and prints where each one goes, until an empty line (or Ctrl-C).
 * `input` and `output` are the streams to read from and write to (the terminal, or test streams).
 * One browser is made for the whole session and closed at the end.
 */
export async function interactive(
  input: Readable,
  output: Writable,
  deps: InteractiveDeps = {},
): Promise<void> {
  const write = (text: string) => output.write(`${text}\n`);
  const browser = deps.noBrowser ? undefined : (deps.makeBrowser ?? createBrowserResolver)();
  const rl = createInterface({ input });
  // Ctrl-C (which aborts the signal) ends the loop; so does the input running out.
  deps.signal?.addEventListener("abort", () => rl.close());
  write("Universal URL Resolver");
  write("Paste a short link and press Enter. Press Enter on an empty line to quit.");
  output.write("\nLink> ");
  try {
    for await (const typed of rl) {
      const line = typed.trim();
      if (line === "") break;
      const result = await resolveUrl(line, { browser, lookup: deps.lookup, signal: deps.signal });
      write(report(result, { security: true }));
      output.write("\nLink> ");
    }
  } finally {
    rl.close();
    await browser?.close();
  }
}
