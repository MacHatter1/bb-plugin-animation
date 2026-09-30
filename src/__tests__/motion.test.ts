// @vitest-environment node
/**
 * Camera, stagger and the design notes.
 *
 * The notes matter most. The author of a scene is usually an agent that cannot
 * see it, so each rule has to fire on the fault, stay quiet on a good scene,
 * and hand back the exact value to set. These tests pin all three.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  WHOLE_STAGE,
  cameraAtStep,
  readingOrder,
  staggerDelays,
} from "../core/camera";
import { lintDocument, nodeHeightForRows } from "../core/lint";
import { LANE_GAP, routeEdge } from "../core/route";
import { parseDocument } from "../core/parse";
import { resolveAtStep } from "../core/timeline";
import { serializeDocument } from "../core/serialize";
import type { AnimDocument, NodePart } from "../core/types";
import { renderPart, renderScene } from "../render/scene";
import { buildStandaloneDocument, buildTimeline } from "../render/standalone";
import { FALLBACK_TOKENS } from "../render/stageCss";
import { DEFAULT_ANIMATION_JSON } from "../template";

const root = join(__dirname, "..", "..");

function docOf(value: unknown): AnimDocument {
  const { doc, problems } = parseDocument(JSON.stringify(value));
  expect(problems.filter((problem) => problem.level === "error")).toEqual([]);
  return doc;
}

function node(x: number, y = 190, extra: Record<string, unknown> = {}) {
  return { type: "node", x, y, w: 220, h: 144, ...extra };
}

/** Four boxes in a row on the recipe's grid. */
function row(steps: unknown[], parts: Record<string, unknown> = {}) {
  return docOf({
    stage: { width: 1200, height: 560, fps: 25 },
    parts: {
      a: node(60),
      b: node(350),
      c: node(640),
      d: node(930),
      ...parts,
    },
    steps,
  });
}

function rules(doc: AnimDocument): string[] {
  return lintDocument(doc).map((note) => note.rule);
}

function note(doc: AnimDocument, rule: string): string {
  const found = lintDocument(doc).find((item) => item.rule === rule);
  expect(found, `expected a "${rule}" note`).toBeDefined();
  return found?.message ?? "";
}

const STEP = { id: "s", duration: 2500, caption: "One short sentence here." };

describe("camera", () => {
  const view = (doc: AnimDocument, index: number) => {
    const camera = cameraAtStep(doc, index);
    const { width, height } = doc.stage;
    return {
      camera,
      left: -camera.x / camera.scale,
      top: -camera.y / camera.scale,
      right: (-camera.x + width) / camera.scale,
      bottom: (-camera.y + height) / camera.scale,
    };
  };

  it("shows the whole stage when a step has no focus", () => {
    const doc = row([STEP]);
    expect(cameraAtStep(doc, 0)).toEqual(WHOLE_STAGE);
    expect(cameraAtStep(doc, 7)).toEqual(WHOLE_STAGE);
  });

  it("frames the focused boxes with air, inside the stage", () => {
    const doc = row([{ ...STEP, focus: ["a", "b"] }]);
    const v = view(doc, 0);
    expect(v.camera.scale).toBeGreaterThan(1.5);
    expect(v.camera.scale).toBeLessThanOrEqual(MAX_ZOOM);
    // Both boxes (x 60..570, y 190..334) sit inside the view with a margin.
    expect(v.left).toBeLessThan(60);
    expect(v.right).toBeGreaterThan(570);
    expect(v.top).toBeLessThan(190);
    expect(v.bottom).toBeGreaterThan(334);
    expect(v.left).toBeGreaterThanOrEqual(0);
    expect(v.right).toBeLessThanOrEqual(1200);
  });

  it("never zooms past the limit, and never shows outside the stage", () => {
    const doc = row([{ ...STEP, focus: "tiny" }], {
      tiny: { type: "shape", x: 1170, y: 530, w: 20, h: 20 },
    });
    const v = view(doc, 0);
    expect(v.camera.scale).toBe(MAX_ZOOM);
    expect(v.right).toBeCloseTo(1200, 3);
    expect(v.bottom).toBeCloseTo(560, 3);
  });

  it("accepts one id, an edge, or a region inside an html part", () => {
    const doc = row(
      [
        { ...STEP, id: "one", focus: "b" },
        { ...STEP, id: "edge", focus: "e" },
        { ...STEP, id: "region", focus: "card/title" },
        { ...STEP, id: "missing", focus: "nope" },
      ],
      {
        e: { type: "edge", from: "a", to: "b" },
        card: { type: "html", x: 640, y: 380, w: 220, h: 100, html: "<p>x</p>" },
      }
    );
    // One box: tall enough that its height, not the zoom limit, sets the view.
    expect(cameraAtStep(doc, 0).scale).toBeGreaterThan(2);
    expect(cameraAtStep(doc, 0).scale).toBeLessThanOrEqual(MAX_ZOOM);
    expect(cameraAtStep(doc, 1)).toEqual(
      cameraAtStep(row([{ ...STEP, focus: ["a", "b"] }]), 0)
    );
    expect(cameraAtStep(doc, 2).scale).toBe(MAX_ZOOM);
    expect(cameraAtStep(doc, 3)).toEqual(WHOLE_STAGE);
  });

  it("falls back to the whole stage when the focus is most of it", () => {
    const doc = row([{ ...STEP, focus: ["a", "b", "c", "d"] }]);
    expect(cameraAtStep(doc, 0)).toEqual(WHOLE_STAGE);
  });
});

