import { describe, expect, it } from "vitest";
import { findHtmlTarget, MAX_REFRESH_DELAY_SECONDS, refreshTarget } from "./index.ts";

const page = new URL("https://short.test/a?x=1");

describe("refreshTarget", () => {
  it.each([
    ["0; url=https://dest.test/", "https://dest.test/"],
    ["0;URL=https://dest.test/", "https://dest.test/"],
    ["0; URL='https://dest.test/x'", "https://dest.test/x"],
    ['0; url="https://dest.test/x"', "https://dest.test/x"],
    ["5, https://dest.test/", "https://dest.test/"],
    ["0.5; url=/next", "https://short.test/next"],
    [".5; url=/next", "https://short.test/next"],
    ["  3  ;  url = /y  ", "https://short.test/y"],
    ["0; url=next", "https://short.test/next"],
    ["0\turl=/tab", "https://short.test/tab"],
    ["0; 'https://dest.test/q'", "https://dest.test/q"],
    ["0; url='https://dest.test/a'ignored", "https://dest.test/a"],
    ["0; url='https://dest.test/unclosed", "https://dest.test/unclosed"],
    // Starts with "u" but is not "url=": the standard takes the text as it is.
    ["0; uxyz", "https://short.test/uxyz"],
    ["0; url /spaced", "https://short.test/url%20/spaced"],
    [`${MAX_REFRESH_DELAY_SECONDS}; url=/late`, "https://short.test/late"],
    // Not followed here, but reported, so the caller can refuse it.
    ["0; url=javascript:alert(1)", "javascript:alert(1)"],
  ])("follows %j to %s", (content, expected) => {
    expect(refreshTarget(content, page)).toBe(expected);
  });

  it.each([
    ["0", "no URL: a reload"],
    ["0;", "no URL: a reload"],
    ["0; url=", "an empty URL is the page itself"],
    ["0; url=https://short.test/a?x=1", "the same page"],
    ["0; url=#section", "the same page with a fragment"],
    [`${MAX_REFRESH_DELAY_SECONDS + 1}; url=/late`, "too long a delay"],
    [`${"9".repeat(400)}; url=/x`, "a delay too large to count"],
    ["url=/x", "no delay"],
    ["abc", "no delay"],
    ["0x; url=/x", "junk after the delay"],
    ["0; url=http://[", "a URL that does not parse"],
    ["", "an empty value"],
  ])("ignores %j (%s)", (content) => {
    expect(refreshTarget(content, page)).toBeNull();
  });

  it("resolves a relative URL against the base it is given", () => {
    expect(refreshTarget("0; url=next", page, new URL("https://cdn.test/dir/"))).toBe(
      "https://cdn.test/dir/next",
    );
  });
});

