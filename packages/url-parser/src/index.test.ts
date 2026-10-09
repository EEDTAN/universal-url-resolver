import { describe, expect, it } from "vitest";
import {
  isHttpUrl,
  MAX_URL_LENGTH,
  type ParseResult,
  parseInputUrl,
  resolveLocation,
} from "./index.ts";

const TOO_LONG = `URL is longer than ${MAX_URL_LENGTH} characters`;

/** The href of a successful result. Throws (and so fails the test) with the error otherwise. */
function href(result: ParseResult): string {
  if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.error}`);
  return result.url.href;
}

describe("parseInputUrl", () => {
  it.each([
    ["bit.ly/abc", "https://bit.ly/abc"],
    ["  bit.ly/abc \n", "https://bit.ly/abc"],
    ["//bit.ly/x", "https://bit.ly/x"],
    ["bit.ly", "https://bit.ly/"],
    ["HTTP://Bit.ly:80/X", "http://bit.ly/X"],
    ["http:example.com/x", "http://example.com/x"],
    ["http:/example.com/x", "http://example.com/x"],
    ["https://example.com:443/", "https://example.com/"],
    ["bücher.example", "https://xn--bcher-kva.example/"],
    ["bit.ly/x#frag", "https://bit.ly/x#frag"],
    ["localhost.", "https://localhost./"],
    // Control characters at the ends are ignored, like the URL parser does; trim() takes Unicode spaces.
    ["\u0001https://bit.ly/x\u0002", "https://bit.ly/x"],
    [" bit.ly/x ", "https://bit.ly/x"],
  ])("normalizes %j to %s", (input, expected) => {
    expect(href(parseInputUrl(input))).toBe(expected);
  });

  it.each([
    ["example.com:8080/x", "https://example.com:8080/x"],
    ["example.com:8080", "https://example.com:8080/"],
    ["localhost:8080", "https://localhost:8080/"],
    ["LOCALHOST:8080/x", "https://localhost:8080/x"],
    ["127.0.0.1:3000/x", "https://127.0.0.1:3000/x"],
    ["[::1]:80/x", "https://[::1]:80/x"],
    ["bit.ly:443/x", "https://bit.ly/x"],
  ])("reads %j as host:port, not as a scheme", (input, expected) => {
    expect(href(parseInputUrl(input))).toBe(expected);
  });

  // Phase 2's address policy checks exactly these hostnames, so the tricks must already be undone here.
  it.each([
    ["http://0x7f.1/", "127.0.0.1"],
    ["http://2130706433/", "127.0.0.1"],
    ["http://017700000001/", "127.0.0.1"],
    ["http://127.1/", "127.0.0.1"],
    ["http://0x7f.0x0.0x0.0x1/", "127.0.0.1"],
    ["http://①②⑦.0.0.1/", "127.0.0.1"],
    ["http://１２７.０.０.１/", "127.0.0.1"],
    ["http://127。0。0。1/", "127.0.0.1"],
    ["http://ｌｏｃａｌｈｏｓｔ/", "localhost"],
    ["http://loc­alhost/", "localhost"],
    ["http://%6c%6f%63%61%6c%68%6f%73%74/", "localhost"],
    ["http://LOCALHOST。/", "localhost."],
    ["http://localhost%2e/", "localhost."],
    ["http://0/", "0.0.0.0"],
    ["http://[::]/", "[::]"],
    ["http://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]"],
    ["http://[::127.0.0.1]/", "[::7f00:1]"],
    ["http://[::ffff:169.254.169.254]/", "[::ffff:a9fe:a9fe]"],
    ["http://[::ffff:0:7f00:1]/", "[::ffff:0:7f00:1]"],
    ["http://[2002:a9fe:a9fe::1]/", "[2002:a9fe:a9fe::1]"],
    ["http://[64:ff9b::a9fe:a9fe]/", "[64:ff9b::a9fe:a9fe]"],
  ])("canonicalizes the host of %j to %s", (input, host) => {
    const result = parseInputUrl(input);
    expect(result.ok && result.url.hostname).toBe(host);
  });

  it.each([
    ["javascript:alert(1)", "javascript:"],
    [" JavaScript:alert(1)", "javascript:"],
    ["javascript:1", "javascript:"],
    ["java\tscript:1", "javascript:"],
    ["data:text/html,hello", "data:"],
    ["file:///etc/passwd", "file:"],
    ["ftp://example.com/file", "ftp:"],
    ["gopher://example.com/", "gopher:"],
    ["ws://example.com/", "ws:"],
    ["mailto:someone@example.com", "mailto:"],
    ["tel:+6281234", "tel:"],
  ])("rejects %j and names the scheme", (input, scheme) => {
    expect(parseInputUrl(input)).toMatchObject({
      ok: false,
      status: "INVALID_URL",
      error: `Only http and https links can be resolved (got "${scheme}")`,
    });
  });

  it.each([
    ["", "URL is empty"],
    ["   ", "URL is empty"],
    // A special scheme with no host does not parse at all.
    ["ftp:", "Not a valid URL"],
    ["https://", "Not a valid URL"],
    ["http://", "Not a valid URL"],
    ["http://exa mple.com/", "Not a valid URL"],
    ["http://[::1", "Not a valid URL"],
    ["http://256.0.0.1/", "Not a valid URL"],
    ["http://1.2.3.4.5/", "Not a valid URL"],
    ["http://0x100000000/", "Not a valid URL"],
    ["http://[fe80::1%25eth0]/", "Not a valid URL"],
  ])("rejects %j: %s", (input, error) => {
    expect(parseInputUrl(input)).toMatchObject({
      ok: false,
      status: "INVALID_URL",
      error,
    });
  });

  it("rejects input longer than MAX_URL_LENGTH", () => {
    const input = `https://x.test/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(parseInputUrl(input)).toMatchObject({
      ok: false,
      status: "INVALID_URL",
      error: TOO_LONG,
    });
  });

  it("rejects input that only becomes too long after percent-encoding", () => {
    const input = `https://x.test/${"é".repeat(2000)}`;
    expect(input.length).toBeLessThan(MAX_URL_LENGTH);
    expect(parseInputUrl(input)).toMatchObject({
      ok: false,
      status: "INVALID_URL",
      error: TOO_LONG,
    });
  });

  // Guards against a slow (quadratic) host:port regex: 20 calls take about 1 ms with the current
  // one and close to a second with the old one. Repeating the call keeps a CI hiccup from failing it.
  it.each([`a${".".repeat(8188)}a:x`, `${"a.".repeat(4094)}a:x`])(
    "handles an 8 KB scheme-like input quickly (case %#)",
    (input) => {
      const started = performance.now();
      for (let i = 0; i < 20; i += 1) parseInputUrl(input);
      expect(performance.now() - started).toBeLessThan(200);
      expect(parseInputUrl(input)).toMatchObject({ ok: false, status: "INVALID_URL" });
    },
  );

  it("removes user:password and flags it", () => {
    const result = parseInputUrl("https://user:secret@bit.ly/x");
    expect(result).toMatchObject({ ok: true, credentialsRemoved: true });
    expect(href(result)).toBe("https://bit.ly/x");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reveals the real host behind a phishing-style @", () => {
    const result = parseInputUrl("https://paypal.com@evil.example/");
    expect(result).toMatchObject({ ok: true, credentialsRemoved: true });
    expect(result.ok && result.url.hostname).toBe("evil.example");
  });

  it("does not flag a plain URL", () => {
    expect(parseInputUrl("https://bit.ly/x")).toMatchObject({
      ok: true,
      credentialsRemoved: false,
    });
  });

  // Every password below contains "s3cr", so a single check covers all of them.
  it.each([
    ["ftp://admin:s3cret@files.example/", "ftp://files.example/"],
    ["http://admin:s3cret@exa mple.com/", "http://exa mple.com/"],
    ["javascript://u:s3cret@x/", "javascript://x/"],
    ["http:\\\\admin:s3cret@exa mple.com", "http:\\\\exa mple.com"],
    ["admin:s3cret@example.com", "admin:example.com"],
    // Outside http(s) a backslash belongs to the password, so the parser's reading is used.
    ["smb://CORP\\alice:s3cret@fileserver/share", "smb://fileserver/share"],
    ["sftp://deploy:s3cr\\et@build.example/", "sftp://build.example/"],
    ["\u0000ftp://admin:s3cret@files.example/", "ftp://files.example/"],
    ["ht\ttp://admin:s3cret@exa mple.com/", "http://exa mple.com/"],
    // A password with / ? # or \ in it stops the URL parser, so only the text is left to clean.
    [
      "https://AKIAEXAMPLE:s3cr/K7MDENG/bPxRfi@bucket.example.com/key",
      "https://bucket.example.com/key",
    ],
    ["https://bob:s3cr?t@files.example.com/", "https://files.example.com/"],
    ["https://bob:s3cr#t@files.example.com/", "https://files.example.com/"],
    ["https://bob:s3cr\\t@files.example.com/", "https://files.example.com/"],
    // Schemes whose path holds a whole URL: the parser sees no username there at all.
    ["blob:https://admin:s3cret@files.example.com/x", "blob:files.example.com/x"],
    ["view-source:https://admin:s3cret@files.example.com/", "view-source:files.example.com/"],
  ])("never echoes the password of the rejected input %j", (input, safeInput) => {
    const result = parseInputUrl(input);
    expect(result).toMatchObject({ ok: false, safeInput });
    expect(JSON.stringify(result)).not.toContain("s3cr");
  });

  it("removes the password before shortening a long rejected input", () => {
    const result = parseInputUrl(`https://admin:${"p".repeat(9000)}@host.test/`);
    expect(result).toMatchObject({
      ok: false,
      error: TOO_LONG,
      safeInput: "https://host.test/",
    });
  });

  it.each([
    ["ftp://admin:s3cret@files.example/", true],
    ["javascript://u:s3cret@x/", true],
    [`https://u:s3cret@x.test/${"é".repeat(2000)}`, true],
    // The parser never reads these, so it cannot tell.
    ["http://admin:s3cret@exa mple.com/", false],
    [`https://admin:${"p".repeat(9000)}@host.test/`, false],
    // An opaque path has no username, whatever its "@" looks like.
    ["mailto:someone@example.com", false],
    ["javascript:alert(1)", false],
  ])("reports credentialsRemoved for the rejected input %j", (input, credentialsRemoved) => {
    expect(parseInputUrl(input)).toMatchObject({ ok: false, credentialsRemoved });
  });

  it("keeps safeInput within MAX_URL_LENGTH", () => {
    const result = parseInputUrl(`https://admin:hunter2@${"a".repeat(20_000)}`);
    if (result.ok) throw new Error("expected a failure");
    expect(result.safeInput.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(result.safeInput).not.toContain("hunter2");
  });
});