describe("stagger", () => {
  it("orders parts left to right, then top to bottom", () => {
    const doc = row([STEP], { under: node(60, 380) });
    expect(readingOrder(doc)).toEqual(["a", "under", "b", "c", "d"]);
  });

  it("starts each part a beat after the last, inside a fixed window", () => {
    expect(staggerDelays(0)).toEqual([]);
    expect(staggerDelays(1)).toEqual([0]);
    expect(staggerDelays(3)).toEqual([0, 70, 140]);
    const many = staggerDelays(12);
    expect(many[0]).toBe(0);
    expect(many[11]).toBe(280);
  });
});

describe("focus in the document", () => {
  const TEXT = `{
  "version": 1,
  "stage": {
    "width": 1200,
    "height": 560,
    "fps": 25
  },
  "parts": {
    "a": {
      "type": "node",
      "x": 60,
      "y": 190,
      "w": 220,
      "h": 144
    },
    "b": {
      "type": "node",
      "x": 350,
      "y": 190,
      "w": 220,
      "h": 144
    }
  },
  "steps": [
    {
      "id": "one",
      "duration": 2000,
      "caption": "Look at the first box.",
      "focus": "a",
      "set": {
        "a": {
          "state": "active"
        }
      }
    },
    {
      "id": "two",
      "duration": 2000,
      "caption": "Now look at both.",
      "focus": [
        "a",
        "b"
      ]
    }
  ]
}
`;

  it("round-trips in the form the author wrote", () => {
    const { doc, extras, problems } = parseDocument(TEXT);
    expect(problems).toEqual([]);
    expect(doc.steps[0].focus).toBe("a");
    expect(doc.steps[1].focus).toEqual(["a", "b"]);
    expect(serializeDocument(doc, extras)).toBe(TEXT);
  });

  it("warns about a focus it cannot use, and keeps it on save", () => {
    const unknown = parseDocument(
      JSON.stringify({ parts: {}, steps: [{ id: "s", duration: 800, focus: "ghost" }] })
    );
    expect(unknown.problems).toContainEqual(
      expect.objectContaining({ level: "warning", path: "steps[0].focus" })
    );

    const wrong = parseDocument(
      JSON.stringify({ parts: {}, steps: [{ id: "s", duration: 800, focus: 3 }] })
    );
    expect(wrong.doc.steps[0].focus).toBeUndefined();
    expect(
      JSON.parse(serializeDocument(wrong.doc, wrong.extras)).steps[0].focus
    ).toBe(3);
  });
});

describe("title labels", () => {
  const TEXT = `{
  "version": 1,
  "stage": {
    "width": 1200,
    "height": 560,
    "fps": 25
  },
  "parts": {
    "title": {
      "type": "label",
      "x": 60,
      "y": 56,
      "text": "Job queue with retry",
      "size": "title"
    }
  },
  "steps": []
}
`;

  it("round-trips and draws with the title style", () => {
    const { doc, extras, problems } = parseDocument(TEXT);
    expect(problems).toEqual([]);
    expect(serializeDocument(doc, extras)).toBe(TEXT);
    expect(renderPart("title", doc)).toContain('class="scene-part scene-label scene-label-title"');
  });

  it("keeps a size it does not know, and says so", () => {
    const { doc, extras, problems } = parseDocument(TEXT.replace('"title"\n    }', '"huge"\n    }'));
    expect(problems).toContainEqual(
      expect.objectContaining({ level: "warning", path: "parts.title.size" })
    );
    expect(renderPart("title", doc)).not.toContain("scene-label-title");
    expect(JSON.parse(serializeDocument(doc, extras)).parts.title.size).toBe("huge");
  });

  it("counts a title's real width when checking it fits the stage", () => {
    const doc = docOf({
      stage: { width: 400, height: 200, fps: 25 },
      parts: { t: { type: "label", x: 20, y: 40, text: "A heading that is far too long for this stage", size: "title" } },
      steps: [STEP],
    });
    expect(rules(doc)).toContain("off-stage");
  });
});

