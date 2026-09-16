// @vitest-environment node
/**
 * Tests for the pure core. Nothing here touches a DOM, which is the point:
 * scrubbing, playback, the readout and (later) frame export are all the same
 * resolver, so covering the resolver covers all of them.
 *
 * The regressions these are written to catch:
 *  - a step's assignment silently clobbering a part it does not mention,
 *  - an agent's hand edit and the editor's own save producing different bytes,
 *  - the parser deleting content it did not understand.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../core/parse";
import { serializeDocument } from "../core/serialize";
import {
  nextChangeFor,
  positionAt,
  resolveAtStep,
  resolveAtTime,
  snapToFrame,
  snapToStepBoundary,
  startTimeOf,
  totalDuration,
} from "../core/timeline";
import { reorderStep, setStepDuration, MIN_DURATION_MS } from "../core/edits";
import {
  buildContextItems,
  buildSelectionReadout,
} from "../core/selectionContext";
import type { AnimDocument } from "../core/types";

const SAMPLE = `{
  "version": 1,
  "stage": { "width": 1080, "height": 470, "fps": 25 },
  "parts": {
    "store": { "type": "node", "label": "Object store", "x": 740, "y": 118, "w": 240, "h": 236 },
    "client": { "type": "node", "label": "Client", "x": 80, "y": 162, "w": 220, "h": 148 },
    "fetch": { "type": "edge", "from": "client", "to": "store", "text": "GET <sha>" }
  },
  "steps": [
    { "id": "idle", "duration": 800, "set": { "client": { "state": "active" } } },
    { "id": "request", "duration": 1200, "set": { "fetch": { "state": "flowing", "tone": "data" } } },
    { "id": "response", "duration": 1000, "set": { "store": { "state": "active", "tone": "accent" } } },
    { "id": "settle", "duration": 600 }
  ]
}`;

function sample(): AnimDocument {
  return parseDocument(SAMPLE).doc;
}

describe("parseDocument", () => {
  it("reads a well-formed document without complaint", () => {
    const { doc, problems } = parseDocument(SAMPLE);
    expect(problems).toEqual([]);
    expect(Object.keys(doc.parts)).toEqual(["store", "client", "fetch"]);
    expect(doc.steps.map((s) => s.id)).toEqual([
      "idle",
      "request",
      "response",
      "settle",
    ]);
    expect(totalDuration(doc)).toBe(3600);
  });

  it("repairs near-misses instead of refusing the file", () => {
    const { doc, problems } = parseDocument(`{
      "stage": { "width": "1080", "height": 470, "fps": 25 },
      "parts": { "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 } },
      "steps": [{ "id": "one", "duration": "900" }]
    }`);

    // A numeric string is a normal thing for a hand edit to produce.
    expect(doc.stage.width).toBe(1080);
    expect(doc.steps[0].duration).toBe(900);
    expect(doc.parts.a.type).toBe("node");
    expect(problems.some((p) => p.level === "error")).toBe(false);
  });

  it("previews an unsupported part type but marks the document unsafe to save", () => {
    const result = parseDocument(
      `{"version":2,"parts":{"a":{"type":"sprite","x":0,"y":0,"w":10,"h":10}},"steps":[]}`
    );
    expect(result.doc.parts.a.type).toBe("node");
    expect(
      result.problems.filter((problem) => problem.level === "error")
    ).toHaveLength(2);
    const serialized = JSON.parse(serializeDocument(result.doc, result.extras));
    expect(serialized.version).toBe(2);
    expect(serialized.parts.a.type).toBe("sprite");
  });

  it("keeps an assignment whose part no longer exists, and warns", () => {
    // The failure this guards: renaming a part, then having the editor quietly
    // delete every step that drove it on the next save.
    const { doc, problems } = parseDocument(`{
      "parts": { "kept": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 } },
      "steps": [{ "id": "s", "duration": 100, "set": { "gone": { "state": "active" } } }]
    }`);

    expect(doc.steps[0].set).toHaveProperty("gone");
    expect(problems.some((p) => p.path === "steps[0].set.gone")).toBe(true);
    // ...but it must not invent the missing part when resolving.
    expect(resolveAtStep(doc, 0).has("gone")).toBe(false);
  });

  it("renames duplicate step ids rather than losing a step", () => {
    const { doc, problems } = parseDocument(
      `{"parts":{},"steps":[{"id":"a","duration":100},{"id":"a","duration":200}]}`
    );
    expect(doc.steps.map((s) => s.id)).toEqual(["a", "a-2"]);
    expect(problems.some((p) => p.path === "steps[1].id")).toBe(true);
  });

  it("surfaces invalid JSON as an error rather than throwing", () => {
    const { doc, problems } = parseDocument("{ not json");
    expect(problems[0].level).toBe("error");
    expect(doc.steps).toEqual([]);
  });

  it("clamps an absurd duration into range", () => {
    const { doc, problems } = parseDocument(
      `{"parts":{},"steps":[{"id":"a","duration":-50}]}`
    );
    expect(doc.steps[0].duration).toBeGreaterThan(0);
    expect(problems.some((p) => p.path === "steps[0].duration")).toBe(true);
  });

  it("clamps invalid part dimensions before they reach SVG", () => {
    const { doc, problems } = parseDocument(
      `{"parts":{"a":{"type":"shape","x":0,"y":0,"w":-20,"h":0}},"steps":[]}`
    );
    expect(doc.parts.a).toMatchObject({ w: 1, h: 1 });
    expect(
      problems.filter((problem) => /parts\.a\.(w|h)/.test(problem.path))
    ).toHaveLength(2);
  });
});

describe("serializeDocument", () => {
  it("round-trips a document unchanged", () => {
    const { doc, extras } = parseDocument(SAMPLE);
    const once = serializeDocument(doc, extras);
    const twice = serializeDocument(
      parseDocument(once).doc,
      parseDocument(once).extras
    );
    expect(twice).toBe(once);
  });

  it("produces identical bytes regardless of key order in the source", () => {
    // This is the invariant that lets an agent edit the file by hand: its
    // output and the editor's must be the same, or every agent edit shows up as
    // a spurious diff on the next save.
    const shuffled = `{
      "steps": [{ "duration": 800, "id": "idle" }],
      "parts": { "b": { "y": 0, "x": 0, "h": 10, "w": 10, "type": "node" },
                 "a": { "type": "node", "x": 1, "y": 1, "w": 10, "h": 10 } },
      "stage": { "fps": 25, "height": 470, "width": 1080 },
      "version": 1
    }`;
    const ordered = `{
      "version": 1,
      "stage": { "width": 1080, "height": 470, "fps": 25 },
      "parts": { "a": { "type": "node", "x": 1, "y": 1, "w": 10, "h": 10 },
                 "b": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10 } },
      "steps": [{ "id": "idle", "duration": 800 }]
    }`;

    const a = parseDocument(shuffled);
    const b = parseDocument(ordered);
    expect(serializeDocument(a.doc, a.extras)).toBe(
      serializeDocument(b.doc, b.extras)
    );
  });

  it("preserves keys the current build does not model", () => {
    // Dropping an unrecognised field would be silent data loss the moment a
    // newer format version, or an agent, writes one.
    const withExtras = `{
      "version": 1,
      "futureRootKey": { "hello": true },
      "stage": { "width": 100, "height": 100, "fps": 25, "grid": 8 },
      "parts": { "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10, "opacity": 0.5,
        "rows": [{ "key": "status", "value": "ok", "futureRowKey": 7 }] } },
      "steps": [{ "id": "s", "duration": 100, "easing": "cubic-out",
        "set": { "a": { "transitionMs": 240 } } }]
    }`;
    const { doc, extras } = parseDocument(withExtras);
    const out = JSON.parse(serializeDocument(doc, extras));

    expect(out.futureRootKey).toEqual({ hello: true });
    expect(out.stage.grid).toBe(8);
    expect(out.parts.a.opacity).toBe(0.5);
    expect(out.parts.a.rows[0].futureRowKey).toBe(7);
    expect(out.steps[0].easing).toBe("cubic-out");
    expect(out.steps[0].set.a.transitionMs).toBe(240);
  });

  it("marks structurally invalid nested values unsafe to save", () => {
    const { problems } = parseDocument(`{
      "parts": { "a": { "type": "node", "x": 0, "y": 0, "w": 10, "h": 10, "rows": [false] } },
      "steps": [{ "id": "s", "duration": 100, "set": { "a": false } }]
    }`);
    expect(
      problems.filter((problem) => problem.level === "error")
    ).toHaveLength(2);
  });

  it("ends with exactly one trailing newline", () => {
    const text = serializeDocument(sample());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("timeline resolution", () => {
  it("accumulates state across steps rather than replacing it", () => {
    // A step says what changes; anything it does not mention must persist.
    // Getting this wrong makes every step need to restate the whole scene.
    const doc = sample();
    const atResponse = resolveAtStep(doc, 2);
    expect(atResponse.get("client")?.state).toBe("active"); // set back in step 0
    expect(atResponse.get("fetch")?.state).toBe("flowing"); // set in step 1
    expect(atResponse.get("store")?.state).toBe("active"); // set in step 2
  });

  it("holds the last step state at and past the end", () => {
    const doc = sample();
    const total = totalDuration(doc);
    expect(positionAt(doc, total).stepIndex).toBe(3);
    expect(positionAt(doc, total + 5000).stepIndex).toBe(3);
    expect(resolveAtTime(doc, total).get("store")?.state).toBe("active");
  });

  it("treats a boundary as belonging to the step that starts there", () => {
    const doc = sample();
    expect(positionAt(doc, 799).stepIndex).toBe(0);
    expect(positionAt(doc, 800).stepIndex).toBe(1);
    expect(positionAt(doc, 2000).stepIndex).toBe(2);
  });

  it("reports start times that match the running total", () => {
    const doc = sample();
    expect(startTimeOf(doc, 0)).toBe(0);
    expect(startTimeOf(doc, 2)).toBe(2000);
    expect(startTimeOf(doc, 4)).toBe(3600);
  });

  it("finds the next change so the readout can look ahead", () => {
    const doc = sample();
    const change = nextChangeFor(doc, "store", 0);
    expect(change?.step.id).toBe("response");
    expect(change?.time).toBe(2000);
    expect(change?.state.state).toBe("active");
    expect(nextChangeFor(doc, "store", 2)).toBeNull();
  });

  it("handles a document with no steps without dividing by zero", () => {
    const doc: AnimDocument = {
      version: 1,
      stage: { width: 10, height: 10, fps: 25 },
      parts: {},
      steps: [],
    };
    expect(totalDuration(doc)).toBe(0);
    expect(positionAt(doc, 500)).toEqual({
      time: 0,
      stepIndex: -1,
      offsetInStep: 0,
    });
  });

  it("snaps to whole frames", () => {
    const doc = sample(); // 25fps -> 40ms per frame
    expect(snapToFrame(doc, 1010)).toBe(1000);
    expect(snapToFrame(doc, 1030)).toBe(1040);
  });

  it("snaps Phase-1 seeking to the nearest settled step boundary", () => {
    const doc = sample();
    expect(snapToStepBoundary(doc, 300)).toBe(0);
    expect(snapToStepBoundary(doc, 600)).toBe(800);
    expect(snapToStepBoundary(doc, 1750)).toBe(2000);
    expect(snapToStepBoundary(doc, 99999)).toBe(3600);
  });
});

describe("edits", () => {
  it("retimes one step and leaves the others alone", () => {
    const doc = sample();
    const next = setStepDuration(doc, 1, 1400);
    expect(next.steps[1].duration).toBe(1400);
    expect(next.steps.map((s) => s.id)).toEqual(doc.steps.map((s) => s.id));
    expect(next.steps[2].duration).toBe(doc.steps[2].duration);
    // Ripple: total grows by the delta rather than stealing from a neighbour.
    expect(totalDuration(next)).toBe(totalDuration(doc) + 200);
  });

  it("refuses to drag a step below the minimum hittable width", () => {
    const doc = sample();
    expect(setStepDuration(doc, 0, -500).steps[0].duration).toBe(
      MIN_DURATION_MS
    );
  });

  it("leaves the document identical when a retime changes nothing", () => {
    // Identity matters: the editor uses it to avoid pushing a no-op undo entry.
    const doc = sample();
    expect(setStepDuration(doc, 0, doc.steps[0].duration)).toBe(doc);
  });

  it("reorders steps without losing any", () => {
    const doc = sample();
    const next = reorderStep(doc, 0, 2);
    expect(next.steps.map((s) => s.id)).toEqual([
      "request",
      "response",
      "idle",
      "settle",
    ]);
    expect(next.steps).toHaveLength(doc.steps.length);
  });
});

describe("selection context", () => {
  it("describes the selected part with its state now and its next change", () => {
    const doc = sample();
    const readout = buildSelectionReadout(doc, "store", 1400);
    expect(readout?.current.state).toBe("idle");
    expect(readout?.stepId).toBe("request");
    expect(readout?.next?.state.state).toBe("active");
    expect(readout?.next?.time).toBe(2000);
  });

  it("publishes a part chip and a step chip together", () => {
    // "Make this slower" is about the step; "make this red" is about the part.
    // The user says both without distinguishing, so both must be in context.
    const items = buildContextItems(sample(), "store", 1400);
    expect(items.map((i) => i.id)).toEqual([
      "scene-part:store",
      "scene-step:current",
    ]);
    expect(items[0].description).toContain('next becomes state "active"');
    expect(items[0].description).toContain("2.00s");
  });

  it("publishes only the step chip when nothing is selected", () => {
    const items = buildContextItems(sample(), null, 100);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("scene-step:current");
  });

  it("returns null for a part an agent deleted while it was selected", () => {
    expect(buildSelectionReadout(sample(), "ghost", 0)).toBeNull();
  });
});

/**
 * The shipped samples are hand-written, so they are the most likely documents in
 * the repo to be *almost* canonical -- a part inserted out of alphabetical order,
 * a key in the wrong slot. That costs nothing until someone opens one in the
 * editor, at which point the first save rewrites the whole file and buries the
 * real edit in a reformat diff. Cheaper to catch it here.
 */
