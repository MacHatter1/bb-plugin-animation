// @vitest-environment node
/**
 * Scene rendering is a pure string function, so it is cheap to pin the things
 * that would otherwise only fail visually:
 *  - every part carries the `data-part`/`data-state` hooks playback drives,
 *  - edge geometry works when nodes are stacked, not just side by side,
 *  - user text cannot break out of the markup.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PACKET_COUNT,
  PACKET_TRAVEL_S,
  escapeXml,
  renderPart,
  renderScene,
  sceneAriaLabel,
} from "../render/scene";
import { parseDocument } from "../core/parse";
import { serializeDocument } from "../core/serialize";
import { buildStandaloneDocument, buildTimeline } from "../render/standalone";
import type { AnimDocument } from "../core/types";
import { buildStageDocument } from "../render/stageDocument";
import { setStageAnimationsPaused } from "../render/stageDocument";
import { buildStageCss, FALLBACK_TOKENS } from "../render/stageCss";
import { resolveSiblingPath } from "../core/htmlParts";

function docOf(json: string): AnimDocument {
  return parseDocument(json).doc;
}

const TWO_NODES = `{
  "stage": { "width": 500, "height": 300, "fps": 25 },
  "parts": {
    "a": { "type": "node", "label": "Left", "x": 20, "y": 100, "w": 100, "h": 60 },
    "b": { "type": "node", "label": "Right", "x": 380, "y": 100, "w": 100, "h": 60 },
    "e": { "type": "edge", "from": "a", "to": "b", "text": "GET" }
  },
  "steps": [{ "id": "s", "duration": 100 }]
}`;

describe("renderScene", () => {
  it("tags every part with the attributes playback drives", () => {
    // Playback works by setting these attributes. If a part renders without
    // them it is invisible to the scheduler and simply never animates.
    const svg = renderScene(docOf(TWO_NODES));
    for (const id of ["a", "b", "e"]) {
      expect(svg).toContain(`data-part="${id}"`);
    }
    expect(svg.match(/data-state="idle"/g)).toHaveLength(3);
    expect(svg.match(/data-tone="neutral"/g)).toHaveLength(3);
  });

  it("draws edges behind nodes", () => {
    const svg = renderScene(docOf(TWO_NODES));
    expect(svg.indexOf('data-part="e"')).toBeLessThan(
      svg.indexOf('data-part="a"')
    );
  });

  it("uses canonical part order before and after serialization", () => {
    const source = `{"parts":{
      "z":{"type":"shape","x":0,"y":0,"w":20,"h":20},
      "a":{"type":"shape","x":0,"y":0,"w":20,"h":20}
    },"steps":[]}`;
    const parsed = parseDocument(source);
    const before = renderScene(parsed.doc);
    const after = renderScene(
      parseDocument(serializeDocument(parsed.doc, parsed.extras)).doc
    );
    expect(before.indexOf('data-part="a"')).toBeLessThan(
      before.indexOf('data-part="z"')
    );
    expect(after).toBe(before);
  });

  it("omits an edge whose endpoint does not exist", () => {
    // Rendering it anyway would draw a line to the origin, which reads as a
    // rendering bug rather than as a document problem.
    const svg = renderScene(
      docOf(
        `{"parts":{"e":{"type":"edge","from":"a","to":"missing"}},"steps":[]}`
      )
    );
    expect(svg).not.toContain('data-part="e"');
  });

  it("anchors a vertical edge to the horizontal borders", () => {
    // The classic bug here is assuming left-to-right and drawing through the
    // node body the first time someone stacks two boxes.
    const stacked = docOf(`{
      "parts": {
        "top": { "type": "node", "x": 100, "y": 0, "w": 100, "h": 50 },
        "bottom": { "type": "node", "x": 100, "y": 200, "w": 100, "h": 50 },
        "e": { "type": "edge", "from": "top", "to": "bottom" }
      },
      "steps": []
    }`);
    const svg = renderPart("e", stacked);
    // Centres are x=150; the line should run straight down between the facing
    // borders: y=50 (bottom of top) to y=200 (top of bottom).
    expect(svg).toContain("M150.0 50.0 L150.0 200.0");
  });

  it("escapes text so a label cannot break the markup", () => {
    const svg = renderScene(
      docOf(
        `{"parts":{"l":{"type":"label","x":0,"y":0,"text":"a <b> & \\"c\\""}},"steps":[]}`
      )
    );
    expect(svg).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).not.toContain("<b>");
  });

  it("escapes a part id used in an attribute", () => {
    const svg = renderScene(
      docOf(
        `{"parts":{"a\\"b":{"type":"node","x":0,"y":0,"w":10,"h":10}},"steps":[]}`
      )
    );
    expect(svg).toContain('data-part="a&quot;b"');
  });

  it("carries the stage viewBox", () => {
    expect(renderScene(docOf(TWO_NODES))).toContain('viewBox="0 0 500 300"');
  });

  it("does not let a background value escape the stage style block", () => {
    const doc = docOf(
      `{"stage":{"width":100,"height":100,"fps":25,"background":"red;}<\\/style><script>bad()<\\/script>"},"parts":{},"steps":[]}`
    );
    const html = buildStageDocument(doc, FALLBACK_TOKENS);
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain(`--scene-bg: ${FALLBACK_TOKENS.bg}`);
  });
});

describe("stage animation control", () => {
  it("pauses and resumes CSS transitions and packet animations together", () => {
    const animations = [
      { pause: vi.fn(), play: vi.fn() },
      { pause: vi.fn(), play: vi.fn() },
    ];
    const frameDoc = { getAnimations: () => animations } as unknown as Document;
    setStageAnimationsPaused(frameDoc, true);
    expect(
      animations.every((animation) => animation.pause.mock.calls.length === 1)
    ).toBe(true);
    setStageAnimationsPaused(frameDoc, false);
    expect(
      animations.every((animation) => animation.play.mock.calls.length === 1)
    ).toBe(true);
  });
});

describe("edge packets", () => {
  it("rides the same path the line is drawn from", () => {
    // If the packets and the line ever computed their geometry separately they
    // would drift apart on any change to the anchor maths, and the packets
    // would visibly travel beside the wire instead of along it.
    const svg = renderPart("e", docOf(TWO_NODES));
    const lineD = /class="scene-edge-line" d="([^"]+)"/.exec(svg)?.[1];
    expect(lineD).toBeTruthy();
    expect(svg).toContain(`offset-path: path('${lineD}')`);
  });

  it("staggers packets with negative delays so the wire starts full", () => {
    // A positive delay would leave the edge empty for a beat after it turns on.
    const svg = renderPart("e", docOf(TWO_NODES));
    const delays = [...svg.matchAll(/animation-delay: (-?[\d.]+)s/g)].map((m) =>
      Number(m[1])
    );
    expect(delays).toHaveLength(DEFAULT_PACKET_COUNT);
    expect(delays[0]).toBe(0);
    expect(delays.every((d) => d <= 0)).toBe(true);
    // Evenly spaced across one travel cycle.
    expect(delays[1]).toBeCloseTo(-PACKET_TRAVEL_S / DEFAULT_PACKET_COUNT, 3);
  });

  it("honours an explicit packet count", () => {
    const doc = docOf(`{
      "parts": {
        "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 },
        "b": { "type": "node", "x": 100, "y": 0, "w": 10, "h": 10 },
        "e": { "type": "edge", "from": "a", "to": "b", "packets": 6 }
      },
      "steps": []
    }`);
    // Matched with the closing quote so the `scene-edge-packets` group wrapper
    // is not counted as a seventh packet.
    expect(
      renderPart("e", doc).match(/class="scene-edge-packet"/g)
    ).toHaveLength(6);
  });

  it("omits packets entirely for an edge that carries no traffic", () => {
    // An edge can mean "relates to" rather than "sends to"; those should not
    // sprout moving squares.
    const doc = docOf(`{
      "parts": {
        "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 },
        "b": { "type": "node", "x": 100, "y": 0, "w": 10, "h": 10 },
        "e": { "type": "edge", "from": "a", "to": "b", "packets": 0 }
      },
      "steps": []
    }`);
    const svg = renderPart("e", doc);
    expect(svg).not.toContain("scene-edge-packet");
    expect(svg).toContain("scene-edge-line");
  });

  it("normalises the flow path so the reveal is length-independent", () => {
    // Without pathLength="1" the dash values are pixels, and the "reveal" turns
    // into a 1px dotted line -- which is exactly what it did before this.
    expect(renderPart("e", docOf(TWO_NODES))).toContain(
      'class="scene-edge-flow" pathLength="1"'
    );
  });

  it("round-trips the packet count through parse and serialize", () => {
    const { doc, extras } = parseDocument(
      `{"parts":{"a":{"type":"node","x":0,"y":0,"w":10,"h":10},` +
        `"b":{"type":"node","x":99,"y":0,"w":10,"h":10},` +
        `"e":{"type":"edge","from":"a","to":"b","packets":5}},"steps":[]}`
    );
    expect((doc.parts.e as { packets?: number }).packets).toBe(5);
    expect(JSON.parse(serializeDocument(doc, extras)).parts.e.packets).toBe(5);
  });
});

describe("html parts", () => {
  const HTML_DOC = `{
    "version": 1,
    "stage": { "width": 400, "height": 200, "fps": 25 },
    "parts": {
      "panel": { "type": "html", "tone": "accent", "x": 10, "y": 20, "w": 120, "h": 60,
                 "html": "<div style=\\"font-size:28px\\">Ship it</div>" }
    },
    "steps": [{ "id": "s", "duration": 100, "set": { "panel": { "state": "active" } } }]
  }`;

  it("renders through foreignObject with the playback hooks and the XHTML namespace", () => {
    const out = renderPart("panel", docOf(HTML_DOC));

    // Without the namespace the browser parses the subtree as SVG and shows nothing.
    expect(out).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(out).toContain("<foreignObject");
    expect(out).toContain('data-part="panel"');
    expect(out).toContain('data-tone="accent"');
    expect(out).toContain('transform="translate(10 20)"');
    // The whole point: the author's own type scale survives.
    expect(out).toContain("font-size:28px");
  });

  it("strips executable markup, because the standalone export runs scripts", () => {
    const doc = docOf(`{
      "version": 1,
      "stage": { "width": 400, "height": 200, "fps": 25 },
      "parts": {
        "x": { "type": "html", "x": 0, "y": 0, "w": 10, "h": 10,
               "html": "<div onclick=\\"steal()\\">hi<script>steal()</script></div>" }
      },
      "steps": []
    }`);
    const out = renderPart("x", doc);

    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("hi");
  });

  it("can anchor an edge, so a wire between two mocked-up screens draws", () => {
    const doc = docOf(`{
      "version": 1,
      "stage": { "width": 400, "height": 200, "fps": 25 },
      "parts": {
        "a": { "type": "html", "x": 0, "y": 0, "w": 100, "h": 100, "html": "<div>a</div>" },
        "b": { "type": "html", "x": 300, "y": 0, "w": 100, "h": 100, "html": "<div>b</div>" },
        "wire": { "type": "edge", "from": "a", "to": "b" }
      },
      "steps": []
    }`);

    // A dangling edge renders as nothing at all, so an empty string here would
    // be the silent failure this test exists to catch.
    expect(renderPart("wire", doc)).toContain("scene-edge-line");
  });

  it("round-trips canonically", () => {
    const parsed = parseDocument(HTML_DOC);
    expect(
      serializeDocument(parseDocument(serializeDocument(parsed.doc, parsed.extras)).doc, parsed.extras)
    ).toBe(serializeDocument(parsed.doc, parsed.extras));
  });
});

describe("sceneAriaLabel", () => {
  it("narrates the step captions so the animation is readable without sight", () => {
    const doc = docOf(`{
      "parts": { "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 } },
      "steps": [
        { "id": "one", "duration": 100, "caption": "It starts." },
        { "id": "two", "duration": 100, "caption": "It finishes." }
      ]
    }`);
    const label = sceneAriaLabel(doc);
    expect(label).toContain("1 parts");
    expect(label).toContain("2 steps");
    expect(label).toContain("It starts. It finishes.");
  });
});

describe("escapeXml", () => {
  it("escapes all five XML metacharacters", () => {
    expect(escapeXml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&apos;");
  });
});

describe("standalone export", () => {
  const EXPORTABLE = `{
    "version": 1,
    "stage": { "width": 100, "height": 100, "fps": 25 },
    "parts": {
      "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 },
      "b": { "type": "node", "x": 20, "y": 0, "w": 10, "h": 10 }
    },
    "steps": [
      { "id": "one", "duration": 500, "set": { "a": { "state": "active" } } },
      { "id": "two", "duration": 700, "set": { "b": { "state": "active", "tone": "success" } } }
    ]
  }`;

  function timelineOf(source: string) {
    return buildTimeline(parseDocument(source).doc);
  }

  it("makes the first entry complete and the rest deltas", () => {
    // The loop has no separate reset path: wrapping round re-applies entry 0.
    // If someone "optimises" entry 0 into a delta, playback silently smears the
    // end of one pass into the start of the next, and only on the second loop.
    const timeline = timelineOf(EXPORTABLE);

    expect(Object.keys(timeline[0].s).sort()).toEqual(["a", "b"]);
    // `a` did not change in step two, so it must not be re-asserted there.
    expect(Object.keys(timeline[1].s)).toEqual(["b"]);
    expect(timeline.map((entry) => entry.t)).toEqual([0, 500]);
  });

  it("cannot be broken out of by a part id containing a script tag", () => {
    // Part ids are user-authored and land inside a <script> block as JSON.
    const hostile = `{
      "version": 1,
      "stage": { "width": 10, "height": 10, "fps": 25 },
      "parts": { "</script><img src=x>": { "type": "node", "x": 0, "y": 0, "w": 1, "h": 1 } },
      "steps": [{ "id": "s", "duration": 100, "set": { "</script><img src=x>": { "state": "active" } } }]
    }`;
    const html = buildStandaloneDocument(parseDocument(hostile).doc, FALLBACK_TOKENS);

    const scriptBody = html.slice(html.indexOf("<script>"));
    expect(scriptBody.indexOf("</script>")).toBe(scriptBody.lastIndexOf("</script>"));
    expect(html).not.toContain("<img src=x>");
  });

  it("carries the scene, the theme and the total, with no external references", () => {
    const html = buildStandaloneDocument(parseDocument(EXPORTABLE).doc, FALLBACK_TOKENS, {
      title: "demo",
    });

    expect(html).toContain('data-part="a"');
    expect(html).toContain("--scene-tone-success");
    expect(html).toContain("var TOTAL = 1200;");
    expect(html).toContain("<title>demo</title>");
    // Self-contained is the whole point of the format.
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/);
  });
});

/**
 * Resolving an html part's markup.
 *
 * The failure these guard is the quiet kind: a var that changes the structure
 * of the partial it lands in, or an `htmlFile` whose markup never reaches the
 * scene because the caller forgot to hand its assets in.
 */