describe("scene and export", () => {
  it("wraps the scene in one camera group", () => {
    const svg = renderScene(row([STEP]));
    expect(svg).toMatch(/<svg[^>]*><g class="scene-camera">/);
    expect(svg.endsWith("</g></svg>")).toBe(true);
  });

  it("carries each step's caption and camera in the timeline", () => {
    const doc = row([
      { id: "one", duration: 2000, caption: "First.", set: { d: { state: "active" }, a: { state: "active" } } },
      { id: "two", duration: 2000, focus: ["a", "b"] },
    ]);
    const timeline = buildTimeline(doc);
    expect(timeline[0].cap).toBe("First.");
    expect(timeline[1].cap).toBeUndefined();
    expect(timeline[0].c).toEqual([1, 0, 0]);
    expect(timeline[1].c?.[0]).toBeGreaterThan(1);
    // Reading order, so the player staggers left to right.
    expect(Object.keys(timeline[0].s)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the camera out of the timeline when no step uses focus", () => {
    const timeline = buildTimeline(row([STEP]));
    expect(timeline[0].c).toBeUndefined();
  });

  it("shows captions and progress in the exported page", () => {
    const withCaptions = buildStandaloneDocument(row([STEP]), FALLBACK_TOKENS);
    expect(withCaptions).toContain('<div class="scene-caption-bar">');
    expect(withCaptions).toContain('<div class="scene-progress">');
    expect(withCaptions).toContain("var STAGGER = 70;");

    const silent = buildStandaloneDocument(
      row([{ id: "s", duration: 800 }]),
      FALLBACK_TOKENS
    );
    expect(silent).not.toContain('<div class="scene-caption-bar">');
    expect(silent).toContain('<div class="scene-progress">');
  });

  it("keeps caption text out of the markup, where it could not be escaped as script", () => {
    const html = buildStandaloneDocument(
      row([{ id: "s", duration: 2500, caption: "</script><img src=x onerror=1>" }]),
      FALLBACK_TOKENS
    );
    expect(html).not.toContain("<img src=x");
    const script = html.slice(html.indexOf("<script>"));
    expect(script.indexOf("</script>")).toBe(script.lastIndexOf("</script>"));
  });
});

describe("design notes: geometry", () => {
  it("agrees with the renderer about how tall a node must be", () => {
    for (const subtitle of [undefined, "SUB"]) {
      for (const count of [1, 3, 5]) {
        const rows = Array.from({ length: count }, (_, i) => ({ key: `k${i}` }));
        const part = { type: "node", x: 0, y: 0, w: 220, h: 0, subtitle, rows } as NodePart;
        const drawn = (h: number) =>
          (renderPart("n", docOf({ parts: { n: { ...part, h } }, steps: [] })).match(
            /class="scene-row"/g
          ) ?? []).length;
        const needed = nodeHeightForRows(part);
        expect(drawn(needed)).toBe(count);
        expect(drawn(needed - 1)).toBe(count - 1);
      }
    }
  });

  it("gives the exact height when rows do not fit", () => {
    const doc = docOf({
      parts: {
        n: node(60, 190, {
          h: 110,
          subtitle: "SUB",
          rows: [{ key: "a" }, { key: "b" }, { key: "c" }],
        }),
      },
      steps: [STEP],
    });
    expect(note(doc, "rows-clipped")).toBe(
      'Node "n" is 110 high, so only 1 of its 3 rows are drawn. Set "h": 176.'
    );
  });

  it("gives a width when text does not fit", () => {
    const doc = docOf({
      parts: {
        n: node(60, 190, {
          w: 140,
          rows: [{ key: "visibility", value: "thirty seconds" }],
        }),
      },
      steps: [STEP],
    });
    expect(note(doc, "text-fit")).toMatch(/is 140 wide .* Set "w": 230 /);
  });

  it("flags boxes that overlap, but not one inside another", () => {
    const overlapping = row([STEP], { e: node(200, 250) });
    expect(note(overlapping, "overlap")).toContain('"a" and "e"');

    const contained = row([STEP], {
      inside: { type: "shape", x: 80, y: 260, w: 40, h: 18 },
    });
    expect(rules(contained)).not.toContain("overlap");
  });

  it("flags a part that runs off the stage", () => {
    expect(note(row([STEP], { e: node(1100) }), "off-stage")).toContain('"e"');
  });

  it("flags an edge with a missing end, which draws nothing", () => {
    const doc = row([STEP], { e: { type: "edge", from: "a", to: "ghost" } });
    expect(note(doc, "edge-endpoint")).toContain('"ghost"');
  });

  it("has nothing to say about an edge that skips a box, because it arcs round it", () => {
    const doc = row([STEP], { e: { type: "edge", from: "a", to: "c", text: "a long label here" } });
    expect(rules(doc)).not.toContain("edge-crosses");
    // An arc's text sits in open space, so the gap between boxes does not limit it.
    expect(rules(doc)).not.toContain("edge-text-fit");
  });

  it("still flags an edge when neither side of the row has room for the arc", () => {
    const doc = row([STEP], {
      above: node(350, 30, { h: 120 }),
      below: node(350, 374, { h: 150 }),
      e: { type: "edge", from: "a", to: "c" },
    });
    expect(note(doc, "edge-crosses")).toContain('Edge "e" from "a" to "c" still runs through');
  });

  it("spreads a row of three out when that makes the text fit", () => {
    const doc = docOf({
      stage: { width: 1200, height: 560, fps: 25 },
      parts: {
        a: node(60),
        b: node(350),
        c: node(640),
        e: { type: "edge", from: "a", to: "b", text: "authorization code" },
      },
      steps: [STEP],
    });
    expect(note(doc, "edge-text-fit")).toContain(
      'Spread the row out so the text fits: move "a" to "x": 60, "b" to "x": 490, "c" to "x": 920.'
    );
    // Apply it and the note is gone.
    const spread = docOf({
      stage: { width: 1200, height: 560, fps: 25 },
      parts: {
        a: node(60),
        b: node(490),
        c: node(920),
        e: { type: "edge", from: "a", to: "b", text: "authorization code" },
      },
      steps: [STEP],
    });
    expect(rules(spread)).not.toContain("edge-text-fit");
  });

  it("flags edge text wider than the gap it sits in", () => {
    const doc = row([STEP], {
      e: { type: "edge", from: "a", to: "b", text: "acknowledge" },
    });
    expect(note(doc, "edge-text-fit")).toMatch(
      /gap of 70 but its text "acknowledge" needs 100.*Shorten the text to 6 characters or fewer/
    );
    const short = row([STEP], { e: { type: "edge", from: "a", to: "b", text: "ack" } });
    expect(rules(short)).not.toContain("edge-text-fit");
  });
});

describe("edge routing", () => {
  const route = (doc: AnimDocument, id: string) => {
    const found = routeEdge(doc, id);
    expect(found).not.toBeNull();
    return found!;
  };

  it("draws neighbours as one straight line between their facing sides", () => {
    const r = route(row([STEP], { e: { type: "edge", from: "a", to: "b" } }), "e");
    expect(r.kind).toBe("straight");
    expect(r.d).toBe("M280.0 262.0 L350.0 262.0");
    expect(r.gap).toBe(70);
    expect(r.angle).toBe(0);
  });

  it("gives a request and its reply their own lanes", () => {
    const doc = row([STEP], {
      request: { type: "edge", from: "a", to: "b" },
      reply: { type: "edge", from: "b", to: "a" },
    });
    const request = route(doc, "request");
    const reply = route(doc, "reply");
    expect(request.kind).toBe("straight");
    expect(Math.abs(request.label.y - reply.label.y)).toBe(LANE_GAP);
    // Same two x positions, opposite directions.
    expect(request.end.x).toBe(350);
    expect(reply.end.x).toBe(280);
    expect(rules(doc)).toEqual([]);
  });

  it("arcs over the row going forwards and under it coming back", () => {
    const doc = row([STEP], {
      out: { type: "edge", from: "a", to: "c" },
      back: { type: "edge", from: "c", to: "a" },
    });
    const out = route(doc, "out");
    const back = route(doc, "back");
    expect(out.kind).toBe("arc");
    expect(out.d).toMatch(/^M[\d. ]+ C/);
    expect(out.through).toEqual([]);
    // Row is y 190..334: the forward arc peaks above it, the reply below it.
    expect(out.label.y).toBeLessThan(190);
    expect(back.label.y).toBeGreaterThan(334);
    // Each arrives end-on: straight down into the top, straight up into the bottom.
    expect(out.angle).toBeCloseTo(90, 0);
    expect(back.angle).toBeCloseTo(-90, 0);
  });

  it("takes the other side when the preferred one is off the stage", () => {
    const doc = docOf({
      stage: { width: 1200, height: 560, fps: 25 },
      parts: { a: node(60, 20), b: node(350, 20), c: node(640, 20), e: { type: "edge", from: "a", to: "c" } },
      steps: [STEP],
    });
    expect(route(doc, "e").label.y).toBeGreaterThan(164);
  });

  it("draws the arc the router describes, and frames it with the camera", () => {
    const doc = row([{ ...STEP, focus: "e" }], { e: { type: "edge", from: "a", to: "c" } });
    const r = route(doc, "e");
    expect(renderPart("e", doc)).toContain(`d="${r.d}"`);
    const camera = cameraAtStep(doc, 0);
    const top = -camera.y / camera.scale;
    expect(top).toBeLessThanOrEqual(r.bounds.y);
  });

  it("hides an edge while either of its ends is hidden, then restores it", () => {
    const doc = row(
      [
        { ...STEP, id: "before", set: { e: { state: "flowing", tone: "accent" } } },
        { ...STEP, id: "reveal", set: { b: { state: "idle" } } },
      ],
      { b: node(350, 190, { state: "hidden" }), e: { type: "edge", from: "a", to: "b" } }
    );
    expect(resolveAtStep(doc, -1).get("e")?.state).toBe("hidden");
    expect(resolveAtStep(doc, 0).get("e")).toEqual({ state: "hidden", tone: "accent" });
    // Once both ends are on stage the edge is back in the state it was given.
    expect(resolveAtStep(doc, 1).get("e")).toEqual({ state: "flowing", tone: "accent" });
    // The export's timeline carries the same thing, so it never draws the orphan.
    expect(buildTimeline(doc)[0].s.e).toEqual(["hidden", "accent"]);
    expect(buildTimeline(doc)[1].s.e).toEqual(["flowing", "accent"]);
  });

  it("keeps an edge off stage until the step that first lights it", () => {
    const doc = row(
      [
        { ...STEP, id: "s0", set: { a: { state: "active" } } },
        { ...STEP, id: "s1", set: { later: { state: "flowing" } } },
        { ...STEP, id: "s2", set: { later: { state: "idle" } } },
      ],
      {
        later: { type: "edge", from: "a", to: "b" },
        placed: { type: "edge", from: "b", to: "c", state: "idle" },
        fixed: { type: "edge", from: "c", to: "d", packets: 0 },
      }
    );
    const at = (index: number, id: string) => resolveAtStep(doc, index).get(id)?.state;
    // Lit at s1: hidden until then, and it stays on stage once it has been used.
    expect([at(-1, "later"), at(0, "later"), at(1, "later"), at(2, "later")]).toEqual([
      "hidden",
      "hidden",
      "flowing",
      "idle",
    ]);
    // An explicit state was placed on purpose, and a never-lit edge is a fixed
    // relationship: both show from the start.
    expect(at(-1, "placed")).toBe("idle");
    expect(at(-1, "fixed")).toBe("idle");
  });

  it("shows an edge early when a step sets it before lighting it", () => {
    const doc = row(
      [
        { ...STEP, id: "s0", set: { e: { state: "idle" } } },
        { ...STEP, id: "s1", set: { e: { state: "flowing" } } },
      ],
      { e: { type: "edge", from: "a", to: "b" } }
    );
    expect(resolveAtStep(doc, -1).get("e")?.state).toBe("hidden");
    expect(resolveAtStep(doc, 0).get("e")?.state).toBe("idle");
  });

  it("returns nothing for an edge with a missing end", () => {
    const doc = row([STEP], { e: { type: "edge", from: "a", to: "ghost" } });
    expect(routeEdge(doc, "e")).toBeNull();
    expect(renderPart("e", doc)).toBe("");
  });
});

describe("design notes: states and pacing", () => {
  it("catches a state that is a typo, in a part or a step", () => {
    const doc = row([{ ...STEP, set: { a: { state: "activ" } } }], {
      e: { type: "edge", from: "a", to: "b", state: "flowin" },
    });
    const messages = lintDocument(doc)
      .filter((item) => item.rule === "unknown-state")
      .map((item) => item.message);
    expect(messages).toHaveLength(2);
    expect(messages.join(" ")).toContain("idle, active, waiting, offline, hidden");
    expect(messages.join(" ")).toContain("idle, flowing, returning, active, hidden");
  });

  it("lists every rushed caption in one note, with the duration each needs", () => {
    const doc = row([
      { id: "one", duration: 900, caption: "A read arrives for an order the service has served before." },
      { id: "two", duration: 1000, caption: "The service asks the cache for the key." },
      { id: "fine", duration: 1700, caption: "The key is not there." },
    ]);
    const notes = lintDocument(doc).filter((item) => item.rule === "caption-rushed");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('"one": 3300, "two": 2500');
    expect(notes[0].message).not.toContain('"fine"');
  });

  it("flags missing and overlong captions, and steps too short or long", () => {
    const doc = row([
      { id: "silent", duration: 2000 },
      { id: "essay", duration: 9000, caption: Array(18).fill("word").join(" ") },
      { id: "blink", duration: 300, set: { a: { state: "active" } } },
    ]);
    const found = rules(doc);
    expect(found).toEqual(
      expect.arrayContaining(["caption-missing", "caption-long", "step-short", "step-long"])
    );
    expect(note(doc, "caption-missing")).toContain('"silent", "blink"');
  });
});

describe("design notes: story", () => {
  const caption = "One short sentence here.";

  it("asks for a reveal and a camera move when everything is visible and still", () => {
    const doc = row(
      [1, 2, 3, 4].map((n) => ({
        id: `s${n}`,
        duration: 2500,
        caption,
        set: n === 2 ? { b: { state: "active" } } : n === 3 ? { b: { state: "idle" } } : {},
      })),
      { e: node(60, 380) }
    );
    expect(note(doc, "reveal")).toContain("All 5 boxes are on screen from the first frame");
    expect(note(doc, "focus")).toContain('add "focus": "b" to step "s2"');
  });

  it("is satisfied once parts are revealed and a step has focus", () => {
    const doc = row(
      [
        { id: "s1", duration: 2500, caption },
        { id: "s2", duration: 2500, caption, focus: "b", set: { e: { state: "idle" } } },
        { id: "s3", duration: 2500, caption },
        { id: "s4", duration: 2500, caption, set: { a: { state: "active" } } },
      ],
      { e: node(60, 380, { state: "hidden" }) }
    );
    expect(lintDocument(doc)).toEqual([]);
  });

  it("asks for both ends of a lit edge to be in frame, and gives the focus list", () => {
    const edge = { e: { type: "edge", from: "a", to: "b" } };
    const cut = row([{ ...STEP, focus: "b", set: { e: { state: "flowing" } } }], edge);
    expect(note(cut, "focus-cuts-edge")).toContain('Set "focus": ["b", "a"].');

    const framed = row(
      [{ ...STEP, focus: ["a", "b"], set: { e: { state: "flowing" } } }],
      edge
    );
    expect(rules(framed)).not.toContain("focus-cuts-edge");
  });

  it("suggests a focus that includes the ends of the edge a step lights", () => {
    const doc = row(
      [
        { id: "s1", duration: 2500, caption },
        { id: "s2", duration: 2500, caption, set: { e: { state: "flowing" }, b: { state: "active" } } },
        { id: "s3", duration: 2500, caption, set: { e: { state: "idle" } } },
        { id: "s4", duration: 2500, caption },
      ],
      { e: { type: "edge", from: "a", to: "b" }, extra: node(60, 380) }
    );
    expect(note(doc, "focus")).toContain('add "focus": ["a", "b"] to step "s2"');
  });

  it("flags rows that read as a status, since text never changes", () => {
    const doc = docOf({
      parts: {
        auth: node(60, 190, {
          rows: [
            { key: "user", value: "verified" },
            { key: "issuer", value: "accounts.example" },
            { key: "tokens", value: "Issued" },
          ],
          h: 160,
        }),
      },
      steps: [STEP],
    });
    const message = note(doc, "row-status");
    expect(message).toContain('"user: verified", "tokens: Issued"');
    expect(message).not.toContain("issuer");
  });

  it("flags an ending with nothing lit, and names the box to keep", () => {
    const doc = row([
      { id: "one", duration: 2500, caption, set: { a: { state: "active" } } },
      { id: "two", duration: 2500, caption, set: { a: { state: "idle" }, c: { state: "active" } } },
      { id: "end", duration: 2500, caption, set: { c: { state: "idle" } } },
    ]);
    expect(note(doc, "end-empty")).toContain('in step "end", leave "c" as "active"');
    // A scene that never lit anything has no outcome to keep.
    expect(rules(row([STEP, { ...STEP, id: "t" }]))).not.toContain("end-empty");
  });

  it("compares the length with the one asked for, when there is one", () => {
    const doc = row(
      Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, duration: 2500, caption })),
    );
    const lengthOf = (targetSeconds?: number) =>
      lintDocument(doc, { targetSeconds }).filter((item) => item.rule === "length");
    expect(lengthOf()).toEqual([]);
    expect(lengthOf(20)).toEqual([]);
    expect(lengthOf(22)).toEqual([]);
    expect(lengthOf(23)).toHaveLength(1);
    expect(lengthOf(30)[0].message).toContain("runs 20.0s but 30s was asked for. Add about 4 more steps");
    expect(lengthOf(10)[0].message).toContain("merge about 4 steps");
  });

  it("asks for the box a lit edge runs into to react", () => {
    const edge = { e: { type: "edge", from: "a", to: "b" } };
    const dim = row([{ ...STEP, set: { e: { state: "flowing", tone: "success" } } }], edge);
    expect(note(dim, "edge-target-idle")).toContain(
      'add "b": { "state": "active", "tone": "success" } to this step\'s "set"'
    );
    // A reply arrives at the box it started from.
    const reply = row([{ ...STEP, set: { e: { state: "returning" } } }], edge);
    expect(note(reply, "edge-target-idle")).toContain('into "a"');
    // Lit, waiting or offline all count as reacting.
    for (const state of ["active", "waiting", "offline"]) {
      const lit = row([{ ...STEP, set: { e: { state: "flowing" }, b: { state } } }], edge);
      expect(rules(lit)).not.toContain("edge-target-idle");
    }
  });

  it("flags a step where the picture stands still", () => {
    const doc = row([
      { id: "one", duration: 2500, caption, set: { a: { state: "active" } } },
      { id: "empty", duration: 2500, caption },
      { id: "noop", duration: 2500, caption, set: { a: { state: "active" } } },
      { id: "moves", duration: 2500, caption, focus: "b" },
      { id: "busy", duration: 2500, caption, focus: "b", set: { b: { state: "active" } } },
    ]);
    const stuck = lintDocument(doc).filter((item) => item.rule === "step-static");
    expect(stuck.map((item) => item.path)).toEqual(["steps[1]", "steps[2]"]);
    expect(stuck[0].message).toContain('Step "empty" changes nothing on screen');
  });

  it("counts a change outside the zoomed frame as no change", () => {
    const doc = row(
      [
        { id: "one", duration: 2500, caption, focus: "a", set: { a: { state: "active" } } },
        { id: "two", duration: 2500, caption, focus: "a", set: { rail: { state: "active" } } },
      ],
      { rail: { type: "label", x: 980, y: 470, text: "05 DONE", caps: true } }
    );
    expect(note(doc, "step-static")).toContain(
      'Step "two" only changes "rail", which is outside the zoomed frame'
    );
  });

  it("flags a part that is hidden and never shown", () => {
    const doc = row([STEP], { ghost: node(60, 380, { state: "hidden" }) });
    expect(note(doc, "never-shown")).toContain('"ghost"');
  });

  it("flags a step that changes too much at once", () => {
    const parts = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `dot${i}`,
        { type: "shape", x: 60 + i * 40, y: 400, w: 20, h: 20 },
      ])
    );
    const set = Object.fromEntries(Object.keys(parts).map((id) => [id, { state: "active" }]));
    const doc = row([{ ...STEP, set }], parts);
    expect(note(doc, "step-busy")).toContain("changes 7 parts at once");
  });

  it("flags a loud start and a busy ending", () => {
    const all = { a: { state: "active" }, b: { state: "active" }, c: { state: "active" }, d: { state: "active" } };
    const doc = row(
      [
        { id: "first", duration: 2500, caption, set: all },
        { id: "last", duration: 2500, caption, set: { e: { state: "flowing" } } },
      ],
      { e: { type: "edge", from: "a", to: "b" } }
    );
    expect(note(doc, "start-loud")).toContain("lights 4 parts");
    const endings = lintDocument(doc)
      .filter((item) => item.rule === "end-busy")
      .map((item) => item.message);
    expect(endings).toHaveLength(2);
    expect(endings[0]).toContain('edge "e" still flowing');
    expect(endings[1]).toContain("4 nodes lit");
  });
});