describe("findHtmlTarget: meta refresh", () => {
  const refresh = (content: string) => `<meta http-equiv="refresh" content="${content}">`;

  it.each([
    ["in <head>", `<html><head>${refresh("0;url=/next")}</head></html>`],
    ["in <body>", `<body><p>Moved.</p>${refresh("2; url=/next")}</body>`],
    ["written in capitals", '<META HTTP-EQUIV="Refresh" CONTENT="0; URL=/next">'],
    ["after a <template>", `<template><p>x</p></template>${refresh("0;url=/next")}`],
    ["inside 500 nested elements", `${"<div>".repeat(500)}${refresh("0;url=/next")}`],
  ])("follows a meta refresh %s", (_where, html) => {
    expect(findHtmlTarget(html, page)).toEqual({
      kind: "redirect",
      url: "https://short.test/next",
      method: "meta-refresh",
    });
  });

  it.each([
    ["in a script", `<script>var tag = '${refresh("0;url=/next")}';</script>`],
    ["in a comment", `<!-- ${refresh("0;url=/next")} -->`],
    ["in a <template>", `<template>${refresh("0;url=/next")}</template>`],
    ["in a <textarea>", `<textarea>${refresh("0;url=/next")}</textarea>`],
    ["of another kind", '<meta name="refresh" content="0;url=/next">'],
    // On the same site, a <noscript> refresh leads to a "please turn on JavaScript" page.
    ["in <noscript> to the same site", `<noscript>${refresh("0;url=/enable-js")}</noscript>`],
    // Past 512 open elements the rest of the page is not read (see MAX_DEPTH).
    ["inside 600 nested elements", `${"<div>".repeat(600)}${refresh("0;url=/next")}`],
  ])("ignores a meta refresh %s", (_where, html) => {
    expect(findHtmlTarget(html, page)).toEqual({ kind: "none" });
  });

  // What a browser without JavaScript sees, and t.co sends exactly this.
  it("follows a meta refresh in <noscript> that leaves the site", () => {
    const html = `<noscript>${refresh("0;URL=https://dest.test/x")}</noscript><script>location="/js"</script>`;
    expect(findHtmlTarget(html, page)).toEqual({
      kind: "redirect",
      url: "https://dest.test/x",
      method: "meta-refresh",
    });
  });

  it("uses the first refresh it can read, like a browser", () => {
    expect(findHtmlTarget(refresh("nonsense") + refresh("0;url=/second"), page)).toMatchObject({
      url: "https://short.test/second",
    });
    const empty = '<meta http-equiv="refresh">';
    expect(findHtmlTarget(empty + refresh("0;url=/second"), page)).toMatchObject({
      url: "https://short.test/second",
    });
    // A URL that does not parse makes the whole refresh unreadable, so the next one counts.
    expect(
      findHtmlTarget(refresh("0;url=http://[") + refresh("0;url=/second"), page),
    ).toMatchObject({ url: "https://short.test/second" });
    expect(findHtmlTarget(refresh("0;url=/first") + refresh("0;url=/second"), page)).toMatchObject({
      url: "https://short.test/first",
    });
    // A slow first refresh wins too, so the fast one after it is never used.
    expect(findHtmlTarget(refresh("600;url=/logout") + refresh("0;url=/x"), page)).toEqual({
      kind: "none",
    });
  });

  it("decodes entities in the URL", () => {
    expect(findHtmlTarget(refresh("0;url=/a?x=1&amp;y=2"), page)).toMatchObject({
      url: "https://short.test/a?x=1&y=2",
    });
  });

  it("resolves the URL against <base href> when it comes first", () => {
    const html = `<base href="https://cdn.test/dir/">${refresh("0;url=next")}`;
    expect(findHtmlTarget(html, page)).toMatchObject({ url: "https://cdn.test/dir/next" });
    const later = `${refresh("0;url=next")}<base href="https://cdn.test/dir/">`;
    expect(findHtmlTarget(later, page)).toMatchObject({ url: "https://short.test/next" });
  });

  it.each(["javascript:alert(1)", "http://[", "data:text/html,x"])(
    "ignores the unusable <base href=%j>",
    (href) => {
      const html = `<base href="${href}">${refresh("0;url=next")}`;
      expect(findHtmlTarget(html, page)).toMatchObject({ url: "https://short.test/next" });
    },
  );

  it("only uses the first <base href>", () => {
    const html = `<base href="https://one.test/"><base href="https://two.test/">${refresh("0;url=x")}`;
    expect(findHtmlTarget(html, page)).toMatchObject({ url: "https://one.test/x" });
  });
});

