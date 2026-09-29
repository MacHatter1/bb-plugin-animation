// @vitest-environment node
/**
 * The sanitizer is a security boundary: `standalone.ts` exports a shareable
 * page that carries a real `<script>`, so anything that survives this function
 * runs on whoever opens that file. These cases are the attacks, not the tidy-up.
 */

import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../core/sanitizeHtml";

describe("sanitizeHtml", () => {
  it("keeps ordinary layout markup and its styling", () => {
    const out = sanitizeHtml(
      '<div class="phone" style="font-size:24px;color:var(--scene-tone)">' +
        "<span>add search filters</span></div>"
    );
    expect(out).toBe(
      '<div class="phone" style="font-size:24px;color:var(--scene-tone)">' +
        "<span>add search filters</span></div>"
    );
  });

  it("drops script elements together with their content", () => {
    expect(sanitizeHtml('<div>a<script>steal()</script>b</div>')).toBe(
      "<div>ab</div>"
    );
  });

  it("survives nested-tag smuggling that defeats regex stripping", () => {
    // A replace-based stripper reassembles this into a working <script>. The
    // tokenizer leaves only inert text, with no `<` left to form a tag.
    const out = sanitizeHtml("<scr<script>ipt>alert(1)</script>");
    expect(out).toBe("ipt&gt;alert(1)");
    expect(out).not.toContain("<");
  });

  it("escapes bare ampersands, which are a parse error inside foreignObject", () => {
    expect(sanitizeHtml("<div>tests &amp; docs &  more</div>")).toBe(
      "<div>tests &amp; docs &amp;  more</div>"
    );
  });

  it("drops event handler attributes but keeps the element", () => {
    expect(sanitizeHtml('<div onclick="alert(1)" class="ok">hi</div>')).toBe(
      '<div class="ok">hi</div>'
    );
  });

  it("rejects javascript: and expression() inside style", () => {
    expect(sanitizeHtml('<div style="background:url(javascript:alert(1))">x</div>')).toBe(
      "<div>x</div>"
    );
    expect(sanitizeHtml('<div style="width:expression(alert(1))">x</div>')).toBe(
      "<div>x</div>"
    );
  });

  it("allows inline-image and https urls in css but not arbitrary fetches", () => {
    expect(sanitizeHtml('<div style="background:url(https://a/b.png)">x</div>')).toContain(
      "https://a/b.png"
    );
    expect(sanitizeHtml('<div style="background:url(http://tracker/x.gif)">x</div>')).toBe(
      "<div>x</div>"
    );
  });

  it("constrains link and image targets", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="https://nimbalyst.com">x</a>')).toContain(
      'href="https://nimbalyst.com"'
    );
    expect(sanitizeHtml('<img src="data:text/html;base64,PHN2Zz4="/>')).toBe("<img/>");
  });

  it("drops unknown elements but keeps their text", () => {
    expect(sanitizeHtml("<marquee>text</marquee>")).toBe("text");
  });

  it("closes unclosed tags so foreignObject stays parseable as XML", () => {
    expect(sanitizeHtml("<div><span>x")).toBe("<div><span>x</span></div>");
  });

  it("ignores stray closing tags rather than emitting unbalanced markup", () => {
    expect(sanitizeHtml("</div>text")).toBe("text");
  });

  it("emits void elements self-closed", () => {
    expect(sanitizeHtml("<div>a<br>b</div>")).toBe("<div>a<br/>b</div>");
  });

  it("treats a bare less-than as text", () => {
    expect(sanitizeHtml("a < b")).toBe("a &lt; b");
  });

  it("strips comments", () => {
    expect(sanitizeHtml("<div><!-- note -->x</div>")).toBe("<div>x</div>");
  });

  it("carries the three sub-part attributes and no other data-*", () => {
    expect(
      sanitizeHtml(
        '<div class="scene-subpart" data-part="win/row.a" data-state="idle" ' +
          'data-tone="accent" data-secret="x">row</div>'
      )
    ).toBe(
      '<div class="scene-subpart" data-part="win/row.a" data-state="idle" ' +
        'data-tone="accent">row</div>'
    );
  });

  it("rewrites Nimbalyst anim-* class names and --anim-* tokens", () => {
    expect(
      sanitizeHtml(
        '<div class="anim-subpart phone" style="color:var(--anim-tone)">' +
          '<span class="anim-spin"></span></div>'
      )
    ).toBe(
      '<div class="scene-subpart phone" style="color:var(--scene-tone)">' +
        '<span class="scene-spin"></span></div>'
    );
  });

  it("leaves an existing entity in an attribute alone", () => {
    // `renderToStaticMarkup` writes `'` as `&#x27;`. Escaping the `&` again
    // made the browser render the literal characters and the font fall back.
    const react =
      "<span style=\"font-family:system-ui,&#x27;Segoe UI&#x27;,sans-serif\">a</span>";
    expect(sanitizeHtml(react)).toBe(react);
    // Sanitizing twice must not drift either.
    expect(sanitizeHtml(sanitizeHtml(react))).toBe(react);
  });

  it("still escapes a bare ampersand in an attribute", () => {
    expect(sanitizeHtml('<div title="a & b">x</div>')).toBe(
      '<div title="a &amp; b">x</div>'
    );
  });

  it("keeps a quote entity from breaking out of the attribute", () => {
    expect(sanitizeHtml('<div title="a&quot;b">x</div>')).toBe(
      '<div title="a&quot;b">x</div>'
    );
    // A raw quote arriving via single-quoted syntax is still escaped.
    expect(sanitizeHtml("<div title='a\"b'>x</div>")).toBe(
      '<div title="a&quot;b">x</div>'
    );
  });

  it("checks styles after character references decode", () => {
    // The browser turns `&#114;` into `r` before the CSS parser runs, so this
    // is `url(http://evil/x)` by the time anything fetches.
    for (const style of [
      "background:u&#114;l(http://evil/x)",
      "background:u&#x72;l(http://evil/x)",
      "background:&#117;rl(http://evil/x)",
      "background:url&#40;http://evil/x)",
    ]) {
      expect(sanitizeHtml(`<div style="${style}">x</div>`)).toBe("<div>x</div>");
    }
  });

  it("refuses references it cannot decode rather than guessing", () => {
    // `&lpar;` is `(` to a browser; unknown to the decoder, so refused.
    expect(
      sanitizeHtml('<div style="background:url&lpar;http://evil/x)">x</div>')
    ).toBe("<div>x</div>");
  });

  it("refuses CSS escapes, which can spell url( too", () => {
    expect(sanitizeHtml('<div style="background:u\\72l(http://evil/x)">x</div>')).toBe(
      "<div>x</div>"
    );
  });

  it("refuses image-set() and the other functions that fetch without url(", () => {
    for (const style of [
      "background:image-set('http://evil/y' 1x)",
      'background:-webkit-image-set("http://evil/y" 1x)',
      "background:cross-fade('http://evil/a', 'http://evil/b', 50%)",
      "background:image('http://evil/y')",
    ]) {
      expect(sanitizeHtml(`<div style="${style}">x</div>`)).toBe("<div>x</div>");
    }
    // A property whose name ends in "image" is not a function call.
    expect(
      sanitizeHtml('<div style="background-image:linear-gradient(red, blue)">x</div>')
    ).toContain("linear-gradient");
  });

  it("refuses a url() it cannot read", () => {
    expect(
      sanitizeHtml('<div style="background:url(\'https://a/b)c\')">x</div>')
    ).toBe("<div>x</div>");
  });

  it("allows https and inline-image urls, including ones written with entities", () => {
    expect(
      sanitizeHtml('<div style="background:url(&quot;https://a/b.png&quot;)">x</div>')
    ).toContain("https://a/b.png");
    expect(
      sanitizeHtml('<div style="background:url(data:image/png;base64,AAAA)">x</div>')
    ).toContain("data:image/png");
  });
});