describe("resolveLocation", () => {
  const base = new URL("https://short.test/a/b?x=1");

  it.each([
    ["https://dest.test/page", "https://dest.test/page"],
    ["/go/abc", "https://short.test/go/abc"],
    ["//other.test/page", "https://other.test/page"],
    ["?q=2", "https://short.test/a/b?q=2"],
    ["#frag", "https://short.test/a/b?x=1#frag"],
    ["go/abc", "https://short.test/a/go/abc"],
    // Like a browser, a Location without a scheme is a path, not a host.
    ["example.com/x", "https://short.test/a/example.com/x"],
    ["HTTPS://Dest.Test", "https://dest.test/"],
    ["/\\evil.test", "https://evil.test/"],
    ["http:dest.test/x", "http://dest.test/x"],
    ["", "https://short.test/a/b?x=1"],
    ["  /spaced  ", "https://short.test/spaced"],
    ["/café", "https://short.test/caf%C3%A9"],
  ])("resolves %j to %s", (location, expected) => {
    expect(href(resolveLocation(location, base))).toBe(expected);
  });

  it("keeps http for a protocol-relative target on an http page", () => {
    const result = resolveLocation("//other.test/p", new URL("http://short.test/a"));
    expect(href(result)).toBe("http://other.test/p");
  });

  it.each([
    ["/b", "https://short.test/b#top"],
    ["/b#own", "https://short.test/b#own"],
    ["/b#", "https://short.test/b#"],
  ])("handles the fragment of %j like a browser", (location, expected) => {
    const result = resolveLocation(location, new URL("https://short.test/a#top"));
    expect(href(result)).toBe(expected);
  });

  it.each([
    ["javascript:alert(1)", "javascript:"],
    ["data:text/html,x", "data:"],
    ["file:///etc/passwd", "file:"],
    ["ftp://files.test/x", "ftp:"],
    ["tg://resolve?domain=x", "tg:"],
    ["mailto:a@b.test", "mailto:"],
  ])("blocks a redirect to %j", (location, scheme) => {
    expect(resolveLocation(location, base)).toMatchObject({
      ok: false,
      status: "BLOCKED",
      error: `Redirect to a "${scheme}" URL was not followed (only http and https)`,
    });
  });

  it.each([
    ["http://[", "Redirect target is not a valid URL"],
    ["https://", "Redirect target is not a valid URL"],
    ["ftp:", "Redirect target is not a valid URL"],
    [`/${"a".repeat(MAX_URL_LENGTH)}`, TOO_LONG],
    [`/${"é".repeat(2000)}`, TOO_LONG],
  ])("reports a broken Location as ERROR (case %#)", (location, error) => {
    expect(resolveLocation(location, base)).toMatchObject({
      ok: false,
      status: "ERROR",
      error,
    });
  });

  it("removes credentials from a Location", () => {
    const result = resolveLocation("https://u:p@dest.test/", base);
    expect(result).toMatchObject({ ok: true, credentialsRemoved: true });
    expect(href(result)).toBe("https://dest.test/");
  });

  it.each([
    ["ftp://user:s3cret@files.test/x", true],
    [`https://u:s3cret@dest.test/${"é".repeat(2000)}`, true],
    ["ftp://files.test/x", false],
    ["http://[", false],
  ])("reports credentialsRemoved for the rejected Location %j", (location, credentialsRemoved) => {
    expect(resolveLocation(location, base)).toMatchObject({ ok: false, credentialsRemoved });
  });

  // A tab inside a header value is legal, and the URL parser drops it; so must the redaction.
  it.each([
    ["ft\tp://user:s3cret@files.test/", "BLOCKED", "ftp://files.test/"],
    [" \u0000ftp://user:s3cret@files.test/", "BLOCKED", "ftp://files.test/"],
    ["tg://bot:s3cr\\et@resolve/", "BLOCKED", "tg://resolve/"],
    ["blob:https://user:s3cret@files.test/", "BLOCKED", "blob:files.test/"],
    ["ht\ttp://user:s3cret@exa mple.test/", "ERROR", "http://exa mple.test/"],
  ])("never echoes the password of the rejected Location %j", (location, status, safeInput) => {
    const result = resolveLocation(location, base);
    expect(result).toMatchObject({ ok: false, status, safeInput });
    expect(JSON.stringify(result)).not.toContain("s3cr");
  });
});

describe("isHttpUrl", () => {
  it.each([
    ["http://a.test/", true],
    ["https://a.test/", true],
    ["ftp://a.test/", false],
    ["javascript:alert(1)", false],
  ])("%s -> %s", (input, expected) => {
    expect(isHttpUrl(new URL(input))).toBe(expected);
  });
});