describe("findHtmlTarget: human verification", () => {
  it.each([
    ['<div class="cf-turnstile" data-sitekey="k"></div>', "Cloudflare Turnstile"],
    ['<div class="g-recaptcha" data-sitekey="k"></div>', "reCAPTCHA"],
    ['<div class="form h-captcha big" data-sitekey="k"></div>', "hCaptcha among other classes"],
    ['<div class="G-RECAPTCHA"></div>', "a class in capitals"],
    ['<img src="/captcha.png"><input type="text" name="captcha_code">', "a home-made CAPTCHA"],
    ['<input id="CaptchaInput">', "a CAPTCHA field found by its id"],
  ])("finds %s (%s)", (html) => {
    expect(findHtmlTarget(html, page)).toEqual({ kind: "human-check" });
  });

  it.each([
    ['<script src="https://www.google.com/recaptcha/api.js?render=k"></script>', "only the script"],
    ['<div class="g-recaptcha" data-size="invisible"></div>', "an invisible widget"],
    ['<input type="hidden" name="captcha_token">', "a hidden field"],
    ['<p class="no-captcha-here">text</p>', "a class that merely contains the word"],
    ['<div class="g-recaptcha-response"></div>', "a class that only starts with a widget's name"],
    ['<div id="recaptcha-container"></div>', "an element that is not a text box"],
  ])("does not count %s (%s)", (html) => {
    expect(findHtmlTarget(html, page)).toEqual({ kind: "none" });
  });

  it("still follows a meta refresh on a page with a CAPTCHA, as a browser would", () => {
    const html = '<meta http-equiv="refresh" content="0;url=/next"><div class="g-recaptcha"></div>';
    expect(findHtmlTarget(html, page)).toMatchObject({ kind: "redirect" });
  });

  it("only looks for the person check on an error page", () => {
    const refresh = '<meta http-equiv="refresh" content="0;url=/next">';
    const options = { onlyHumanCheck: true };
    expect(findHtmlTarget(refresh, page, options)).toEqual({ kind: "none" });
    const html = `${refresh}<div class="g-recaptcha"></div>`;
    expect(findHtmlTarget(html, page, options)).toEqual({ kind: "human-check" });
  });

  const signIn = '<form method="post"><input name="user"><input type="PASSWORD" name="pw"></form>';

  it.each([
    "https://site.example/login?next=/private/doc",
    "https://accounts.example/signin?continue=https://app.example/inbox",
  ])("treats a sign-in form at %s as a login wall", (address) => {
    expect(findHtmlTarget(signIn, new URL(address))).toEqual({ kind: "human-check" });
  });

  it.each(["https://site.example/", "https://site.example/forum?lang=en&page=2"])(
    "takes a page with a sign-in box at %s for an ordinary page",
    (address) => {
      expect(findHtmlTarget(signIn, new URL(address))).toEqual({ kind: "none" });
    },
  );
});

describe("findHtmlTarget: frames", () => {
  it("follows a frameset that shows a single page", () => {
    const html =
      '<frameset rows="100%,*"><frame src="https://dest.test/"><frame src="about:blank"></frameset>';
    expect(findHtmlTarget(html, page)).toEqual({
      kind: "redirect",
      url: "https://dest.test/",
      method: "html",
    });
  });

  it.each([
    ['<frameset><frame src="/left"><frame src="/right"></frameset>', "two frames"],
    ['<frame src="https://dest.test/">', "a frame outside a frameset"],
    ['<frameset><frame src="/a?x=1"></frameset>', "a frame of the page itself"],
    ['<frameset><frame src="http://["></frameset>', "a frame URL that does not parse"],
    ['<iframe src="https://dest.test/"></iframe>', "an ordinary iframe"],
  ])("does not follow %s (%s)", (html) => {
    expect(findHtmlTarget(html, page)).toEqual({ kind: "none" });
  });
});

