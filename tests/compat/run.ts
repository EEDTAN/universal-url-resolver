/**
 * The compatibility check: resolves every link in links.json against the live services, once
 * without and once with a browser, and writes what happened to docs/compatibility.md.
 *
 * It is not part of `pnpm test` or `pnpm verify`: it needs the internet, and a service can change
 * its pages at any time. Run it with `pnpm test:compat`. It ends with exit code 1 when a link,
 * resolved with the browser, does not end as its "expected" says.
 *
 * links.json holds { service, url, expected?, note? }. `expected` is the final URL, or a status
 * such as "UNRESOLVED" for a link that must not resolve. `note` is written by hand and printed as
 * such: the run checks nothing it says.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createBrowserResolver } from "@urlresolve/browser-resolver";
import { resolveUrl } from "@urlresolve/core";

type Result = Awaited<ReturnType<typeof resolveUrl>>;

interface Link {
  service: string;
  url: string;
  expected?: string;
  note?: string;
}

const TIMEOUT_MS = 20_000;

const links: Link[] = JSON.parse(await readFile(new URL("links.json", import.meta.url), "utf8"));
const testedAt = new Date();
const rows: { link: Link; plain: Result; full: Result }[] = [];
// Stopped by hand: end at once. Playwright would close the browser first, and the visit cut short
// by that would be written down as a result.
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
const browser = createBrowserResolver();
try {
  for (const link of links) {
    const plain = await resolveUrl(link.url, { timeoutMs: TIMEOUT_MS });
    const full = await resolveUrl(link.url, { timeoutMs: TIMEOUT_MS, browser });
    rows.push({ link, plain, full });
    console.log(`${link.service}: ${outcome(plain)} | with a browser: ${outcome(full)}`);
  }
} finally {
  await browser.close();
}

const failed = rows.filter(({ link, full }) => link.expected && !meets(full, link.expected));
await writeFile(new URL("../../docs/compatibility.md", import.meta.url), report());
for (const { link, full } of failed) {
  console.log(`NOT AS EXPECTED: ${link.service} ended ${outcome(full)}, expected ${link.expected}`);
}
process.exitCode = failed.length > 0 ? 1 : 0;

/** "RESOLVED (http)", "UNRESOLVED (http): Human verification required", "TIMEOUT: ...". */
function outcome(result: Result): string {
  const method = result.method === null ? "" : ` (${result.method})`;
  return result.status === "RESOLVED"
    ? `RESOLVED${method}`
    : `${result.status}${method}: ${result.error}`;
}

/** Whether the result is what `expected` says: that final URL, or that status. */
function meets(result: Result, expected: string): boolean {
  return /^https?:/.test(expected) ? result.finalUrl === expected : result.status === expected;
}

function report(): string {
  const when = `${testedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const table = rows.map(({ link, plain, full }) => {
    const { expected } = link;
    const judge = (result: Result) => (expected && meets(result, expected) ? "yes" : "no");
    const asExpected = expected ? `${judge(plain)} / ${judge(full)}` : "-";
    return `| ${cell(link.service)} | ${cell(outcome(plain))} | ${cell(outcome(full))} | ${asExpected} |`;
  });
  // A backtick would end the code span early, so it is shown escaped.
  const code = (text: string) =>
    /^https?:/.test(text) ? `at \`${text.replaceAll("`", "%60")}\`` : text;
  const details = rows.map(({ link, plain, full }) => {
    const ended = code(full.finalUrl ?? full.status);
    const plainEnded = code(plain.finalUrl ?? plain.status);
    const without = plainEnded === ended ? "" : ` (without a browser: ${plainEnded})`;
    const expected = link.expected ? `, expected ${code(link.expected)}` : "";
    const note = link.note ? ` Note from links.json, not checked by this run: ${link.note}` : "";
    return `- **${link.service}**: \`${link.url}\` ended ${ended}${without}${expected}.${note}`;
  });
  return [
    "# Compatibility",
    "",
    "Designed to resolve a broad range of short-link and redirect mechanisms. This page lists only",
    "links that were really tried, and what happened to them.",
    "",
    `Written by \`pnpm test:compat\` on ${when}, against the live services from one network. A`,
    "service can change its pages at any time, and a DNS block or a firewall can change what one",
    "network sees, so a result says nothing about later days or other networks. The links come",
    'from `tests/compat/links.json`. "With browser" means a browser was there for the pages that',
    "need one; the method in brackets says whether it was used.",
    "",
    "| Service | Without browser | With browser | As expected (without / with browser) |",
    "| --- | --- | --- | --- |",
    ...table,
    "",
    "## Links",
    "",
    ...details,
    "",
  ].join("\n");
}