describe("shipped samples", () => {
  const dir = join(__dirname, "../../samples");
  const files = readdirSync(dir).filter(
    (name) => name.endsWith(".scene.json") || name.endsWith(".anim.json"),
  );

  it("ships at least one sample", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s parses clean and is already canonical", (name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const { doc, extras, problems } = parseDocument(text);

    expect(problems).toEqual([]);
    expect(serializeDocument(doc, extras)).toBe(text);

    // Every edge endpoint resolves; a typo'd `from`/`to` renders as nothing at
    // all, which reads as a broken renderer rather than a broken document.
    for (const [id, part] of Object.entries(doc.parts)) {
      if (part.type !== "edge") continue;
      expect(doc.parts[part.from], `${id}.from`).toBeDefined();
      expect(doc.parts[part.to], `${id}.to`).toBeDefined();
    }

    // Likewise for a step assigning to a part that no longer exists.
    for (const step of doc.steps) {
      for (const partId of Object.keys(step.set ?? {})) {
        expect(
          doc.parts[partId],
          `step ${step.id} sets ${partId}`
        ).toBeDefined();
      }
    }
  });
});

/**
 * Markup sources for html parts.
 *
 * These cover the ways the feature fails silently: a part with no markup at all
 * drawing an empty box, a var breaking out of the partial it lands in, and a
 * save dropping the very fields that let the document stop needing a generator.
 */
