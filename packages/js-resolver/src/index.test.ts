import { describe, expect, it, vi } from "vitest";
import { findJsTarget } from "./index.ts";

const page = new URL("https://short.test/out?to=https%3A%2F%2Fdest.test%2Fq&n=5");

function find(scripts: string | string[], at = page) {
  return findJsTarget(Array.isArray(scripts) ? scripts : [scripts], at);
}

const redirect = (url: string) => ({ kind: "redirect", url });
const NONE = { kind: "none" };
const UNKNOWN = { kind: "unknown" };
const MAYBE = { kind: "maybe" };

describe("findJsTarget: what counts as leaving the page", () => {
  it.each([
    'location = "https://dest.test/"',
    "window.location = 'https://dest.test/'",
    'document.location = "https://dest.test/"',
    'self.location = "https://dest.test/"',
    'top.location.href = "https://dest.test/"',
    'window.top.location = "https://dest.test/"',
    'this.location = "https://dest.test/"',
    'location.href = "https://dest.test/"',
    'window.location.href = "https://dest.test/"',
    'window["location"]["href"] = "https://dest.test/"',
    'location.replace("https://dest.test/")',
    'window.location.replace("https://dest.test/")',
    'document.location.assign("https://dest.test/")',
    'window.open("https://dest.test/", "_self")',
    'open("https://dest.test/", "_top")',
    'window.open("https://dest.test/", "_parent")',
  ])("reads %s", (script) => {
    expect(find(script)).toEqual(redirect("https://dest.test/"));
  });

  it.each([
    ['window.open("https://dest.test/")', "a new window: the page itself stays"],
    ['window.open("https://dest.test/", "_blank")', "a new window by name"],
    ['document.open("https://dest.test/", "_self")', "document.open, which is no navigation"],
    ['location.hash = "#top"', "a jump inside the page"],
    ['history.pushState({}, "", "/other")', "a change of address without loading"],
    ['element.location = "https://dest.test/"', "the location of something else"],
    ['frame.contentWindow.location = "https://dest.test/"', "the location of another window"],
    ['window.opener.location = "https://dest.test/"', "the window that opened this one"],
    ['location.href.replace("a", "b")', "a string method on the address"],
    ["console.log(location.href)", "reading the address"],
    ['var page = "https://dest.test/"', "a URL that is never used"],
  ])("does not count %s (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });
});

describe("findJsTarget: working out the URL", () => {
  it.each([
    // t.co writes its slashes escaped.
    ['location.replace("https:\\/\\/dest.test\\/page")', "https://dest.test/page"],
    ['location.href = "\\x68ttps://dest.test/\\u0070age"', "https://dest.test/page"],
    ['location.href = "https://" + "dest.test" + "/" + 1 + 2', "https://dest.test/12"],
    ['location.href = "https://dest.test/" + (1 + 2)', "https://dest.test/3"],
    ['var host = "dest.test"; location.href = "https://" + host + "/x"', "https://dest.test/x"],
    ['let u; u = "https://dest.test/later"; location.href = u', "https://dest.test/later"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source for the analyzer
    ['const h = "dest.test"; location.href = `https://${h}/t`', "https://dest.test/t"],
    ["location.href = `https://dest.test/plain`", "https://dest.test/plain"],
    ['location.href = decodeURIComponent("https%3A%2F%2Fdest.test%2Fd")', "https://dest.test/d"],
    ['location.href = decodeURI("https://dest.test/caf%C3%A9")', "https://dest.test/caf%C3%A9"],
    ['location.href = unescape("https%3A//dest.test/u")', "https://dest.test/u"],
    [
      'location.href = "https://dest.test/?r=" + encodeURIComponent("a b")',
      "https://dest.test/?r=a%20b",
    ],
    ['location.href = window.atob("aHR0cHM6Ly9kZXN0LnRlc3QvYjY0")', "https://dest.test/b64"],
    [
      "location.href = String.fromCharCode(104,116,116,112,115,58,47,47,100,101,115,116,46,116,101,115,116,47)",
      "https://dest.test/",
    ],
    [
      'var cfg = {"url": "https://dest.test/json"}; location.href = cfg.url',
      "https://dest.test/json",
    ],
    [
      "var cfg = {links: [{href: 'https://dest.test/a'}]}; location.href = cfg.links[0].href",
      "https://dest.test/a",
    ],
    [
      'var cfg = {["u" + "rl"]: "https://dest.test/k", 2: "x"}; location.href = cfg.url',
      "https://dest.test/k",
    ],
    [
      'var cfg = {url: "https://dest.test/1", url: "https://dest.test/2"}; location.href = cfg["url"]',
      "https://dest.test/2",
    ],
    [
      'var d = JSON.parse(\'{"next": "https://dest.test/j", "list": ["https://dest.test/l"]}\'); location.href = d.list[0]',
      "https://dest.test/l",
    ],
    ['location.replace(new URLSearchParams(location.search).get("to"))', "https://dest.test/q"],
    ['location.replace(new URL(location.href).searchParams.get("to"))', "https://dest.test/q"],
    [
      'location.href = new URLSearchParams(window.location.search).get("missing") || "/fallback"',
      "https://short.test/fallback",
    ],
    ['location.href = null ?? "/nullish"', "https://short.test/nullish"],
    ['location.href = "" && "/never" || "/or"', "https://short.test/or"],
    ['location.href = "/" && "/and"', "https://short.test/and"],
    [
      'location.href = "ptth".split("").reverse().join("") + "s://dest.test/r"',
      "https://dest.test/r",
    ],
    ['location.href = ["https:", "", "dest.test", "arr"].join("/")', "https://dest.test/arr"],
    ['location.href = "HTTPS://DEST.TEST/C".toLowerCase()', "https://dest.test/c"],
    ['location.href = " https://dest.test/t ".trim()', "https://dest.test/t"],
    ['location.href = "https://dest.test/a".replace("/a", "/b")', "https://dest.test/b"],
    ['location.href = "https://dest.test/a-a".replaceAll("a", "b")', "https://dest.test/b-b"],
    ['location.href = "https://dest.test/".concat("c", 1)', "https://dest.test/c1"],
    ['location.href = "https://dest.test/abc".slice(0, 19)', "https://dest.test/a"],
    ['location.href = "xxhttps://dest.test/s".substring(2)', "https://dest.test/s"],
    ['location.href = "https://dest.test/s".toString()', "https://dest.test/s"],
    ['location.href = "https://dest.test/" + "abc"[1] + "abc".length', "https://dest.test/b3"],
    ['location.href = (0, "https://dest.test/seq")', "https://dest.test/seq"],
    ['location.href = u = "https://dest.test/chain"', "https://dest.test/chain"],
    [
      'location.href = ok ? "https://dest.test/same" : "https://dest.test/same"',
      "https://dest.test/same",
    ],
    ['var cfg = {url: "https://dest.test/opt"}; location.href = cfg?.url', "https://dest.test/opt"],
    ['location.href = "/relative"', "https://short.test/relative"],
    ['location.href = location.origin + "/root"', "https://short.test/root"],
    [
      'location.href = window.location.protocol + "//dest.test" + location.pathname',
      "https://dest.test/out",
    ],
    [
      'location.href = location.href.replace("short.test/out", "dest.test/in")',
      "https://dest.test/in?to=https%3A%2F%2Fdest.test%2Fq&n=5",
    ],
    ['location.href = document.URL + "&ok=1"', `${page.href}&ok=1`],
    ['location.href = new URL("/made", "https://dest.test").href', "https://dest.test/made"],
    ['location.href = new URL("https://dest.test/u")', "https://dest.test/u"],
    ['location.href = new URLSearchParams("a=1").toString() && "/qs"', "https://short.test/qs"],
    ['location.href = "https://dest.test/" + true + null', "https://dest.test/truenull"],
    ['location.href = "https://dest.test/" + 6 * 7', "https://dest.test/42"],
    [
      'location.href = "https://dest.test/" + (1 < 2) + (2 <= 1) + ("b" > "a") + (2 >= 2)',
      "https://dest.test/truefalsetruetrue",
    ],
    [
      'location.href = "https://dest.test/" + (null === null) + (1 != 2) + ("x" == "x") + (1 !== 1)',
      "https://dest.test/truetruetruefalse",
    ],
    ['location.href = "https://dest.test/" + !"" + !location', "https://dest.test/truefalse"],
    [
      'location.href = "https://dest.test/" + -1 + (2 < 2) + (2 <= 2) + (2 > 2)',
      "https://dest.test/-1falsetruefalse",
    ],
    [
      'location.href = "https://dest.test/" + ("1" === 1) + "abcabc".indexOf("b", 2)',
      "https://dest.test/false4",
    ],
    [
      'var s = "?x=1&to=https://dest.test/p"; location.href = s.slice(s.indexOf("=", 3) + 1);',
      "https://dest.test/p",
    ],
    [
      'location.href = "https://dest.test/" + "abc".indexOf("c") + "abc".startsWith("a") + "abc".endsWith("x") + "abc".includes("b")',
      "https://dest.test/2truefalsetrue",
    ],
    [
      'location.href = "https://dest.test/" + location.host + location.port + location.hash',
      "https://dest.test/short.test",
    ],
    ['location.href = "https://" + location.hostname + "/h"', "https://short.test/h"],
    ['location.href = document.documentURI + "&d=1"', `${page.href}&d=1`],
    ['location.href = "/?" + new URLSearchParams("a=1&b=2")', "https://short.test/?a=1&b=2"],
    [`location.href = "https://dest.test/  "${".trim()".repeat(16)}`, "https://dest.test/"],
  ])("works out %s", (script, url) => {
    expect(find(script)).toEqual(redirect(url));
  });

  it("resolves a relative URL against the base it is given", () => {
    const base = new URL("https://cdn.test/dir/");
    expect(findJsTarget(['location.href = "next"'], page, base)).toEqual(
      redirect("https://cdn.test/dir/next"),
    );
  });

  it("compares the URL with the page itself, not with the base", () => {
    const base = new URL("https://cdn.test/dir/");
    expect(findJsTarget(['location.href = "https://cdn.test/dir/"'], page, base)).toEqual(
      redirect("https://cdn.test/dir/"),
    );
  });

  it.each([
    ["location.href = getDestination()", "a function call"],
    ["location.href = document.referrer", "the previous page"],
    ['location.href = ok ? "https://a.test/" : "https://b.test/"', "two possible answers"],
    ['var u = "https://a.test/"; u = "https://b.test/"; location.href = u', "a variable set twice"],
    ['var u = "x"; u += "y"; location.href = u', "a variable changed by +="],
    ["location.href = navigator.userAgent", "a browser property"],
    ["location.href = window.myUrl", "a property of window"],
    ['location.href = "https://dest.test/".replace(/dest/, "x")', "a regular expression"],
    ['location.href = atob("%%%")', "base64 that does not decode"],
    ['location.href = decodeURIComponent("%E0%A4%A")', "a broken escape"],
    ['location.href = JSON.parse("{bad").url', "JSON that does not parse"],
    ["location.href = JSON.parse(x).url", "JSON from an unknown value"],
    ['var o = {...other, url: "x"}; location.href = o.url', "an object with a spread"],
    ['var o = {[k]: "x"}; location.href = o.url', "an object with an unknown key"],
    ['location.href = [..."ab"][0]', "an array with a spread"],
    ['location.href = "ab".split(/b/)[0]', "a split on a regular expression"],
    ['location.href = "x".repeat(3)', "a string method this tool does not run"],
    ['location.href = "x" * 2', "multiplying text"],
    ['location.href = "/" + ("1" == 1)', "== between a string and a number"],
    ['location.href = "/" + (true < false)', "< between booleans"],
    ['location.href = "/" + ({} === {})', "=== between objects"],
    ['location.href = "/" + !x', "! of an unknown value"],
    ['location.href = "/" + -x', "a minus sign before an unknown value"],
    ['location.href = "/" + ~1', "an operator other than ! and -"],
    [
      'location.href = "/" + "abc".includes(1) + "abc".startsWith(1) + "abc".endsWith(1) + "abc".indexOf(1)',
      "includes, startsWith, endsWith and indexOf with a number",
    ],
    ['location.href = "/" + (2 - 1)', "arithmetic other than + and *"],
    ['location.href = "https://dest.test/a".replace("a", "$&$&")', "a replacement with $"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source for the analyzer
    ["location.href = `https://${host}/`", "a template with an unknown part"],
    ["location.href = String.fromCharCode(x)", "char codes that are not numbers"],
    ['location.href = new Thing("https://dest.test/")', "an unknown constructor"],
    ['location.href = new URL("relative")', "a relative URL without a base"],
    ['location.href = "https://dest.test/" + {}.x', "a missing property"],
    ['location.href = "https://dest.test/" + ["a"][5]', "a missing array element"],
    ['location.href = "x".at(0)', "a method on a string that is unknown"],
    ['location.href = 10n + ""', "a BigInt"],
    ['location.href = /x/ + ""', "a regular expression literal"],
    ["location.replace()", "no URL at all"],
    ['location.replace("https://dest.test/a"); location.href = "https://dest.test/b"', "two URLs"],
    ['location.replace("https://dest.test/"); location.href = pick();', "a URL and an unknown one"],
    [
      'var u; if (/Android/.test(navigator.userAgent)) u = "https://play.test/"; location.replace(u || "https://apps.test/")',
      "a value set for some browsers only",
    ],
    [
      'var u; b.onclick = function () { u = "https://b.test/"; }; location.href = u',
      "a value set by a click",
    ],
    [
      'var u = new URL("https://dest.test/landing"); u.searchParams.set("src", "short"); location.replace(u)',
      "a URL whose query is changed",
    ],
    [
      'var u = new URL(location.href); u.hostname = "dest.test"; location.href = u.href',
      "a URL whose host is changed",
    ],
    [
      'var cfg = {url: "https://a.test/"}; cfg.url = "https://b.test/"; location.href = cfg.url',
      "an object whose property is changed",
    ],
    [
      'var cfg = {url: "https://a.test/", n: 1}; cfg.n++; location.href = cfg.url',
      "an object whose property is counted",
    ],
    [
      'var cfg = {url: "https://a.test/"}; delete cfg.url; location.href = cfg.url',
      "an object whose property is deleted",
    ],
    [
      'var a = ["https://a.test/"]; a[0] = "https://b.test/"; location.href = a[0]',
      "an array whose element is changed",
    ],
    [
      'var p = ["https://", "dest.test"]; p.reverse(); location.href = p.join("")',
      "an array reversed in place",
    ],
    [
      'var q = new URLSearchParams("a=1"); q.set("a", "2"); location.href = "/?" + q',
      "URLSearchParams that are changed",
    ],
  ])("knows the page leaves, but not where to, for %s (%s)", (script) => {
    expect(find(script)).toEqual(UNKNOWN);
  });

  // Each rule below makes the name unknown. Without it, the name's other value would be used.
  it.each([
    ['function go(u) { location.href = u; } go("https://other.test/")', "a function parameter"],
    ["setTimeout(function (u) { location.href = u; }, 0, other)", "a parameter of a timer"],
    ["setTimeout((u) => { location.href = u; }, 0, other)", "a parameter of an arrow"],
    ["var {u} = cfg; location.href = u", "a name from an object pattern"],
    ["var [u] = list; location.href = u", "a name from an array pattern"],
    ["var {a: {b: u}, ...rest} = cfg; location.href = u", "a nested pattern with a rest"],
    ['var [, u = "x", ...more] = list; location.href = u', "a pattern with a hole and a default"],
    ["({u} = cfg); location.href = u", "an assignment to an object pattern"],
    ["[u] = list; location.href = u", "an assignment to an array pattern"],
    ["for (var u in cfg) {} location.href = u", "the variable of a for...in"],
    ["for (u of list) {} location.href = u", "the variable of a for...of"],
    ["class u {} location.href = u", "a class name"],
    ["try {} catch (u) {} location.href = u", "a caught error"],
    ["function f({u}, [v], ...w) {} location.href = u", "a function parameter in a pattern"],
    ['u++; location.href = "https://dest.test/" + u', "a name counted with ++"],
    ['u += "x"; location.href = u', "a name changed by +="],
    ['window.u = "https://other.test/"; location.href = u', "a global changed through window"],
  ])("does not trust a name that also gets another value: %s (%s)", (script) => {
    expect(find(['var u = "https://dest.test/";', script])).toEqual(UNKNOWN);
  });
});

describe("findJsTarget: code the page runs by itself", () => {
  it.each([
    ['setTimeout(function () { location.href = "https://dest.test/"; }, 3000)', "a timer"],
    ['window.setTimeout(() => location.replace("https://dest.test/"), 0)', "a timer with an arrow"],
    ["setTimeout(\"location.href='https://dest.test/'\", 1000)", "code given to a timer as text"],
    [
      "var code = \"location.href='https://dest.test/'\"; setInterval(code, 1000)",
      "timer code in a variable",
    ],
    [
      'requestAnimationFrame(() => { location.href = "https://dest.test/"; })',
      "an animation frame",
    ],
    ['window.onload = function () { location.href = "https://dest.test/"; }', "window.onload"],
    ['onload = () => { location.href = "https://dest.test/"; }', "a bare onload"],
    [
      'window.addEventListener("load", function () { location.href = "https://dest.test/"; })',
      "a load listener",
    ],
    [
      'document.addEventListener("DOMContentLoaded", () => location.replace("https://dest.test/"))',
      "a DOMContentLoaded listener",
    ],
    [
      '$(window).bind("load", function () { location.href = "https://dest.test/"; })',
      "jQuery's bind('load')",
    ],
    [
      '$(window).one("load", function () { location.href = "https://dest.test/"; })',
      "jQuery's one('load')",
    ],
    [
      'window.attachEvent("onload", function () { location.href = "https://dest.test/"; })',
      "an old attachEvent('onload')",
    ],
    ['$(function () { location.href = "https://dest.test/"; })', "jQuery's $(fn)"],
    ['jQuery(() => { location.href = "https://dest.test/"; })', "jQuery(fn)"],
    [
      '$(document).ready(function () { location.href = "https://dest.test/"; })',
      "$(document).ready",
    ],
    [
      '$(window).on("load", function () { location.href = "https://dest.test/"; })',
      "$(window).on('load')",
    ],
    ['$(window).load(function () { location.href = "https://dest.test/"; })', "$(window).load"],
    ['(function () { location.href = "https://dest.test/"; })()', "a function called right away"],
    ['!function () { location.href = "https://dest.test/"; }()', "a minified one"],
    ['(() => { location.href = "https://dest.test/"; })()', "an arrow called right away"],
    ['(function () { location.href = "https://dest.test/"; }).call(this)', "one run with .call"],
    [
      'function go() { location.href = "https://dest.test/"; } go();',
      "a named function called on load",
    ],
    [
      'var go = function () { location.href = "https://dest.test/"; }; setTimeout(go, 500);',
      "one given to a timer by name",
    ],
    [
      'go = () => { location.href = "https://dest.test/"; }; window.onload = go;',
      "one set as onload by name",
    ],
    [
      'function go() { location.href = "https://dest.test/"; } function start() { go(); } start();',
      "a function called by a function that runs",
    ],
    ['try { location.replace("https://dest.test/"); } catch (e) {}', "a try block"],
    [
      'var n = 5; var t = setInterval(function () { if (--n <= 0) { clearInterval(t); location.href = "https://dest.test/"; } }, 1000);',
      "a countdown in a timer",
    ],
    [
      'var n = 3; setInterval(function () { n = n - 1; if (n === 0 && !false) location.href = "https://dest.test/"; }, 1000);',
      "a countdown with an assignment and logic",
    ],
    [
      'var n = 3; setInterval(function () { if (n > 0) { n--; } else { location.href = "https://dest.test/"; } }, 1000)',
      "the else of a countdown",
    ],
    [
      'var n = 0; setInterval(function () { n += 1; if (n >= 3) location.href = "https://dest.test/"; }, 1000)',
      "a count up with +=",
    ],
    [
      'var n = 0; setInterval(function () { n = n + 1; if (n > 2) location.href = "https://dest.test/"; }, 1000)',
      "a count up with n + 1",
    ],
    [
      'var n = 5; setInterval(function () { if (--n > 0) return; location.href = "https://dest.test/"; }, 1000);',
      "a countdown that returns until it is done",
    ],
    [
      'var n = 3; setInterval(function () { if (--n <= 0) { var u = "https://dest.test/"; location.href = u; } }, 1000);',
      "a countdown that sets the URL when it is done",
    ],
    [
      'var count = 5; function countdown() { count--; if (count <= 0) location.href = "https://dest.test/"; } setInterval(countdown, 1000);',
      "a countdown in a named function",
    ],
    [
      'var n = 3; const tick = () => { if (--n <= 0) location.href = "https://dest.test/"; }; setInterval(tick, 1000);',
      "a countdown in a named arrow",
    ],
    [
      'var n = 5; function tick() { if (--n <= 0) location.href = "https://dest.test/"; else setTimeout(tick, 1000); } tick();',
      "a countdown that sets its own next timer",
    ],
    ['setTimeout(function () { location.href = "https://dest.test/"; }, 5 * 1000)', "a 5 s timer"],
    ['window.onpageshow = function () { location.href = "https://dest.test/"; }', "onpageshow"],
    [
      'addEventListener("pageshow", function () { location.href = "https://dest.test/"; })',
      "a pageshow listener",
    ],
    ['queueMicrotask(() => { location.href = "https://dest.test/"; })', "a microtask"],
    [
      'setTimeout("setTimeout(\\"location.href=\'https://dest.test/\'\\", 1)", 1)',
      "timer code that starts timer code",
    ],
    ['location.href = "https://dest.test/"; return false;', "an onload attribute's return"],
    [
      'function x() { location.href = "#wait"; y(); } function y() { setTimeout(x, 1000); location.replace("https://dest.test/"); } x();',
      "two functions that run each other",
    ],
    [
      'function y() { setTimeout(x, 1000); location.replace("https://dest.test/"); } function x() { location.href = "#wait"; y(); } x();',
      "the same two, in the other order",
    ],
    [
      'if (top !== self) top.location = self.location; location.href = "https://dest.test/";',
      "a frame breaking out before the redirect",
    ],
    [
      'if (ios) location.href = "https://dest.test/"; else location.href = "https://dest.test/";',
      "two ways out that lead to one place",
    ],
  ])("follows a redirect in %s (%s)", (script) => {
    expect(find(script)).toEqual(redirect("https://dest.test/"));
  });

  it("follows a redirect a body onload attribute starts in another script", () => {
    const scripts = ['function go() { location.href = "https://dest.test/"; }', "go()"];
    expect(find(scripts)).toEqual(redirect("https://dest.test/"));
  });

  it.each([
    [
      'document.getElementById("b").onclick = function () { location.href = "https://dest.test/"; }',
      "a click handler",
    ],
    [
      'button.addEventListener("click", () => { location.href = "https://dest.test/"; })',
      "a click listener",
    ],
    [
      '$("#b").on("click", function () { location.href = "https://dest.test/"; })',
      "a jQuery click",
    ],
    ['$("#b").click(function () { location.href = "https://dest.test/"; })', "a jQuery .click"],
    ['function go() { location.href = "https://dest.test/"; }', "a function nobody calls"],
    [
      'function go() { location.href = "https://dest.test/"; } b.onclick = function () { go(); };',
      "a function only a click calls",
    ],
    [
      'function go() { location.href = "https://dest.test/"; } b.onclick = go;',
      "a function set as a click handler",
    ],
    [
      'function go() { go(); location.href = "https://dest.test/"; }',
      "a function that only calls itself",
    ],
    [
      'function go() { location.href = "https://dest.test/"; } function go() {} go();',
      "a name used for two functions",
    ],
    [
      'if (navigator.userAgent.indexOf("iPhone") > -1) location.href = "https://m.dest.test/";',
      "a test of the browser",
    ],
    ['if (screen.width < 700) { location.href = "https://m.dest.test/"; }', "a test of the screen"],
    ['ready && (location.href = "https://dest.test/")', "a condition with &&"],
    ['for (var i = 0; i < 1; i++) location.href = "https://dest.test/";', "a loop"],
    ['while (false) { location.href = "https://dest.test/"; }', "a while loop"],
    ['switch (x) { case 1: location.href = "https://dest.test/"; }', "a switch"],
    ['try { a(); } catch (e) { location.href = "https://dest.test/"; }', "a catch block"],
    ['var u = ok ? location.replace("https://dest.test/") : 0', "a branch of ?:"],
    [
      'b.onclick = () => setTimeout(() => { location.href = "https://dest.test/"; }, 10)',
      "a timer started by a click",
    ],
    [
      'var n = 5; if (--n <= 0) location.href = "https://dest.test/";',
      "a countdown test outside a timer",
    ],
    [
      'setInterval(function () { if (document.hidden) location.href = "https://dest.test/"; }, 1000)',
      "a timer test of the browser",
    ],
    [
      'setInterval(function () { if (check()) location.href = "https://dest.test/"; }, 1000)',
      "a timer test that calls a function",
    ],
    [
      'setInterval(function () { if (a.b > 0) location.href = "https://dest.test/"; }, 1000)',
      "a timer test that reads a property",
    ],
    [
      'setInterval(function () { if ("k" in o) location.href = "https://dest.test/"; }, 1000)',
      "a timer test with in",
    ],
    [
      'setInterval(function () { if (typeof x) location.href = "https://dest.test/"; }, 1000)',
      "a timer test with typeof",
    ],
    [
      'setInterval(function () { if (s === "go") location.href = "https://dest.test/"; }, 1000)',
      "a timer test against text",
    ],
    [
      'setInterval(function () { if ((o.n = 1)) location.href = "https://dest.test/"; }, 1000)',
      "a timer test that sets a property",
    ],
    [
      'setInterval(function () { if (n) {} else location.href = "https://dest.test/"; }, 1000)',
      "a timer test of a name the page never sets",
    ],
    ["setTimeout(go, 10)", "a timer for a function that is not there"],
    [
      'setInterval(function () { if (top != self) top.location = "https://dest.test/"; }, 100)',
      "a timer test of the window",
    ],
    [
      'setTimeout(function () { if (innerWidth < 768) location.href = "https://dest.test/"; }, 0)',
      "a timer test of the screen width",
    ],
    [
      'var isMobile = /Android/.test(navigator.userAgent); setTimeout(function () { if (isMobile) location.href = "https://dest.test/"; }, 0)',
      "a timer test of a flag the browser decides",
    ],
    [
      'var go = false; b.onclick = function () { go = true; }; setInterval(function () { if (go) location.href = "https://dest.test/"; }, 100)',
      "a timer test of a flag a click sets",
    ],
    [
      'var n = 5; setInterval(function () { if (n > 10) location.href = "https://dest.test/"; }, 1000)',
      "a timer test of a number that never changes",
    ],
    [
      'var n = 5; n = start(); setInterval(function () { if (--n <= 0) location.href = "https://dest.test/"; }, 1000)',
      "a timer test of a number that is also set from elsewhere",
    ],
    [
      'var n = 3; setInterval(function () { if (n-- === "0") location.href = "https://dest.test/"; }, 1000)',
      "a timer test of a counter against text",
    ],
    [
      'function go() { location.href = "https://dest.test/"; } if (ready) go();',
      "a function called behind a test",
    ],
    [
      '(function () { location.href = "https://dest.test/"; }).bind(this)',
      "a function that is only bound",
    ],
    [
      '(function () { if (a) return; if (b) return; location.href = "https://dest.test/"; })()',
      "code after two tests that return",
    ],
    [
      'if (a) location.href = "https://a.test/"; if (b) location.href = "https://b.test/";',
      "two tests, each of which may stay",
    ],
    [
      'setInterval(function () { if (false) location.href = "https://dest.test/"; }, 1000)',
      "a timer test that is never true",
    ],
    [
      'var n = 5; function go() { if (--n <= 0) location.href = "https://dest.test/"; } window.onload = go;',
      "a countdown that onload runs only once",
    ],
    [
      'setTimeout(function () { location.href = "/logout"; }, 15 * 60 * 1000)',
      "a session timeout of 15 minutes",
    ],
    ["setTimeout(\"location.href='/'\", 600000)", "the same, as timer code"],
    ['function out() { location.href = "/logout"; } setTimeout(out, 600000);', "a named one"],
    [
      "b.onclick = function () { setTimeout(\"location.href='https://dest.test/'\", 10); }",
      "timer code started by a click",
    ],
    [
      '(function () { if (!/Android|iPhone/.test(navigator.userAgent)) return; location.replace("https://dest.test/"); })()',
      "code after a test that returns",
    ],
    [
      '(function () { if (sessionStorage.getItem("seen")) { log(); return; } location.replace("https://dest.test/"); })()',
      "code after a block that returns",
    ],
    [
      'if (screen.width > 700) throw 0; location.href = "https://dest.test/";',
      "code after a throw",
    ],
    [
      '(function () { for (var i = 0; i < 3; i++) { if (bad(i)) return; } location.href = "https://dest.test/"; })()',
      "code after a loop that may return",
    ],
    ['ok || (location.href = "https://dest.test/")', "a condition with ||"],
    ['var u = "x"; u ??= (location.href = "https://dest.test/")', "the right side of ??="],
    ['for (var k in o) location.href = "https://dest.test/";', "a for...in loop"],
    ['for (var v of list) location.href = "https://dest.test/";', "a for...of loop"],
    [
      'obj.$(function () { location.href = "https://dest.test/"; })',
      "a $ method of something else",
    ],
    ['location.href += "?ok=1"', "an address changed with +="],
    [
      '!function(){function e(){location.href="https://dest.test/"}document.getElementById("b").onclick=e}();!function(e){e()}(function(){});',
      "minified code where another function's parameter has the same name",
    ],
  ])("ignores a redirect in %s (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });

  it.each([
    ["if (top != self) top.location = self.location;", "a frame breaking out"],
    ['location.href = "#section";', "a jump inside the page"],
  ])("treats %s as staying on the page (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });

  it("follows the one URL when other redirects only reload the page", () => {
    expect(find('top.location = self.location; location.href = "https://dest.test/";')).toEqual(
      redirect("https://dest.test/"),
    );
  });

  // Everyone is sent somewhere, so the page is not the destination, but the place depends on the
  // visitor's browser.
  it.each([
    [
      'if (/iPhone/.test(navigator.userAgent)) location.href = "https://a.test/"; else location.href = "https://b.test/";',
      "if and else",
    ],
    [
      'if (a) location.href = "https://a.test/"; else if (b) location.href = "https://b.test/"; else location.href = "https://c.test/";',
      "else if",
    ],
    ['ios ? location.href = "https://a.test/" : location.replace("https://b.test/");', "?:"],
    [
      'ios ? (track(), location.href = "https://a.test/") : location.replace("https://b.test/");',
      "?: with a comma",
    ],
    [
      'ios ? (u = "https://dest.test/", location.href = u) : location.replace("https://dest.test/"); location.href = u;',
      "a URL set in one way of ?: and used after it",
    ],
    [
      '(function () { if (ios) { location.href = "https://a.test/"; return; } location.href = "https://b.test/"; })();',
      "a return after the first way out",
    ],
    [
      'if (ios) { var u = "https://a.test/"; location.href = u; } else location.href = "https://b.test/";',
      "a URL set in one of the ways",
    ],
    [
      'var ios = /iPhone/.test(navigator.userAgent); setTimeout(function () { if (ios) location.href = "https://a.test/"; else location.href = "https://b.test/"; }, 25);',
      "a choice in a timer",
    ],
  ])("knows the page leaves, but not where to, when it chooses with %s (%s)", (script) => {
    expect(find(script)).toEqual(UNKNOWN);
  });

  it.each([
    ['if (mobile) location.href = "https://m.dest.test/";', "one way out and no other"],
    ['if (mobile) location.href = "https://m.dest.test/"; else show();', "an else that stays"],
    ['mobile ? location.replace("https://m.dest.test/") : show();', "the same with ?:"],
    [
      '(function () { if (mobile) { location.href = "https://m.dest.test/"; return; } show(); })();',
      "a return after the one way out",
    ],
  ])("leaves a choice that may stay on the page alone: %s (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });
});

describe("findJsTarget: reading scripts safely", () => {
  it("skips a script that does not parse, and still reads the others", () => {
    expect(find(["location.href = ", 'location.href = "https://dest.test/"'])).toEqual(
      redirect("https://dest.test/"),
    );
  });

  it("reads a module script", () => {
    expect(find('import x from "y"; location.href = "https://dest.test/m";')).toEqual(
      redirect("https://dest.test/m"),
    );
  });

  it("reads a script wrapped in an old HTML comment", () => {
    expect(find('<!--\nlocation.href = "https://dest.test/old";\n//-->')).toEqual(
      redirect("https://dest.test/old"),
    );
  });

  it.each(["var a = 1;", "", "function f() { return 1; }"])(
    "finds nothing in a script that never mentions location: %j",
    (script) => {
      expect(find(script)).toEqual(NONE);
    },
  );

  it("skips a script larger than 64 KiB, which is a bundle and not a redirect page", () => {
    const big = `${"var a = 1;\n".repeat(7000)}location.href = "https://dest.test/";`;
    expect(find(big)).toEqual(NONE);
  });

  it("skips scripts past 256 KiB in all", () => {
    const filler = `/*${"x".repeat(64_996)}*/`; // 65,000 characters, just under the per-script limit
    const redirectScript = `location.href = "https://dest.test/"; /*${"y".repeat(3000)}*/`;
    const scripts = [filler, filler, filler, filler, redirectScript];
    expect(find(scripts)).toEqual(NONE); // 4 x 65,000 + 3,000 is over 262,144
    expect(find(scripts.slice(1))).toEqual(redirect("https://dest.test/"));
    // A short script after the one that did not fit is still read.
    expect(find([...scripts, 'location.href = "https://dest.test/"'])).toEqual(
      redirect("https://dest.test/"),
    );
  });

  it("gives up on a script nested too deep for the parser", () => {
    expect(find(`location.href = ${"(".repeat(1000)}"x"${")".repeat(1000)};`)).toEqual(NONE);
  });

  it("stops working out a long chain of variables", () => {
    const chain = Array.from({ length: 60 }, (_, i) => `var v${i + 1} = v${i};`).join("");
    expect(find(`var v0 = "https://dest.test/";${chain} location.href = v60;`)).toEqual(UNKNOWN);
  });

  it("stops working out a long expression", () => {
    const sum = Array.from({ length: 2000 }, () => '"a"').join(" + ");
    expect(find(`location.href = ${sum};`)).toEqual(UNKNOWN);
  });

  // acorn itself refuses this one ("not enough stack space"), quickly.
  it("handles an expression too long to parse quickly", () => {
    const started = performance.now();
    const sum = Array.from({ length: 10_000 }, () => '"a"').join(" + ");
    expect(find(`location.href = ${sum};`)).toEqual(NONE);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stops working out a wide expression after 20,000 steps", () => {
    const names = Array.from({ length: 10_001 }, () => "a").join(",");
    const script = `var a = ""; location.href = "https://dest.test/" + [${names}].join("")`;
    expect(find(script)).toEqual(UNKNOWN);
  });

  it("does not build a string longer than 16 KiB", () => {
    const part = "x".repeat(10_000);
    expect(find(`var a = "${part}"; location.href = a + a;`)).toEqual(UNKNOWN);
  });

  it.each([
    ["replaceAll with an empty pattern", 'a.replaceAll("", b)'],
    ["replaceAll of every letter", 'a.replaceAll("x", b)'],
    ["a join with a long separator", 'a.split("").join(b)'],
    ["concat of 2,000 parts", `a.concat(${Array.from({ length: 2000 }, () => "b").join(",")})`],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source for the analyzer
    ["a template of 2,000 parts", `\`${"${a}".repeat(2000)}\``],
  ])("refuses to build gigabytes from short text: %s", (_, expression) => {
    const started = performance.now();
    const values = `var a = "${"x".repeat(16_000)}"; var b = "${"y".repeat(16_000)}";`;
    expect(find(`${values} location.href = ${expression};`)).toEqual(UNKNOWN);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each(['a.replaceAll("", b)', 'a.split("").join(b)'])(
    "refuses %s quickly, also when asked 200 times",
    (expression) => {
      const started = performance.now();
      const values = `var a = "${"x".repeat(16_000)}"; var b = "${"y".repeat(16_000)}";`;
      expect(find(`${values} ${`location.href = ${expression};`.repeat(200)}`)).toEqual(UNKNOWN);
      expect(performance.now() - started).toBeLessThan(2000);
    },
  );

  it("reads four 64 KiB scripts of one name over and over quickly", () => {
    const started = performance.now();
    const script = `location;${"a;".repeat(32_490)}`;
    expect(find([script, script, script, script])).toEqual(NONE);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it.each([
    ["self.self.self...", `${"self.".repeat(13_000)}location.href = "https://dest.test/"`],
    ["window.top.top...", `window${".top".repeat(15_000)}.location = "https://dest.test/"`],
    [
      "2,000 functions, each calling the next",
      `function f0() { location.href = "https://dest.test/"; } ${Array.from({ length: 2000 }, (_, i) => `function f${i + 1}() { f${i}(); }`).join("")} f2000();`,
    ],
  ])("follows a redirect at the end of a long chain: %s", (_, script) => {
    expect(find(script)).toEqual(redirect("https://dest.test/"));
  });

  it("stops working out a long chain of joins", () => {
    const joins = Array.from({ length: 100 }, (_, i) => `var a${i + 1} = [a${i}].join("");`);
    const script = `var a0 = "https://dest.test/"; ${joins.join("")} location.href = a100;`;
    expect(find(script)).toEqual(UNKNOWN);
  });

  it("says it did not understand a page whose analysis overflows the stack", () => {
    const parse = vi.spyOn(URL, "parse").mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    try {
      expect(find('location.href = "https://dest.test/"')).toEqual(UNKNOWN);
    } finally {
      parse.mockRestore();
    }
  });

  it("lets any other error through, so that a bug shows", () => {
    const parse = vi.spyOn(URL, "parse").mockImplementationOnce(() => {
      throw new TypeError("a bug");
    });
    try {
      expect(() => find('location.href = "https://dest.test/"')).toThrow(TypeError);
    } finally {
      parse.mockRestore();
    }
  });

  it("reads at most 20 pieces of timer code", () => {
    const timers = Array.from({ length: 25 }, (_, i) =>
      i === 24 ? "setTimeout(\"location.href='https://dest.test/'\", 1)" : 'setTimeout("x()", 1)',
    ).join(";");
    expect(find(timers)).toEqual(NONE);
  });

  it("counts only timer code toward those 20, not timers given a function by name", () => {
    const named = `function f() {} ${"setTimeout(f, 1);".repeat(20)}`;
    const script = `${named} setTimeout("location.href='https://dest.test/'", 1)`;
    expect(find(script)).toEqual(redirect("https://dest.test/"));
  });
});

describe("findJsTarget: the less common shapes", () => {
  it.each([
    ['location.href = this.location.origin + "/this"', "https://short.test/this"],
    ['location.href = window.document.location.origin + "/doc"', "https://short.test/doc"],
    ['location.href = window.top.location.origin + "/top"', "https://short.test/top"],
    ['location.href = new URLSearchParams().get("x") || "/empty"', "https://short.test/empty"],
    ['location.href = "/a" ?? "/b"', "https://short.test/a"],
    ['location.href = "/a" || "/b"', "https://short.test/a"],
    ['location.href = JSON.parse(\'{"u": null}\').u || "/n"', "https://short.test/n"],
    ['location.href = ["a", "b"].join()', "https://short.test/a,b"],
    ['location.href = new URL("https://dest.test/s").toString()', "https://dest.test/s"],
    [
      'var n = 3; setInterval(function () { if ((n -= 1) <= 0) location.href = "https://dest.test/"; }, 1000)',
      "https://dest.test/",
    ],
    ['(function () { location.href = "https://dest.test/"; }).apply(this)', "https://dest.test/"],
    ['var {u} = {u: 1}; location.href = "https://dest.test/"', "https://dest.test/"],
    ['export default class {} location.href = "https://dest.test/"', "https://dest.test/"],
    ['obj.n++; location.href = "https://dest.test/"', "https://dest.test/"],
    ['[obj.u] = list; location.href = "https://dest.test/"', "https://dest.test/"],
  ])("works out %s", (script, url) => {
    expect(find(script)).toEqual(redirect(url));
  });

  it.each([
    ["location.href = location.username", "a part of the address that is not read"],
    ['location.href = ["https://dest.test/"].pop()', "an array method that is not run"],
    ['location.href = [u].join("")', "an array with an unknown element"],
    ['location.href = [, "a"].join("")', "an array with a hole"],
    ['location.href = [..."ab"].join("")', "an array with a spread"],
    ['location.href = "abc".foo', "a property a string does not have"],
    ['location.href = "abc"[9]', "a letter past the end"],
    ["location.href = JSON.parse('[\"a\"]')[9]", "an element past the end of JSON"],
    ["location.href = JSON.parse('[\"a\"]').foo", "a property a JSON array does not have"],
    ['location.href = ["a"].foo', "a property an array literal does not have"],
    ['location.href = new window.URL("https://dest.test/")', "a constructor taken from window"],
    ["location.href = new URL(x)", "a URL made from an unknown value"],
    ['location.href = new URL("/p", x)', "a URL with an unknown base"],
    ['location.href = x || "/y"', "|| after an unknown value"],
    ['location.href = (u += "x")', "an assignment with +="],
    ["location.href = decodeURIComponent(...parts)", "spread arguments"],
    ['location.href = "x"[k]()', "a method with an unknown name"],
    ['location.href = "a".replaceAll(/a/g, "b")', "replaceAll with a regular expression"],
    ['location.href = "abc".slice("1")', "slice with text"],
    ['location.href = "abc".substring(x)', "substring with an unknown value"],
    ['location.href = "a".concat(x)', "concat with an unknown value"],
    [
      'location.href = new URLSearchParams("a=1").has("a") + ""',
      "a URLSearchParams method not run",
    ],
    [
      `var s = "${",".repeat(16_384)}"; location.href = s.split(",").join("x")`,
      "an array of more than 16 KiB parts",
    ],
    ['location.href = "abc"[k]', "a letter at an unknown place"],
    ['location.href = [{}].join("")', "an array holding an object"],
  ])("knows the page leaves, but not where to, for %s (%s)", (script) => {
    expect(find(script)).toEqual(UNKNOWN);
  });

  it.each([
    [
      'window.addEventListener(function () { location.href = "https://dest.test/"; })',
      "a listener without an event",
    ],
    [
      'var f = (function () { location.href = "https://dest.test/"; }).call;',
      "a .call that is never made",
    ],
    [
      'run((function () { location.href = "https://dest.test/"; }).call)',
      "a .call handed to something else",
    ],
    [
      'class A { #location; m() { this.#location = "https://dest.test/"; } }',
      "a private field named location",
    ],
    ['window[key] = "https://dest.test/"', "a property with an unknown name"],
    [
      'export default function () { location.href = "https://dest.test/"; }',
      "an unnamed exported function",
    ],
    ['try { x(); } catch { location.href = "https://dest.test/"; }', "a catch without a variable"],
  ])("ignores %s (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });
});

describe("findJsTarget: what only running the page shows", () => {
  it.each([
    [
      'fetch("/api").then((r) => r.json()).then((d) => { location.href = d.url; })',
      "a destination fetched first",
    ],
    [
      'fetch("/api").then((r) => r.json()).then((d) => { if (d.url) location.href = d.url; })',
      "the same, with a test inside the callback",
    ],
    [
      '$.ajax({ url: "/api", success: function (d) { location.href = d.url; } })',
      "a jQuery ajax callback",
    ],
    ['$.get("/api", function (d) { location.replace(d.url); })', "a jQuery get callback"],
    [
      'function go(d) { location.href = d.url; } fetch("/api").then(go)',
      "a named function given to then()",
    ],
    [
      "var xhr = new XMLHttpRequest(); xhr.onreadystatechange = function () { location.href = xhr.responseText; }; xhr.send();",
      "an XMLHttpRequest handler",
    ],
    [
      'addEventListener("message", function (e) { location.href = e.data; })',
      "a message from another window",
    ],
    [
      'addEventListener(name, function () { location.href = "https://dest.test/"; })',
      "an event whose name is unknown",
    ],
    [
      'new Promise(function () { location.href = "https://dest.test/"; })',
      "a known URL in code given to a constructor",
    ],
    [
      'fetch("/a").then(() => { setTimeout(() => { location.href = "https://dest.test/"; }, 100); })',
      "a timer started by a callback",
    ],
    [
      'var n = 5; timers[0](function () { if (--n <= 0) location.href = "https://dest.test/"; }, 1000)',
      "a countdown in a call whose name is unknown",
    ],
    ['document.cookie = "seen=1"; location.reload();', "a reload after setting a cookie"],
    [
      'if (document.cookie.indexOf("seen") < 0) { document.cookie = "seen=1"; window.location.reload(); }',
      "a reload only when the cookie is missing",
    ],
    ["location.href = location.href;", "the page sent to itself"],
    ["top.location = self.location;", "the same, from the top window"],
    ["location.replace(location.pathname + location.search);", "the same address rebuilt"],
    ["document.forms[0].submit();", "a form submitted by the page"],
    ['document.getElementById("f").requestSubmit();', "requestSubmit()"],
    ['$("#f").submit();', "a jQuery submit without a handler"],
    ['document.getElementById("go").click();', "a click made by the page"],
    ["setTimeout(function () { document.forms[0].submit(); }, 100);", "a submit in a timer"],
    [
      'eval(function (p, a, c, k, e, d) { return p; }("location.href=1", 1, 1, [], 0, {}));',
      "packed code",
    ],
    ["eval(code);", "eval of something unknown"],
    ["window.eval(atob(x));", "window.eval of something unknown"],
    ["new Function(text)();", "new Function made from unknown text"],
    ['Function("return " + x)();', "Function made from unknown text"],
  ])("may move on: %s (%s)", (script) => {
    expect(find(script)).toEqual(MAYBE);
  });

  it.each([
    ['Function("return this")();', "Function made from known text, a way to reach window"],
    ['eval("var a = 1;");', "eval of known code that goes nowhere"],
    ["b.onclick = function () { document.forms[0].submit(); };", "a submit after a click"],
    [
      'button.addEventListener("click", function () { location.reload(); });',
      "a reload after a click",
    ],
    ['$("#f").submit(function () { location.href = "https://dest.test/"; });', "a submit handler"],
    [
      "setTimeout(function () { location.reload(); }, 15 * 60 * 1000);",
      "a reload after 15 minutes",
    ],
    [
      'function later() { fetch("/a").then((d) => { location.href = d.url; }); }',
      "a callback in a function nobody calls",
    ],
    [
      'if (ok) fetch("/a").then((d) => { location.href = d.url; });',
      "a callback handed over behind a test",
    ],
    ['fetch("/a").then((d) => { location.href = "#done"; })', "a jump inside the page"],
    ['fetch("/a").then(() => { window.open("https://dest.test/"); })', "a new window"],
    [
      'var config = { success: function () { location.href = "/x"; } };',
      "an object no one is given",
    ],
    ["location.reload; form.submit", "methods that are named but not called"],
  ])("does not expect a move from %s (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });

  it("reads eval of known code like any other script", () => {
    expect(find("eval(\"location.href = 'https://dest.test/'\")")).toEqual(
      redirect("https://dest.test/"),
    );
  });

  it.each([
    [
      'if (location.hostname === "short.test") location.href = "https://a.test/"; else location.href = "https://b.test/";',
      "https://a.test/",
      "a choice by this page's own host",
    ],
    [
      'if (location.protocol === "http:") location.href = "https://a.test/"; else location.href = "https://b.test/";',
      "https://b.test/",
      "a choice by this page's scheme",
    ],
    [
      'location.hostname === "short.test" ? location.replace("https://a.test/") : location.replace("https://b.test/");',
      "https://a.test/",
      "the same with ?:",
    ],
  ])("follows the one way a test about this page allows: %s", (script, url) => {
    expect(find(script)).toEqual(redirect(url));
  });

  it.each([
    [
      "var time = Date.now(); function refresh() { if (Date.now() - time >= 900000) location.reload(true); else setTimeout(refresh, 10000); } setTimeout(refresh, 10000);",
      "a reload after a while of nothing happening",
    ],
    [
      "window.onpageshow = function (e) { if (e.persisted) location.reload(); };",
      "a reload when the page comes back from the history",
    ],
    [
      'if (location.href.includes("/old-article/")) location.reload();',
      "a reload for another page",
    ],
    ["ready || location.reload();", "a reload after || with a test of something else"],
    ["true || document.forms[0].submit();", "a submit after || when the left side is true"],
    ["0 ?? document.forms[0].submit();", "a submit after ?? when the left side is 0, not null"],
    [
      'function later() { if (!document.cookie.includes("ok")) location.reload(); }',
      "a cookie check in a function nobody calls",
    ],
    [
      'el.attachEvent("onclick", function () { document.forms[0].submit(); });',
      "a submit after a click, through attachEvent",
    ],
    [
      'removeEventListener("load", function () { location.href = "https://dest.test/"; });',
      "a load handler that is taken away",
    ],
    ["var r = math.eval(expression);", "an eval method of something else"],
    ['var u = location.href; $("#t").DataTable().ajax.reload();', "a reload of something else"],
    [
      'if (location.pathname.indexOf("/") < 0) document.forms[0].submit();',
      "a test with < that is false for this page",
    ],
    [
      "if (location.pathname.length > 4) document.forms[0].submit();",
      "a test with > that is false for this page",
    ],
    ["if (location.port === 443) document.forms[0].submit();", "=== between text and a number"],
    [
      'if (location.href.indexOf("/old/") !== -1) document.forms[0].submit();',
      "indexOf(...) !== -1, false for this page",
    ],
    ["false && document.forms[0].submit();", "a submit after && when the left side is false"],
    ['"x" ?? document.forms[0].submit();', "a submit after ?? when the left side is set"],
  ])("does not expect a move from %s (%s)", (script) => {
    expect(find(script)).toEqual(NONE);
  });

  it.each([
    [
      '(function () { if (document.cookie.includes("ok=1")) return; document.cookie = "ok=1"; location.reload(); })();',
      "a cookie check that returns early",
    ],
    ['document.cookie.includes("ok=1") || location.reload();', "a cookie check with ||"],
    [
      'if (window.document.cookie.indexOf("ok") < 0) { location.reload(); }',
      "a cookie check through window.document",
    ],
    ["null ?? document.forms[0].submit();", "a submit after ?? when the left side is null"],
    ['fetch("/api").then(() => { document.forms[0].submit(); });', "a submit in a callback"],
    [
      '$.get("/api", function () { document.getElementById("go").click(); });',
      "a click in a callback",
    ],
    [
      'Function(atob("bG9jYXRpb24uaHJlZiA9ICdodHRwczovL2Rlc3QuZXhhbXBsZS8nOw=="))();',
      "Function made from known text that moves the page on",
    ],
    ["new Function(\"location.href = '/x'\")();", "new Function made from such text"],
    [
      'if (location.pathname.startsWith("out", 1)) document.forms[0].submit();',
      "startsWith from a position, true for this page",
    ],
    [
      "var go = false; window.go = true; if (go) document.forms[0].submit();",
      "a global changed through window",
    ],
  ])("may move on: %s (%s)", (script) => {
    expect(find(script)).toEqual(MAYBE);
  });

  it("prefers a certain redirect to a possible one", () => {
    expect(find('location.reload(); location.href = "https://dest.test/";')).toEqual(
      redirect("https://dest.test/"),
    );
  });
});
