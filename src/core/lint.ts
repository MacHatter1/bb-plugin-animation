/**
 * Design notes: what a good motion designer would say on seeing the file.
 *
 * The parser answers "can this be drawn?". This answers "will it look right,
 * and will anyone follow it?". The rules exist because the format's failures
 * are silent: a row that does not fit is dropped, a typo'd state renders as
 * idle, a caption held for a second is never read. None of those is an error,
 * and every one of them is the difference between a diagram and an explainer.
 *
 * Every note names the exact change that clears it, with the numbers worked
 * out, because the author is usually an agent that cannot see the result. The
 * loop is: validate, apply each note, validate again, until there are none.
 *
 * Notes never block saving or export. A scene can break a rule on purpose.
 */

import { cameraAtStep, partBox, type Box } from "./camera";
import { routeEdge } from "./route";
import { LIT_EDGE_STATES, resolveAtStep } from "./timeline";
import type { AnimDocument, NodePart, Part } from "./types";

export interface Advice {
  /** Stable name for the rule, so a note can be recognised and tested. */
  rule: string;
  /** Dotted path into the document, like a parser problem's. */
  path: string;
  /** What is wrong, then the change that fixes it. */
  message: string;
}

/*
 * Node geometry. These mirror `renderNode` in `render/scene.ts`; a test draws
 * a node at the height computed here and checks every row appears.
 */
const NODE_HEADER_H = 34;
const NODE_ROWS_TOP = NODE_HEADER_H + 22;
const NODE_SUBTITLE_H = 16;
const NODE_ROW_PITCH = 32;
const NODE_ROW_H = 26;
const NODE_BOTTOM_PAD = 6;

/* Approximate advance widths of the stage's mono text, per character. */
const TITLE_CHAR_W = 8.7;
const SMALL_CHAR_W = 6.7;
const EDGE_TEXT_CHAR_W = 7.6;

/* Reading speed for captions: a fixed beat to find the text, then per word. */
const CAPTION_BASE_MS = 400;
const CAPTION_WORD_MS = 260;
const CAPTION_MAX_WORDS = 12;

const MIN_STEP_MS = 500;
const MAX_STEP_MS = 8000;
const BUSY_STEP_PARTS = 6;
const QUIET_END_NODES = 3;
const QUIET_START_PARTS = 3;

const STATES: Partial<Record<Part["type"], readonly string[]>> = {
  node: ["idle", "active", "waiting", "offline", "hidden"],
  edge: ["idle", "flowing", "returning", "active", "hidden"],
  label: ["idle", "active", "hidden"],
  shape: ["idle", "active", "hidden"],
};

/*
 * Row values that describe a moment rather than a fact. Text never changes
 * between steps, so "verified" is on screen before the user has signed in.
 */
const STATUS_WORDS = new Set([
  "pending", "ready", "done", "complete", "completed", "running", "waiting",
  "idle", "active", "inactive", "success", "succeeded", "failed", "failing",
  "ok", "error", "started", "finished", "processing", "loading", "queued",
  "sent", "received", "issued", "granted", "denied", "verified", "unverified",
  "authenticated", "authorized", "authorised", "valid", "invalid", "expired",
  "online", "offline", "connected", "disconnected", "open", "closed",
  "in progress", "logged in", "signed in", "passing", "passed", "failing",
  "blocked", "unblocked", "safe", "unsafe", "approved", "rejected", "merged",
  "deployed", "live", "healthy", "unhealthy", "up", "down", "locked",
  "unlocked", "stale", "fresh", "cached", "synced", "available",
  "unavailable", "busy", "empty", "full", "true", "false", "yes", "no",
  "hit", "miss", "local miss", "missing", "found", "not found",
]);

/** How far a scene may be from the length asked for before it is a note. */
const LENGTH_TOLERANCE = 0.1;
const TYPICAL_STEP_MS = 2500;

export interface LintOptions {
  /** The length the user asked for, when they asked for one. */
  targetSeconds?: number;
}