describe('findHtmlTarget: "you are leaving this site" pages', () => {
  const leaving = new URL("https://l.example/l.php?u=https%3A%2F%2Fdest.example%2Fpage%3Fid%3D7");
  const destination = "https://dest.example/page?id=7";

  it.each([
    // The link text shows the URL too: a link wins over "waits for a click".
    [`<a href="${destination}">${destination}</a>`, "a link"],
    [`<a href="https://dest.example/page?id=7#top">Continue</a>`, "a link with a fragment"],
    [`<form action="${destination}"><button>Go</button></form>`, "a form"],
    [`<button data-target-url="${destination}">Go</button>`, "a data attribute"],
    [`<link rel="canonical" href="${destination}">`, "the canonical URL"],
    [`<iframe src="${destination}"></iframe>`, "an iframe"],
    [`<frame src="${destination}">`, "a frame"],
    [`<map><area href="${destination}"></map>`, "an image map area"],
  ])("follows the named URL when the page confirms it with %s", (html) => {
    expect(findHtmlTarget(html, leaving)).toEqual({
      kind: "redirect",
      url: destination,
      method: "html",
    });
  });

  it("finds the URL in a parameter name too (outgoing?https://...)", () => {
    const outgoing = new URL("https://site.example/outgoing?https://dest.example/");
    expect(findHtmlTarget('<a href="https://dest.example/">Go</a>', outgoing)).toMatchObject({
      url: "https://dest.example/",
    });
  });

  it.each([
    ['<a href="https://other.example/">Something else</a>', "the page links elsewhere"],
    ['<a href="https://dest.example/page">Close but not equal</a>', "the link differs"],
    [`<link rel="stylesheet" href="${destination}">`, "only a stylesheet link"],
    [`<link href="${destination}">`, "only a link without rel"],
    [`<img src="${destination}">`, "only an image"],
    ['<a href="http://[">broken</a>', "the only link does not parse"],
  ])("does not follow the named URL when %s", (html) => {
    expect(findHtmlTarget(html, leaving)).toEqual({ kind: "none" });
  });

  it("ignores a parameter that names the same site (?next=, after a login)", () => {
    const login = new URL("https://site.example/login?next=https://site.example/account");
    expect(findHtmlTarget('<a href="https://site.example/account">x</a>', login)).toEqual({
      kind: "none",
    });
  });

  it("stops at a CAPTCHA instead of taking the link past it", () => {
    const html = `<div class="cf-turnstile"></div><a href="${destination}">Continue</a>`;
    expect(findHtmlTarget(html, leaving)).toEqual({ kind: "human-check" });
  });

  // Facebook's warning page links to l.facebook.com/l.php?u=<the same URL>&h=<signature>.
  const handOff = "https://shim.example/l.php?u=https%3A%2F%2Fdest.example%2Fpage%3Fid%3D7&h=sig";

  it("follows a link to another host's redirector for the same URL", () => {
    // Like Facebook's page, it also shows the URL: the hand-off wins over "waits for a click".
    const html = `<p>${destination}</p><a href="${handOff}">Follow link</a>`;
    expect(findHtmlTarget(html, leaving)).toEqual({
      kind: "redirect",
      url: handOff,
      method: "html",
    });
  });

  it("tries an unencoded + in the address as a +, not as the space URLSearchParams reads", () => {
    const plus = new URL("https://l.example/l.php?u=https://dest.example/a+b");
    expect(findHtmlTarget('<a href="https://dest.example/a+b">Go</a>', plus)).toMatchObject({
      url: "https://dest.example/a+b",
    });
  });

  it("ignores a parameter that is not an http(s) URL", () => {
    const share = new URL("https://site.example/share?to=mailto:a@b.example");
    expect(findHtmlTarget('<a href="mailto:a@b.example">Mail</a>', share)).toEqual({
      kind: "none",
    });
  });

  it("prefers a direct link to a redirector", () => {
    const html = `<a href="${handOff}">via</a><a href="${destination}">direct</a>`;
    expect(findHtmlTarget(html, leaving)).toMatchObject({ url: destination });
  });

  it.each([
    ['<a href="/url?q=https%3A%2F%2Fdest.example%2Fpage%3Fid%3D7">x</a>', "on the same host"],
    [
      '<a href="https://shim.example/l.php?u=https%3A%2F%2Fother.example%2F">x</a>',
      "for another URL",
    ],
  ])("does not follow a redirector link %s", (html) => {
    expect(findHtmlTarget(html, leaving)).toEqual({ kind: "none" });
  });

  // LinkedIn's page shows the URL and adds its "Continue" button with JavaScript.
  it.each([
    [`<span>${destination}</span><a href="/">Go back</a>`, "the URL as it is"],
    ["<p>You are going to https://dest.example/page?id=7 now.</p>", "the URL inside a sentence"],
    ["<noscript>https://dest.example/page?id=7</noscript>", "the URL in <noscript>"],
    [
      `<head><style>p{}</style><script>var a=1</script></head><body>${destination}</body>`,
      "the URL after a style sheet and a script",
    ],
  ])("sees that a page showing %s waits for a click (%s)", (html) => {
    expect(findHtmlTarget(html, leaving)).toEqual({ kind: "needs-click" });
  });

  it.each([
    ["https%3A%2F%2Fdest.example", "https://dest.example", "without the slash the parser adds"],
    ["HTTPS://Dest.Example/x", "HTTPS://Dest.Example/x", "as the address wrote it"],
  ])("matches a URL that is shown %s", (parameter, shown) => {
    const named = new URL(`https://www.linkedin.example/redir?url=${parameter}`);
    expect(findHtmlTarget(`<span>${shown}</span>`, named)).toEqual({ kind: "needs-click" });
  });

  it.each([
    [`<script>var next = "${destination}";</script>`, "a script"],
    [`<style>/* ${destination} */</style>`, "a style sheet"],
    [`<template><p>${destination}</p></template>`, "a template"],
  ])("does not count the URL inside %s as shown", (html) => {
    expect(findHtmlTarget(html, leaving)).toEqual({ kind: "none" });
  });
});