describe("html part resolution", () => {
  const docWith = (part: Record<string, unknown>): AnimDocument =>
    parseDocument(
      JSON.stringify({
        version: 1,
        stage: { width: 100, height: 100, fps: 25 },
        parts: { a: { type: "html", x: 0, y: 0, w: 10, h: 10, ...part } },
        steps: [{ id: "s", duration: 100 }],
      })
    ).doc;

  it("substitutes vars into a partial", () => {
    const svg = renderPart(
      "a",
      docWith({ html: "<h1>{{title}}</h1><p>{{subtitle}}</p>", vars: { title: "Ship it" } })
    );
    expect(svg).toContain("Ship it");
    // Unfilled placeholders resolve to empty, never to their own name.
    expect(svg).not.toContain("{{subtitle}}");
  });

  it("escapes var values so they cannot close the partial's elements", () => {
    const svg = renderPart(
      "a",
      docWith({
        html: "<div>{{title}}</div>",
        vars: { title: "</div><script>x()</script>" },
      })
    );
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;/div&gt;");
  });

  it("draws htmlFile markup only when its assets are supplied", () => {
    const doc = docWith({ htmlFile: "./parts/card.html" });
    expect(renderPart("a", doc)).not.toContain("from-a-file");
    const assets = new Map([["./parts/card.html", "<b>from-a-file</b>"]]);
    expect(renderPart("a", doc, assets)).toContain("from-a-file");
  });

  it("resolves htmlFile against the document, and refuses to escape upward", () => {
    expect(resolveSiblingPath("/w/anim/a.scene.json", "./parts/c.html")).toBe(
      "/w/anim/parts/c.html"
    );
    expect(resolveSiblingPath("/w/anim/a.scene.json", "../shared/c.html")).toBe(
      "/w/shared/c.html"
    );
    expect(resolveSiblingPath("/w/anim/a.scene.json", "/etc/passwd")).toBeNull();
  });
});