describe("html part markup sources", () => {
  const parse = (part: Record<string, unknown>) =>
    parseDocument(
      JSON.stringify({
        version: 1,
        stage: { width: 100, height: 100, fps: 25 },
        parts: { a: { type: "html", x: 0, y: 0, w: 10, h: 10, ...part } },
        steps: [{ id: "s", duration: 100 }],
      })
    );

  it("keeps htmlFile and vars through a round-trip", () => {
    const source = parse({
      htmlFile: "./partials/window.html",
      vars: { workspace: "acme", model: "Claude Opus" },
    });
    expect(source.problems).toEqual([]);

    const text = serializeDocument(source.doc, source.extras);
    const again = parseDocument(text);
    expect(again.doc.parts.a).toEqual(source.doc.parts.a);
    expect(serializeDocument(again.doc, again.extras)).toBe(text);
  });

  it("needs at least one markup source", () => {
    const { doc, problems } = parse({});
    expect(doc.parts.a).toBeUndefined();
    expect(problems[0]).toMatchObject({ level: "error" });
  });

  it("warns but keeps both sources when htmlFile and html are set", () => {
    const { doc, problems } = parse({
      htmlFile: "./partials/card.html",
      html: "<b>hi</b>",
    });
    // Both survive the parse: precedence decides what draws, not what is kept,
    // so saving cannot delete markup the author can still see in the file.
    expect(doc.parts.a).toMatchObject({
      htmlFile: "./partials/card.html",
      html: "<b>hi</b>",
    });
    expect(problems[0].message).toContain("htmlFile and html");
  });

  it("drops non-scalar vars rather than stringifying them onto the stage", () => {
    const { doc, problems } = parse({
      html: "<b>{{title}}</b>",
      vars: { title: "ok", nested: { deep: 1 }, count: 4, flag: true },
    });
    expect((doc.parts.a as { vars?: Record<string, string> }).vars).toEqual({
      title: "ok",
      count: "4",
      flag: "true",
    });
    expect(problems[0].path).toBe("parts.a.vars.nested");
  });
});