function quote(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function isBoxPart(part: Part): boolean {
  return part.type === "node" || part.type === "html" || part.type === "shape";
}

/** How long a caption of `words` words needs on screen to be read. */
export function captionReadingMs(words: number): number {
  return CAPTION_BASE_MS + words * CAPTION_WORD_MS;
}

/** Rows start here, measured from the top of the node. */
function rowsTop(part: NodePart): number {
  return NODE_ROWS_TOP + (part.subtitle ? NODE_SUBTITLE_H : 0);
}

/** The smallest height at which every row of `part` is drawn. */
export function nodeHeightForRows(part: NodePart): number {
  const rows = part.rows?.length ?? 0;
  // The last row's box must end `NODE_BOTTOM_PAD` above the node's bottom edge.
  return (
    rowsTop(part) +
    Math.max(0, rows - 1) * NODE_ROW_PITCH +
    NODE_ROW_H +
    NODE_BOTTOM_PAD
  );
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w - 2 &&
    b.x < a.x + a.w - 2 &&
    a.y < b.y + b.h - 2 &&
    b.y < a.y + a.h - 2
  );
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Widest gap the recipe's grid uses; past this a row looks scattered. */
const ROW_MAX_GAP = 260;
const ROW_MARGIN = 60;

/**
 * New x positions for the boxes sharing a row with `id`, spread evenly across
 * the stage. Null when the row is already as wide as it can be, or is not a
 * simple row of two or three boxes.
 */
function spreadRow(doc: AnimDocument, id: string): string | null {
  const anchor = doc.parts[id];
  if (!anchor || anchor.type !== "node") return null;
  const row = Object.entries(doc.parts)
    .filter(
      ([, part]) =>
        (part.type === "node" || part.type === "html") &&
        part.y < anchor.y + anchor.h &&
        anchor.y < part.y + part.h
    )
    .map(([partId, part]) => ({ id: partId, part: part as NodePart }))
    .sort((a, b) => a.part.x - b.part.x);
  if (row.length < 2 || row.length > 3) return null;

  const widths = row.reduce((sum, item) => sum + item.part.w, 0);
  const room = doc.stage.width - ROW_MARGIN * 2 - widths;
  const gap = Math.min(ROW_MAX_GAP, Math.floor(room / (row.length - 1)));
  const current = row[1].part.x - (row[0].part.x + row[0].part.w);
  if (gap <= current + 20) return null;

  const total = widths + gap * (row.length - 1);
  let x = Math.round((doc.stage.width - total) / 2);
  const moves: string[] = [];
  for (const item of row) {
    moves.push(`"${item.id}" to "x": ${x}`);
    x += item.part.w + gap;
  }
  return `move ${moves.join(", ")}`;
}

function geometryNotes(doc: AnimDocument): Advice[] {
  const notes: Advice[] = [];
  const { width, height } = doc.stage;
  const ids = Object.keys(doc.parts).sort();

  for (const id of ids) {
    const part = doc.parts[id];
    const path = `parts.${id}`;

    if (part.type === "edge") {
      const missing = [part.from, part.to].filter((end) => {
        const target = doc.parts[end];
        return !target || target.type === "edge";
      });
      if (missing.length > 0) {
        notes.push({
          rule: "edge-endpoint",
          path,
          message: `Edge "${id}" points at ${quote(missing)}, which is not a box, label or shape in this scene, so the edge is not drawn. Set "from" and "to" to existing part ids.`,
        });
      }
      continue;
    }

    const box = partBox(doc, id);
    if (
      box &&
      (box.x < -2 ||
        box.y < -2 ||
        box.x + box.w > width + 2 ||
        box.y + box.h > height + 2)
    ) {
      notes.push({
        rule: "off-stage",
        path,
        message: `Part "${id}" runs past the edge of the ${width} by ${height} stage and will be cut off. Move or shrink it so it fits inside the stage.`,
      });
    }

    if (part.type === "shape" && part.text) {
      const needed = part.text.length * SMALL_CHAR_W + 8;
      if (needed > part.w) {
        notes.push({
          rule: "text-fit",
          path,
          message: `Shape "${id}" is ${part.w} wide but its text needs about ${Math.ceil(needed)}. Set "w": ${roundUp(needed, 10)} or shorten the text.`,
        });
      }
    }

    if (part.type !== "node") continue;

    const rows = part.rows ?? [];
    const statuses = rows.filter(
      (row) => row.value && STATUS_WORDS.has(row.value.trim().toLowerCase())
    );
    if (statuses.length > 0) {
      notes.push({
        rule: "row-status",
        path: `${path}.rows`,
        message: `Node "${id}" has ${statuses.length === 1 ? "a row that reads as a status" : "rows that read as statuses"}: ${statuses.map((row) => `"${row.key}: ${row.value}"`).join(", ")}. Row text never changes, so it is on screen before it is true. Replace ${statuses.length === 1 ? "it" : "each"} with a fixed fact (a name, a limit, a setting), or remove the row and show the change with the node's state.`,
      });
    }
    const needed = nodeHeightForRows(part);
    if (rows.length > 0 && part.h < needed) {
      const shown = rows.filter(
        (_, index) =>
          rowsTop(part) + index * NODE_ROW_PITCH + NODE_ROW_H <=
          part.h - NODE_BOTTOM_PAD
      ).length;
      const best = rows.length * NODE_ROW_PITCH + (part.subtitle ? 80 : 64);
      notes.push({
        rule: "rows-clipped",
        path: `${path}.h`,
        message: `Node "${id}" is ${part.h} high, so only ${shown} of its ${rows.length} rows are drawn. Set "h": ${best}.`,
      });
    }

    const title = (part.label ?? id).length * TITLE_CHAR_W + 48;
    const subtitle = (part.subtitle?.length ?? 0) * SMALL_CHAR_W + 32;
    const widestRow = Math.max(
      0,
      ...rows.map(
        (row) =>
          (row.key.length + (row.value?.length ?? 0)) * SMALL_CHAR_W + 68
      )
    );
    const widest = Math.max(title, subtitle, widestRow);
    if (widest > part.w) {
      notes.push({
        rule: "text-fit",
        path: `${path}.w`,
        message: `Node "${id}" is ${part.w} wide but its longest line needs about ${Math.ceil(widest)}, so text will overlap or spill out. Set "w": ${roundUp(widest, 10)} or shorten the text.`,
      });
    }
  }

  // Boxes that partly cover each other. One sitting fully inside another is a
  // deliberate container, such as items drawn inside a queue.
  const boxes = ids
    .filter((id) => isBoxPart(doc.parts[id]))
    .map((id) => ({ id, box: partBox(doc, id) as Box }));
  let overlaps = 0;
  for (let i = 0; i < boxes.length && overlaps < 6; i += 1) {
    for (let j = i + 1; j < boxes.length && overlaps < 6; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (!intersects(a.box, b.box)) continue;
      if (contains(a.box, b.box) || contains(b.box, a.box)) continue;
      overlaps += 1;
      notes.push({
        rule: "overlap",
        path: `parts.${b.id}`,
        message: `Parts "${a.id}" and "${b.id}" overlap. Move one so there is a gap of at least 40 between them.`,
      });
    }
  }

  for (const id of ids) {
    const part = doc.parts[id];
    if (part.type !== "edge") continue;
    const route = routeEdge(doc, id);
    if (!route) continue;

    // The renderer arcs an edge round the boxes in its way. This is what is
    // left when neither side of the row has room for the arc.
    if (route.through.length > 0) {
      notes.push({
        rule: "edge-crosses",
        path: `parts.${id}`,
        message: `Edge "${id}" from "${part.from}" to "${part.to}" still runs through ${quote(route.through)} after routing round it. Move "${part.to}" next to "${part.from}", or leave at least 140 of empty space above or below the row for the edge to arc through.`,
      });
      continue;
    }

    if (part.text && route.kind === "straight") {
      const plate = Math.max(40, part.text.length * EDGE_TEXT_CHAR_W + 16);
      if (plate > route.gap - 8) {
        const fits = Math.max(0, Math.floor((route.gap - 24) / EDGE_TEXT_CHAR_W));
        const spread = spreadRow(doc, part.from);
        notes.push({
          rule: "edge-text-fit",
          path: `parts.${id}.text`,
          message: `Edge "${id}" has a gap of ${Math.round(route.gap)} but its text "${part.text}" needs ${Math.ceil(plate)}, so the label covers the boxes. ${
            spread
              ? `Spread the row out so the text fits: ${spread}.`
              : `Shorten the text to ${fits} ${fits === 1 ? "character" : "characters"} or fewer, or leave a gap of ${roundUp(plate + 24, 10)} between the boxes.`
          } Keep the text: it says what is being sent.`,
        });
      }
    }
  }

  return notes;
}

function stateNotes(doc: AnimDocument): Advice[] {
  const notes: Advice[] = [];
  const check = (partId: string, state: string | undefined, path: string) => {
    const part = doc.parts[partId];
    const known = part ? STATES[part.type] : undefined;
    if (!state || !known || known.includes(state)) return;
    notes.push({
      rule: "unknown-state",
      path,
      message: `"${state}" is not a state a ${part.type} has, so "${partId}" renders as idle. Use one of: ${known.join(", ")}.`,
    });
  };
  for (const [id, part] of Object.entries(doc.parts)) {
    check(id, part.state, `parts.${id}.state`);
  }
  doc.steps.forEach((step, index) => {
    for (const [partId, assignment] of Object.entries(step.set ?? {})) {
      check(partId, assignment.state, `steps[${index}].set.${partId}.state`);
    }
  });
  return notes;
}

function pacingNotes(doc: AnimDocument): Advice[] {
  const notes: Advice[] = [];
  const uncaptioned = doc.steps
    .filter((step) => !step.caption?.trim())
    .map((step) => step.id);
  if (uncaptioned.length > 0) {
    notes.push({
      rule: "caption-missing",
      path: "steps",
      message: `${uncaptioned.length === 1 ? "Step" : "Steps"} ${quote(uncaptioned)} ${uncaptioned.length === 1 ? "has" : "have"} no caption. Captions are the narration shown under the stage, so give every step one short sentence.`,
    });
  }

  // One note for every rushed caption, with the duration each step needs, so
  // the fix is a list to apply rather than fifteen near-identical notes.
  const rushed: string[] = [];
  doc.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    const words = step.caption?.trim().split(/\s+/).filter(Boolean).length ?? 0;
    const needed = captionReadingMs(words);
    if (words > CAPTION_MAX_WORDS) {
      notes.push({
        rule: "caption-long",
        path: `${path}.caption`,
        message: `Step "${step.id}" has a ${words}-word caption. Keep a caption to one idea in ${CAPTION_MAX_WORDS} words or fewer; split the step if it needs more.`,
      });
    } else if (words > 0 && step.duration < needed - 100) {
      rushed.push(`"${step.id}": ${roundUp(needed, 100)}`);
    } else if (step.duration < MIN_STEP_MS) {
      notes.push({
        rule: "step-short",
        path: `${path}.duration`,
        message: `Step "${step.id}" lasts ${step.duration}ms, which is over before the change registers. Set "duration" to at least 600.`,
      });
    }
    if (step.duration > MAX_STEP_MS) {
      notes.push({
        rule: "step-long",
        path: `${path}.duration`,
        message: `Step "${step.id}" holds for ${step.duration}ms with nothing changing. Set "duration" to 4000 or less, or split it into two steps.`,
      });
    }
  });
  if (rushed.length > 0) {
    notes.push({
      rule: "caption-rushed",
      path: "steps",
      message: `${rushed.length} ${rushed.length === 1 ? "step shows its caption" : "steps show their captions"} too briefly to read. A caption needs ${CAPTION_BASE_MS}ms plus ${CAPTION_WORD_MS}ms per word. Set these durations, or shorten the captions (8 words fit in ${roundUp(captionReadingMs(8), 100)}ms): ${rushed.join(", ")}.`,
    });
  }
  return notes;
}