describe("findHtmlTarget: any other page", () => {
  it.each([
    ["", "an empty page"],
    ["<h1>Hello</h1><a href='https://dest.test/'>a link</a>", "an article with links"],
    ["<p><b><i>unclosed <a href=x <<<>>> &bogus; </p></div></span>", "broken HTML"],
    ["<!doctype html><html><head><title>t</title></head><body>x</body></html>", "a full page"],
  ])("finds nothing in %s (%s)", (html) => {
    expect(findHtmlTarget(html, page)).toEqual({ kind: "none" });
  });

  // htmlparser2 needs quadratic time for unclosed tags; past 512 open elements reading stops.
  it.each([
    ["<b>", "unclosed tags"],
    ["<div>", "unclosed blocks"],
    ["<table>", "unclosed tables"],
  ])("reads a 1 MiB page of %s quickly (%s)", (tag) => {
    const started = performance.now();
    expect(findHtmlTarget(tag.repeat(Math.floor(1024 ** 2 / tag.length)), page)).toEqual({
      kind: "none",
    });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads a 1 MiB page of links quickly", () => {
    const leaving = new URL("https://l.example/?u=https://dest.example/");
    const html = '<a href="https://other.example/x">x</a>'.repeat(27_000);
    const started = performance.now();
    expect(findHtmlTarget(html, leaving)).toEqual({ kind: "none" });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("findHtmlTarget: scripts", () => {
  const js = (code: string, attributes = "") => `<script${attributes}>${code}</script>`;
  const toDest = 'location.href = "https://dest.test/js"';
  const followed = { kind: "redirect", url: "https://dest.test/js", method: "javascript" };

  it.each([
    [js('location.replace("https://dest.test/js")'), "an inline script"],
    [js(toDest, ' type=" Text/JavaScript "'), "a type in other letters, with spaces"],
    [js(toDest, ' type="text/x-javascript"'), "an old type"],
    [js(toDest, ' language="JavaScript1.2"'), "an old language attribute"],
    [js(toDest, ' type="module"'), "a module script"],
    [js(toDest, ' type="module" nomodule'), "a module script marked nomodule, which still runs"],
    [`<body onload="${toDest.replaceAll('"', "'")}">`, "a body onload attribute"],
    [
      `<frameset onload="${toDest.replaceAll('"', "'")}"></frameset>`,
      "a frameset onload attribute",
    ],
    [
      `${js("function go() { location.href = 'https://dest.test/js'; }")}<body onload="go()">`,
      "an onload attribute that calls a function from a script",
    ],
  ])("follows %s (%s)", (html) => {
    expect(findHtmlTarget(html, page)).toEqual(followed);
  });

  it.each([
    [`<noscript>${js(toDest)}</noscript>`, "a script in <noscript>, which never runs"],
    [`<template>${js(toDest)}</template>`, "a script in a <template>"],
    [
      js(`{"url": "https://dest.test/js", "x": location}`, ' type="application/ld+json"'),
      "JSON-LD",
    ],
    [js(toDest, ' type="text/template"'), "a template script"],
    [js(toDest, ' type="text/javascript; charset=utf-8"'), "a type with a charset"],
    [js(toDest, ' language="VBScript"'), "another language"],
    [js(toDest, " nomodule"), "a script for browsers without modules"],
    [js(toDest, ' src="/app.js"'), "the text inside a script that loads a file"],
    [`<p>Wait</p><script>${toDest}`, "a script the page never closes"],
    [
      `<div onload="${toDest.replaceAll('"', "'")}"></div>`,
      "onload on an element that never loads",
    ],
    [
      `<noscript><body onload="${toDest.replaceAll('"', "'")}"></noscript>`,
      "onload inside <noscript>",
    ],
  ])("ignores %s (%s)", (html) => {
    expect(findHtmlTarget(html, page)).toEqual({ kind: "none" });
  });

  it("reports a script that leaves the page for a place it cannot work out", () => {
    expect(findHtmlTarget(js("location.href = pick()"), page)).toEqual({ kind: "unknown-script" });
  });

  it("resolves a relative script URL against <base href>", () => {
    const html = `<base href="https://cdn.test/dir/">${js('location.href = "next"')}`;
    expect(findHtmlTarget(html, page)).toMatchObject({ url: "https://cdn.test/dir/next" });
  });

  it("does not read the scripts of an error page", () => {
    expect(findHtmlTarget(js(toDest), page, { onlyHumanCheck: true })).toEqual({ kind: "none" });
  });

  describe("in order", () => {
    const leaving = new URL("https://l.example/l.php?u=https%3A%2F%2Fdest.example%2F");

    it("follows a meta refresh before a script", () => {
      const html = `<meta http-equiv="refresh" content="0;url=/meta">${js(toDest)}`;
      expect(findHtmlTarget(html, page)).toMatchObject({ url: "https://short.test/meta" });
    });

    it("follows the single frame of a frameset before its onload script", () => {
      const html = `<frameset onload="${toDest.replaceAll('"', "'")}"><frame src="/frame"></frameset>`;
      expect(findHtmlTarget(html, page)).toEqual({
        kind: "redirect",
        url: "https://short.test/frame",
        method: "html",
      });
    });

    it("stops at a CAPTCHA before a script", () => {
      const html = `<div class="g-recaptcha"></div>${js(toDest)}`;
      expect(findHtmlTarget(html, page)).toEqual({ kind: "human-check" });
    });

    it('follows the link of a "leaving" page before a script', () => {
      const html = `<a href="https://dest.example/">Go</a>${js(toDest)}`;
      expect(findHtmlTarget(html, leaving)).toMatchObject({ url: "https://dest.example/" });
    });

    it("follows a script before deciding the page waits for a click", () => {
      const html = `<p>https://dest.example/</p>${js('location.replace("https://dest.example/")')}`;
      expect(findHtmlTarget(html, leaving)).toEqual({
        kind: "redirect",
        url: "https://dest.example/",
        method: "javascript",
      });
    });

    it("prefers 'cannot work out the script' to 'waits for a click'", () => {
      const html = `<p>https://dest.example/</p>${js("location.href = pick()")}`;
      expect(findHtmlTarget(html, leaving)).toEqual({ kind: "unknown-script" });
    });
  });
});