/**
 * Component parts and the sub-parts they declare.
 *
 * The characteristic failure of this feature is silence: a step addressing a
 * region the component stopped emitting goes inert, and a recompile that
 * reorders or drops a generated field turns every later save into a spurious
 * diff. Both are covered here rather than left to a screenshot.
 */
describe("component parts", () => {
  const DOC = `{
  "version": 1,
  "stage": {
    "width": 100,
    "height": 100,
    "fps": 25,
    "theme": {
      "bg": "#0f172a",
      "accent": "#38bdf8",
      "--nim-panel": "#1e293b"
    }
  },
  "parts": {
    "chrome": {
      "type": "html",
      "x": 0,
      "y": 0,
      "w": 90,
      "h": 60,
      "component": "./components/SessionList.tsx",
      "props": {
        "workspace": "acme",
        "sessions": [
          {
            "id": "sync",
            "title": "Sync explainer"
          }
        ]
      },
      "subParts": {
        "sync": {
          "label": "Sync explainer",
          "tone": "accent"
        },
        "tracker": {}
      },
      "build": {
        "props": "a1f3c9",
        "source": "9c02be"
      },
      "html": "<div class=\\"scene-subpart\\" data-part=\\"chrome/sync\\">Sync explainer</div>"
    }
  },
  "steps": [
    {
      "id": "landed",
      "duration": 900,
      "set": {
        "chrome/sync": {
          "state": "active",
          "tone": "success"
        }
      }
    }
  ]
}
`;

  it("round-trips every generated field byte-identically", () => {
    // Props are carried by reference precisely so this holds: nothing here
    // rebuilds them, so a compile and a save cannot disagree about key order.
    const { doc, extras, problems } = parseDocument(DOC);
    expect(problems).toEqual([]);
    expect(serializeDocument(doc, extras)).toBe(DOC);
  });

  it("does not warn about a step addressing a declared sub-part", () => {
    const { problems } = parseDocument(DOC);
    expect(problems).toEqual([]);
  });

  it("warns when a step addresses a sub-part the component no longer emits", () => {
    // This is the format's characteristic silent failure: the step keeps
    // parsing, keeps serializing, and simply never does anything.
    const { problems } = parseDocument(
      DOC.replace('"chrome/sync": {', '"chrome/gone": {')
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("chrome/gone");
  });

  it("gives a sub-part its own baseline and resolves a step against it", () => {
    const { doc } = parseDocument(DOC);
    const before = resolveAtStep(doc, -1);
    expect(before.get("chrome/sync")).toEqual({
      state: "idle",
      tone: "accent",
    });
    // A sub-part with no declared tone inherits its container's, which is what
    // the missing `.scene-subpart` neutral rule expresses in CSS.
    expect(before.get("chrome/tracker")).toEqual({
      state: "idle",
      tone: "neutral",
    });
    expect(resolveAtStep(doc, 0).get("chrome/sync")).toEqual({
      state: "active",
      tone: "success",
    });
    // The container itself is untouched by an assignment to one of its regions.
    expect(resolveAtStep(doc, 0).get("chrome")).toEqual({
      state: "idle",
      tone: "neutral",
    });
  });

  it("puts a clicked sub-part into chat context, not just its container", () => {
    // `partIdFromEvent` closest()s to the nearest [data-part], which inside a
    // component is the sub-part. Looking that up in `doc.parts` finds nothing,
    // so the part chip vanished entirely and the agent was told only which step
    // was playing -- strictly less than it got before components existed.
    const { doc } = parseDocument(DOC);
    const items = buildContextItems(doc, "chrome/sync", 100);

    const part = items.find((item) => item.groupLabel === "parts");
    expect(part?.id).toBe("scene-part:chrome/sync");
    expect(part?.label).toBe("Sync explainer");
    // Its own state at the playhead, not the container's, which is still the
    // untouched idle/neutral baseline at this moment.
    expect(part?.description).toContain('state "active" with tone "success"');
    // The step that assigns the region is what "make this green sooner" needs.
    expect(part?.description).toContain("Steps that assign it: landed");
  });
});