/**
 * What a step is about: the boxes it lights, plus both ends of any edge it
 * sets flowing. Empty when that is nothing, or too much to be worth a zoom.
 */
function suggestFocus(
  doc: AnimDocument,
  stepIndex: number,
  boxes: readonly string[]
): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (boxes.includes(id) && !ids.includes(id)) ids.push(id);
  };
  for (const [id, assignment] of Object.entries(doc.steps[stepIndex].set ?? {})) {
    const part = doc.parts[id];
    if (!part || !assignment.state) continue;
    if (part.type === "edge" && LIT_EDGE_STATES.includes(assignment.state)) {
      add(part.from);
      add(part.to);
    } else if (assignment.state === "active") {
      add(id);
    }
  }
  return ids.length >= 1 && ids.length <= 3 ? ids : [];
}

function storyNotes(doc: AnimDocument): Advice[] {
  const notes: Advice[] = [];
  const ids = Object.keys(doc.parts);
  const steps = doc.steps;
  if (steps.length === 0) return notes;

  const baseline = resolveAtStep(doc, -1);
  const resolved = steps.map((_, index) => resolveAtStep(doc, index));
  const boxes = ids.filter((id) => {
    const type = doc.parts[id].type;
    return type === "node" || type === "html";
  });

  // A part that starts hidden and never appears is dead weight, or a typo.
  for (const id of ids) {
    if (baseline.get(id)?.state !== "hidden") continue;
    if (resolved.some((states) => states.get(id)?.state !== "hidden")) continue;
    notes.push({
      rule: "never-shown",
      path: `parts.${id}`,
      message: `Part "${id}" starts hidden and no step shows it. Set it to "idle" or "active" in the step where it should arrive, or remove it.`,
    });
  }

  steps.forEach((step, index) => {
    const before = index === 0 ? baseline : resolved[index - 1];
    const changed = Object.keys(step.set ?? {}).filter((id) => {
      const was = before.get(id);
      const now = resolved[index].get(id);
      return was && now && (was.state !== now.state || was.tone !== now.tone);
    });
    if (changed.length > BUSY_STEP_PARTS) {
      notes.push({
        rule: "step-busy",
        path: `steps[${index}].set`,
        message: `Step "${step.id}" changes ${changed.length} parts at once, so the eye has nowhere to land. Split it into two steps that each show one idea.`,
      });
    }
  });

  // A step where the picture does not change is dead air: the caption moves
  // on and the viewer is left looking at the same frame.
  steps.forEach((step, index) => {
    if (index === 0) return;
    const before = cameraAtStep(doc, index - 1);
    const camera = cameraAtStep(doc, index);
    if (
      before.scale !== camera.scale ||
      before.x !== camera.x ||
      before.y !== camera.y
    ) {
      return;
    }
    const view: Box = {
      x: -camera.x / camera.scale,
      y: -camera.y / camera.scale,
      w: doc.stage.width / camera.scale,
      h: doc.stage.height / camera.scale,
    };
    const changed = ids.filter((id) => {
      const was = resolved[index - 1].get(id);
      const now = resolved[index].get(id);
      return was && now && (was.state !== now.state || was.tone !== now.tone);
    });
    const inFrame = changed.filter((id) => {
      const box = partBox(doc, id);
      return box !== null && intersects(view, box);
    });
    if (inFrame.length > 0) return;
    const path = `steps[${index}]`;
    notes.push(
      changed.length === 0
        ? {
            rule: "step-static",
            path,
            message: `Step "${step.id}" changes nothing on screen, so the picture stands still while its caption plays. Show what the caption says: light a box, set an edge "flowing", or reveal a hidden part. If there is nothing to show, merge the caption into the previous step.`,
          }
        : {
            rule: "step-static",
            path,
            message: `Step "${step.id}" only changes ${quote(changed)}, which ${changed.length === 1 ? "is" : "are"} outside the zoomed frame, so the picture stands still. Change something inside the frame (light a box, set an edge "flowing"), or remove "focus" from this step.`,
          }
    );
  });

  // Traffic arriving at a box that stays grey looks like it went nowhere. The
  // box a lit edge runs into should react in the same step.
  steps.forEach((step, index) => {
    for (const [id, assignment] of Object.entries(step.set ?? {})) {
      const part = doc.parts[id];
      if (part?.type !== "edge" || !assignment.state) continue;
      if (!LIT_EDGE_STATES.includes(assignment.state)) continue;
      const target = assignment.state === "returning" ? part.from : part.to;
      if (doc.parts[target]?.type !== "node") continue;
      if (resolved[index].get(target)?.state !== "idle") continue;
      const tone = resolved[index].get(id)?.tone ?? "accent";
      notes.push({
        rule: "edge-target-idle",
        path: `steps[${index}].set`,
        message: `Step "${step.id}" sends traffic along "${id}" into "${target}", but "${target}" stays unlit, so it looks as if nothing arrived. Light it in the same step: add "${target}": { "state": "active", "tone": "${tone === "neutral" ? "accent" : tone}" } to this step's "set".`,
      });
      return;
    }
  });

  const first = resolved[0];
  const litAtStart = ids.filter((id) => {
    const type = doc.parts[id].type;
    const state = first.get(id)?.state;
    return (
      (type === "node" && state === "active") ||
      (type === "edge" && state !== undefined && LIT_EDGE_STATES.includes(state))
    );
  });
  if (litAtStart.length > QUIET_START_PARTS) {
    notes.push({
      rule: "start-loud",
      path: "steps[0].set",
      message: `The first step lights ${litAtStart.length} parts. Start quiet: light one part in step "${steps[0].id}" and bring the others in over the next steps.`,
    });
  }

  if (steps.length > 1) {
    const last = resolved[steps.length - 1];
    const lastPath = `steps[${steps.length - 1}].set`;
    const flowing = ids.filter((id) => {
      const state = last.get(id)?.state;
      return (
        doc.parts[id].type === "edge" &&
        state !== undefined &&
        LIT_EDGE_STATES.includes(state)
      );
    });
    if (flowing.length > 0) {
      notes.push({
        rule: "end-busy",
        path: lastPath,
        message: `The last step leaves ${flowing.length === 1 ? "edge" : "edges"} ${quote(flowing)} still flowing. States never switch off on their own: set ${flowing.length === 1 ? "it" : "them"} to "idle" in the last step so the ending is calm.`,
      });
    }
    const lit = ids.filter(
      (id) => doc.parts[id].type === "node" && last.get(id)?.state === "active"
    );
    if (lit.length === 0) {
      // Name the box that was lit most recently: it is usually the outcome.
      let outcome = "";
      for (let index = steps.length - 2; index >= 0 && outcome === ""; index -= 1) {
        outcome =
          ids.find(
            (id) =>
              doc.parts[id].type === "node" &&
              resolved[index].get(id)?.state === "active"
          ) ?? "";
      }
      if (outcome !== "") {
        notes.push({
          rule: "end-empty",
          path: lastPath,
          message: `The last step switches every box off, so the animation ends on nothing. Keep the box that holds the result lit: in step "${steps[steps.length - 1].id}", leave "${outcome}" as "active" (remove the line that sets it to "idle").`,
        });
      }
    }
    if (lit.length > QUIET_END_NODES) {
      notes.push({
        rule: "end-busy",
        path: lastPath,
        message: `The last step leaves ${lit.length} nodes lit (${quote(lit)}). Set all but the one or two that carry the result back to "idle".`,
      });
    }
  }

  // A focused step that lights an edge should keep both of its ends in frame,
  // or the viewer sees traffic arriving from nowhere.
  steps.forEach((step, index) => {
    if (step.focus === undefined) return;
    const camera = cameraAtStep(doc, index);
    if (camera.scale === 1) return;
    const view: Box = {
      x: -camera.x / camera.scale - 4,
      y: -camera.y / camera.scale - 4,
      w: doc.stage.width / camera.scale + 8,
      h: doc.stage.height / camera.scale + 8,
    };
    const current = typeof step.focus === "string" ? [step.focus] : step.focus;
    const missing: string[] = [];
    const cut: string[] = [];
    for (const [id, assignment] of Object.entries(step.set ?? {})) {
      const part = doc.parts[id];
      if (part?.type !== "edge") continue;
      if (!assignment.state || !LIT_EDGE_STATES.includes(assignment.state)) continue;
      const ends = [part.from, part.to].filter((end) => {
        const box = partBox(doc, end);
        return box !== null && !contains(view, box);
      });
      if (ends.length === 0) continue;
      cut.push(id);
      for (const end of ends) {
        if (!current.includes(end) && !missing.includes(end)) missing.push(end);
      }
    }
    if (cut.length === 0 || missing.length === 0) return;
    notes.push({
      rule: "focus-cuts-edge",
      path: `steps[${index}].focus`,
      message: `Step "${step.id}" lights ${cut.length === 1 ? "edge" : "edges"} ${quote(cut)}, but ${quote(missing)} at the other end ${missing.length === 1 ? "is" : "are"} outside the frame, so the traffic comes from nowhere. Set "focus": [${quote([...current, ...missing])}].`,
    });
  });

  if (steps.length >= 4 && boxes.length >= 5) {
    // Boxes only: edges hide themselves until they are used, so they do not
    // show that the author revealed anything.
    const anyHidden = boxes.some((id) => baseline.get(id)?.state === "hidden");
    if (!anyHidden) {
      notes.push({
        rule: "reveal",
        path: "parts",
        message: `All ${boxes.length} boxes are on screen from the first frame, so nothing arrives and the viewer cannot tell where to look. Give the parts that come later "state": "hidden", then set each to "idle" or "active" in the step that introduces it.`,
      });
    }

    const usesFocus = steps.some((step) => step.focus !== undefined);
    if (!usesFocus) {
      // Point at a real step and its parts, so the fix can be pasted.
      let example = "";
      for (let index = 0; index < steps.length && example === ""; index += 1) {
        const target = suggestFocus(doc, index, boxes);
        if (target.length > 0) {
          example = ` For example, add "focus": ${
            target.length === 1 ? `"${target[0]}"` : `[${quote(target)}]`
          } to step "${steps[index].id}".`;
        }
      }
      notes.push({
        rule: "focus",
        path: "steps",
        message: `This scene has ${boxes.length} boxes and the camera never moves, so each one is small. Add "focus" to the steps that are about one or two boxes, and leave it off the steps that show the whole picture.${example}`,
      });
    }
  }

  return notes;
}