describe("what the plugin ships follows its own rules", () => {
  const samples = readdirSync(join(root, "samples")).filter((name) =>
    name.endsWith(".scene.json")
  );

  it.each(samples)("samples/%s has no design notes", (name) => {
    const { doc, problems } = parseDocument(
      readFileSync(join(root, "samples", name), "utf8")
    );
    expect(problems).toEqual([]);
    expect(lintDocument(doc)).toEqual([]);
  });

  it("the starter scene has no design notes", () => {
    expect(lintDocument(parseDocument(DEFAULT_ANIMATION_JSON).doc)).toEqual([]);
  });

  it("the skill's worked example is the shipped sample, so it stays valid", () => {
    const skill = readFileSync(join(root, "skills/animation/SKILL.md"), "utf8");
    const example = skill.slice(skill.indexOf("## Worked example"));
    const block = /```json\n([\s\S]*?)```/.exec(example);
    expect(block?.[1]).toBe(
      readFileSync(join(root, "samples/retry.scene.json"), "utf8")
    );
  });

  it("the recipe's one-row grid draws clean", () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `key${i}`, value: "value" }));
    const doc = docOf({
      stage: { width: 1200, height: 560, fps: 25 },
      parts: {
        title: { type: "label", x: 60, y: 56, text: "A title for the scene" },
        tagline: { type: "label", x: 60, y: 80, text: "A TAGLINE IN CAPS", caps: true },
        n1: node(60, 190, { w: 195, subtitle: "SUB", rows: rowsOf(2) }),
        n2: node(355, 190, { w: 195, subtitle: "SUB", rows: rowsOf(2) }),
        n3: node(650, 190, { w: 195, subtitle: "SUB", rows: rowsOf(2) }),
        n4: node(945, 190, { w: 195, subtitle: "SUB", rows: rowsOf(2) }),
        e1: { type: "edge", from: "n1", to: "n2", text: "ten chars!" },
        e2: { type: "edge", from: "n2", to: "n3", text: "push" },
        e3: { type: "edge", from: "n3", to: "n4" },
        ...Object.fromEntries(
          [60, 290, 520, 750, 980].map((x, i) => [
            `rail${i}`,
            { type: "label", x, y: 470, text: `0${i + 1} STAGE NAME`, caps: true },
          ])
        ),
      },
      steps: [STEP],
    });
    expect(lintDocument(doc)).toEqual([]);
  });

  it.each([
    { xs: [250, 730], text: "a".repeat(31) },
    { xs: [60, 490, 920], text: "a".repeat(24) },
    { xs: [60, 355, 650, 945], text: "a".repeat(10), w: 195 },
  ])("the recipe's grid for $xs.length boxes fits its edge text", ({ xs, text, w }) => {
    const parts: Record<string, unknown> = {};
    xs.forEach((x, i) => {
      parts[`n${i}`] = node(x, 190, w ? { w } : {});
      if (i > 0) parts[`e${i}`] = { type: "edge", from: `n${i - 1}`, to: `n${i}`, text };
    });
    const doc = docOf({ stage: { width: 1200, height: 560, fps: 25 }, parts, steps: [STEP] });
    expect(lintDocument(doc)).toEqual([]);
    // One character more does not fit, so the table's limit is the real one.
    (parts.e1 as { text: string }).text = `${text}a`;
    const over = docOf({ stage: { width: 1200, height: 560, fps: 25 }, parts, steps: [STEP] });
    expect(rules(over)).toContain("edge-text-fit");
  });

  it("the recipe's two-row grid draws clean", () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `key${i}`, value: "value" }));
    const xs = [60, 350, 640, 930];
    const parts: Record<string, unknown> = {};
    xs.forEach((x, i) => {
      parts[`top${i}`] = node(x, 150, { subtitle: "SUB", rows: rowsOf(2) });
      parts[`low${i}`] = node(x, 370, { subtitle: "SUB", rows: rowsOf(2), state: "hidden" });
      parts[`down${i}`] = { type: "edge", from: `top${i}`, to: `low${i}` };
    });
    parts.rail = { type: "label", x: 60, y: 620, text: "01 STAGE", caps: true };
    const doc = docOf({
      stage: { width: 1200, height: 700, fps: 25 },
      parts,
      steps: [
        { ...STEP, id: "s1" },
        { ...STEP, id: "s2", focus: ["top0", "low0"], set: Object.fromEntries(xs.map((_, i) => [`low${i}`, { state: "idle" }])) },
        { ...STEP, id: "s3" },
        { ...STEP, id: "s4", set: { top0: { state: "active" } } },
      ],
    });
    expect(lintDocument(doc)).toEqual([]);
  });
});