/**
 * The document's own palette.
 *
 * This is the check that would have caught the divergence it replaces: the
 * editor preview read the app's live `--nim-*` values while all three export
 * tools hardcoded `FALLBACK_TOKENS`, so the same document rendered two
 * different pictures depending on who asked. Both entry points now resolve the
 * same stamped object, so asserting they agree is asserting the bug is gone.
 */
describe("stage.theme", () => {
  const themed = (theme: Record<string, string>): AnimDocument =>
    parseDocument(
      JSON.stringify({
        version: 1,
        stage: { width: 100, height: 100, fps: 25, theme },
        parts: { a: { type: "html", x: 0, y: 0, w: 10, h: 10, html: "<b>x</b>" } },
        steps: [{ id: "s", duration: 100 }],
      })
    ).doc;

  it("overrides a stage token and carries a project's own custom property", () => {
    const doc = themed({ accent: "#38bdf8", "--nim-panel": "#1e293b" });
    const css = buildStageDocument(doc, FALLBACK_TOKENS);
    expect(css).toContain("--scene-tone-accent: #38bdf8");
    expect(css).toContain("--nim-panel: #1e293b");
    // Untouched tokens still come from the fallback.
    expect(css).toContain(`--scene-tone-success: ${FALLBACK_TOKENS.success}`);
  });

  it("gives the editor stage and the standalone export the same palette", () => {
    const doc = themed({ accent: "#38bdf8", bg: "#0f172a" });
    for (const declaration of [
      "--scene-tone-accent: #38bdf8",
      "--scene-bg: #0f172a",
    ]) {
      expect(buildStageDocument(doc, FALLBACK_TOKENS)).toContain(declaration);
      expect(
        buildStandaloneDocument(doc, FALLBACK_TOKENS)
      ).toContain(declaration);
    }
  });

  it("refuses a custom-property name that could close the declaration", () => {
    // Names are written straight into a <style> block, so an unvalidated one
    // would let a document open a rule of its own.
    const css = buildStageDocument(
      themed({ "--x: red; } body { display:none": "#fff", "--ok": "#abc" }),
      FALLBACK_TOKENS
    );
    expect(css).not.toContain("display:none");
    expect(css).toContain("--ok: #abc");
  });
});

/**
 * Sub-part styling.
 *
 * The probe behind this: a nested element carrying `class="scene-part"` with no
 * `data-tone` resets `--scene-tone` to neutral instead of inheriting, because
 * `.scene-part` sets that default unconditionally. Sub-parts get their own class
 * so "inherit unless overridden" is expressible at all.
 */
describe("scene-subpart rules", () => {
  const css = buildStageCss(FALLBACK_TOKENS);

  it("has no unconditional tone default, which is the whole point", () => {
    expect(css).toContain(".scene-part { --scene-tone: var(--scene-tone-neutral); }");
    expect(css).not.toContain(".scene-subpart { --scene-tone:");
    expect(css).not.toContain('.scene-subpart[data-tone="neutral"]');
  });

  it("resolves every other tone the way a top-level part does", () => {
    for (const tone of ["accent", "data", "success", "warning", "error", "muted"]) {
      expect(css).toContain(
        `.scene-subpart[data-tone="${tone}"]`
      );
    }
  });
});