/**
 * Every design note for a document, most visible faults first: things that
 * draw wrong, then states that do nothing, then pacing, then storytelling.
 */
export function lintDocument(
  doc: AnimDocument,
  options: LintOptions = {}
): Advice[] {
  return [
    ...geometryNotes(doc),
    ...stateNotes(doc),
    ...pacingNotes(doc),
    ...storyNotes(doc),
    ...lengthNotes(doc, options.targetSeconds),
  ];
}

/** Is the scene about as long as was asked for? */
function lengthNotes(doc: AnimDocument, targetSeconds?: number): Advice[] {
  if (!targetSeconds || doc.steps.length === 0) return [];
  const total = doc.steps.reduce((sum, step) => sum + step.duration, 0);
  const target = targetSeconds * 1000;
  if (Math.abs(total - target) <= target * LENGTH_TOLERANCE) return [];
  const steps = Math.max(1, Math.round(Math.abs(total - target) / TYPICAL_STEP_MS));
  const seconds = (total / 1000).toFixed(1);
  return [
    {
      rule: "length",
      path: "steps",
      message:
        total < target
          ? `The scene runs ${seconds}s but ${targetSeconds}s was asked for. Add about ${steps} more ${steps === 1 ? "step" : "steps"}, each with its own caption and its own change on screen; do not pad the existing durations.`
          : `The scene runs ${seconds}s but ${targetSeconds}s was asked for. Shorten the captions and their durations, or merge about ${steps} ${steps === 1 ? "step" : "steps"}.`,
    },
  ];
}
