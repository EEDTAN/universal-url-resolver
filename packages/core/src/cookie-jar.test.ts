import { describe, expect, it } from "vitest";
import { CookieJar } from "./cookie-jar.ts";

const site = new URL("https://short.test/a");

function jarWith(...setCookies: string[]) {
  const jar = new CookieJar();
  jar.store(site, setCookies);
  return jar;
}

describe("CookieJar", () => {
  it("sends nothing before a cookie is set", () => {
    expect(new CookieJar().header(site)).toBeUndefined();
  });

  it("sends name=value pairs back without their attributes", () => {
    const jar = jarWith("a=1; Path=/; HttpOnly", "b = two words ; Secure");
    expect(jar.header(new URL("https://short.test/other/path"))).toBe("a=1; b=two words");
  });

  it("keeps everything after the first = as the value", () => {
    expect(jarWith("token=abc==; Path=/").header(site)).toBe("token=abc==");
  });

  it("replaces a cookie that is set again, and counts it as the newest", () => {
    expect(jarWith("a=1", "a=2").header(site)).toBe("a=2");
    expect(jarWith("a=1", "b=2", "a=3").header(site)).toBe("b=2; a=3");
  });

  it("keeps an origin's cookies under 8 KB by dropping the oldest", () => {
    const jar = new CookieJar();
    for (let i = 0; i < 100; i += 1) jar.store(site, [`c${i}=${"x".repeat(200)}`]);
    jar.store(site, ["check=1"]);
    const header = jar.header(site) ?? "";
    expect(header.length).toBeLessThanOrEqual(8 * 1024);
    expect(header).toMatch(/; check=1$/); // the newest cookie, the one a redirect checks, stays
    expect(header).toContain(`c99=${"x".repeat(200)}`);
    expect(header).not.toContain("c0=");
  });

  it("drops a single cookie that is larger than the limit by itself", () => {
    expect(jarWith(`big=${"x".repeat(9000)}`).header(site)).toBeUndefined();
  });

  it("limits each origin on its own", () => {
    const jar = jarWith(`a=${"x".repeat(8000)}`);
    jar.store(new URL("https://other.test/"), [`b=${"y".repeat(8000)}`]);
    expect(jar.header(site)).toBe(`a=${"x".repeat(8000)}`);
  });

  it.each([
    ["Max-Age=0"],
    ["max-age=-1"],
    ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
    ["Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=0"],
  ])("deletes a cookie with %s", (attributes) => {
    expect(jarWith("a=1", "b=2", `a=gone; ${attributes}`).header(site)).toBe("b=2");
  });

  it.each([
    ["Max-Age=60"],
    ["Expires=Thu, 01 Jan 2099 00:00:00 GMT"],
    ["Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
    ["Max-Age=soon"],
    ["Expires=not a date"],
    // Not cookie dates (no time of day), so ignored, as browsers do. Date.parse would accept them.
    ["Expires=0"],
    ["expires=-1"],
    ["Expires=01 Jan 1970"],
  ])("keeps a cookie with %s", (attributes) => {
    expect(jarWith(`a=1; ${attributes}`).header(site)).toBe("a=1");
  });

  it.each(["no-equals-sign", "=nameless", " =x", ""])("skips the malformed cookie %j", (line) => {
    expect(jarWith(line).header(site)).toBeUndefined();
  });

  it.each([
    "http://short.test/a",
    "https://short.test:8443/a",
    "https://sub.short.test/a",
    "https://other.test/a",
  ])("does not send a cookie to %s, another origin", (url) => {
    expect(jarWith("a=1; Domain=short.test").header(new URL(url))).toBeUndefined();
  });

  it("sends nothing once every cookie is deleted", () => {
    expect(jarWith("a=1", "a=; Max-Age=0").header(site)).toBeUndefined();
  });
});
