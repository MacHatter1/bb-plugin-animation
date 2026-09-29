// @vitest-environment node
/**
 * Keyboard and drag rules. The shortcut cases are the ones that used to go
 * dead: after pressing Play (focus on a button) and after clicking the stage
 * (focus inside the iframe, a different realm). The drag cases pin that a
 * cancelled gesture edits nothing.
 */

import { describe, expect, it } from "vitest";
import {
  draggedDuration,
  editorShortcut,
  focusKind,
  RetimeDrag,
  type KeyPress,
} from "../components/editorInput";
import { setStepDuration } from "../core/edits";
import { parseDocument } from "../core/parse";
import type { AnimDocument } from "../core/types";

function key(partial: Partial<KeyPress>): KeyPress {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...partial,
  };
}

const SAVE = key({ key: "s", metaKey: true });
const UNDO = key({ key: "z", metaKey: true });
const REDO = key({ key: "Z", metaKey: true, shiftKey: true });
const SPACE = key({ key: " ", code: "Space" });

/**
 * A stand-in element that matches selectors naming its tag. A plain object,
 * like an element from another realm: `instanceof Element` would miss it.
 */
function element(tag: string) {
  return {
    closest: (selector: string) =>
      selector.split(",").some((part) => part.trim().startsWith(tag))
        ? {}
        : null,
  };
}

describe("editorShortcut", () => {
  it("maps save, undo, redo and play", () => {
    expect(editorShortcut(SAVE, "other")).toBe("save");
    expect(editorShortcut(key({ key: "s", ctrlKey: true }), "other")).toBe("save");
    expect(editorShortcut(UNDO, "other")).toBe("undo");
    expect(editorShortcut(REDO, "other")).toBe("redo");
    expect(editorShortcut(SPACE, "other")).toBe("toggle");
    expect(editorShortcut(key({ key: "a" }), "other")).toBeNull();
  });

  it("keeps save and undo working while a transport button has focus", () => {
    expect(editorShortcut(SAVE, "button")).toBe("save");
    expect(editorShortcut(UNDO, "button")).toBe("undo");
    // Space already clicks the focused button; toggling too would cancel it.
    expect(editorShortcut(SPACE, "button")).toBeNull();
  });

  it("leaves every key to a text field", () => {
    expect(editorShortcut(SAVE, "text")).toBeNull();
    expect(editorShortcut(UNDO, "text")).toBeNull();
    expect(editorShortcut(SPACE, "text")).toBeNull();
  });
});

describe("focusKind", () => {
  it("classifies buttons, text fields and everything else", () => {
    expect(focusKind(element("button"))).toBe("button");
    expect(focusKind(element("input"))).toBe("text");
    expect(focusKind(element("textarea"))).toBe("text");
    expect(focusKind(element("div"))).toBe("other");
  });

  it("works on targets from another realm, such as the stage iframe", () => {
    // No prototype chain back to this realm's Element, only `closest`.
    const fromFrame = Object.assign(Object.create(null), element("g"));
    expect(focusKind(fromFrame)).toBe("other");
    expect(editorShortcut(SAVE, focusKind(fromFrame))).toBe("save");
  });

  it("treats non-elements as other", () => {
    expect(focusKind(null)).toBe("other");
    expect(focusKind({})).toBe("other");
  });
});

const DOC = parseDocument(`{
  "stage": { "width": 400, "height": 200, "fps": 25 },
  "parts": {},
  "steps": [
    { "id": "a", "duration": 800 },
    { "id": "b", "duration": 400 }
  ]
}`).doc;

function drag() {
  return new RetimeDrag<AnimDocument>(setStepDuration);
}

describe("RetimeDrag", () => {
  it("previews every move from the document the drag started on", () => {
    const session = drag();
    const first = session.preview(DOC, 0, 1000);
    const second = session.preview(first, 0, 1200);
    expect(second.steps[0].duration).toBe(1200);
    expect(session.active).toBe(true);

    const { doc, base, changed } = session.commit(second, 0, 1200);
    expect(base).toBe(DOC);
    expect(doc.steps[0].duration).toBe(1200);
    expect(changed).toBe(true);
    expect(session.active).toBe(false);
  });

  it("returns the starting document on cancel, not the last preview", () => {
    const session = drag();
    session.preview(DOC, 0, 1600);
    expect(session.cancel()).toBe(DOC);
    expect(session.active).toBe(false);
    expect(session.cancel()).toBeNull();
  });

  it("returns the starting document when a drag ends where it began", () => {
    const session = drag();
    const moved = session.preview(DOC, 0, 1600);
    const result = session.commit(moved, 0, 800);
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(DOC);
    expect(result.base).toBe(DOC);
  });

  it("starts the next drag from the current document", () => {
    const session = drag();
    const committed = session.commit(session.preview(DOC, 0, 1200), 0, 1200).doc;
    const next = session.commit(committed, 1, 600);
    expect(next.base).toBe(committed);
    expect(next.doc.steps.map((step) => step.duration)).toEqual([1200, 600]);
  });
});

describe("draggedDuration", () => {
  it("scales pointer travel into milliseconds", () => {
    const start = { startX: 100, startDuration: 800, msPerPixel: 4 };
    expect(draggedDuration(start, 150)).toBe(1000);
    expect(draggedDuration(start, 50)).toBe(600);
  });

  it("holds the duration when the track has no width", () => {
    expect(
      draggedDuration({ startX: 100, startDuration: 800, msPerPixel: 0 }, 0),
    ).toBe(800);
  });
});
