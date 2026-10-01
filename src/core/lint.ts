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
import { suggestIcon } from "./icons";
import { DEFAULT_LOOK, LOOKS, LOOK_IDS } from "./looks";
import { LIT_EDGE_STATES, resolveAtStep } from "./timeline";
import type { AnimDocument, NodePart, Part, ResolvedPartState } from "./types";

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
    if (part.variant === "actor") {
      const name = (part.label ?? id).length * TITLE_CHAR_W;
      if (name > part.w + 40) {
        notes.push({
          rule: "text-fit",
          path: `${path}.label`,
          message: `Actor "${id}" has a name about ${Math.ceil(name)} wide under a ${part.w}-wide circle, so it runs into its neighbours. Shorten the label to ${Math.floor((part.w + 40) / TITLE_CHAR_W)} characters or fewer.`,
        });
      }
      continue;
    }

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

    const title =
      (part.label ?? id).length * TITLE_CHAR_W + 48 + (part.icon ? 21 : 0);
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
      // The text runs horizontally whatever the edge's angle, so a vertical
      // edge only has to clear the plate's height, not its width.
      const slope = Math.abs(Math.cos((route.angle * Math.PI) / 180));
      const along = plate * slope + 28 * (1 - slope);
      if (along > route.gap - 8) {
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

/**
 * Ids whose state or tone differs between two resolved snapshots.
 *
 * The snapshots include the regions inside an html part, keyed `part/region`,
 * and a step that only recolours a region still changes the picture. Reading
 * the snapshots rather than the document's top-level part ids is what keeps a
 * UI-driven scene from being reported as frozen.
 */
function changedIds(
  before: Map<string, ResolvedPartState>,
  after: Map<string, ResolvedPartState>
): string[] {
  const changed: string[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was && was.state === now.state && was.tone === now.tone) continue;
    changed.push(id);
  }
  return changed;
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
    const changed = changedIds(resolved[index - 1], resolved[index]);
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
    ...layoutNotes(doc),
    ...styleNotes(doc),
    ...lengthNotes(doc, options.targetSeconds),
  ];
}

/**
 * The look assigned to a scene: one of the non-default looks, chosen by a hash
 * of the scene's own title.
 *
 * Assigned rather than matched to the subject on purpose. Almost everything
 * worth animating is technical, so any rule that reads the subject sends
 * nearly every scene to the same look, and authors left to choose do the same.
 * A hash spreads scenes evenly across the looks and gives the same scene the
 * same look every time it is validated.
 */
export function suggestLook(doc: AnimDocument): string {
  const labels = Object.entries(doc.parts)
    .filter(([, part]) => part.type === "label")
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const title = labels.find(([, part]) => part.type === "label" && part.size === "title");
  const seed =
    (title && title[1].type === "label" ? title[1].text : "") ||
    Object.keys(doc.parts).sort().join(" ");
  const others = LOOK_IDS.filter((id) => id !== DEFAULT_LOOK);
  let hash = 2166136261;
  for (const char of seed.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return others[hash % others.length];
}

const LAYOUT_BOX = { w: 220, h: 144 };
const LAYOUT_STAGE_H = 700;
const LAYOUT_RAIL_Y = 660;

/** Where boxes go when the story is one thing in the middle talking to the rest. */
const HUB_CENTRE = { x: 490, y: 270 };
const HUB_SPOKES = [
  { x: 60, y: 270 },
  { x: 920, y: 270 },
  { x: 490, y: 490 },
  { x: 490, y: 50 },
];
/** Where boxes go when the story is a loop, for three boxes and for four. */
const CYCLES: Record<number, Array<{ x: number; y: number }>> = {
  3: [
    { x: 150, y: 140 },
    { x: 830, y: 140 },
    { x: 490, y: 430 },
  ],
  4: [
    { x: 150, y: 140 },
    { x: 830, y: 140 },
    { x: 830, y: 430 },
    { x: 150, y: 430 },
  ],
};

/**
 * Is a row of boxes hiding a different shape?
 *
 * The recipe's row suits a chain. When every edge touches one box the story is
 * a hub, and when the edges close a ring it is a loop, and either drawn as a
 * row is a tangle of arcs. The note gives the positions for the shape the
 * edges already describe.
 */
function layoutNotes(doc: AnimDocument): Advice[] {
  const nodes = Object.entries(doc.parts).filter(
    (entry): entry is [string, NodePart] => entry[1].type === "node"
  );
  if (nodes.length < 3 || nodes.length > 5) return [];
  // Only a plain single row is rearranged; anything else was laid out on purpose.
  if (new Set(nodes.map(([, part]) => part.y)).size !== 1) return [];

  const ids = nodes.map(([id]) => id);
  const links = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const part of Object.values(doc.parts)) {
    if (part.type !== "edge" || part.from === part.to) continue;
    if (!links.has(part.from) || !links.has(part.to)) continue;
    links.get(part.from)?.add(part.to);
    links.get(part.to)?.add(part.from);
  }
  const degree = (id: string) => links.get(id)?.size ?? 0;
  const pairs = ids.reduce((sum, id) => sum + degree(id), 0) / 2;
  const byX = [...nodes].sort((a, b) => a[1].x - b[1].x).map(([id]) => id);

  const place = (moves: Array<[string, { x: number; y: number }]>) =>
    moves
      .map(([id, at]) => `"${id}" to "x": ${at.x}, "y": ${at.y}`)
      .join("; ");
  const rest = `Give every box "w": ${LAYOUT_BOX.w} and "h": ${LAYOUT_BOX.h}, set the stage "height" to ${LAYOUT_STAGE_H}, and move the labels under the boxes to "y": ${LAYOUT_RAIL_Y}.`;

  const centre = ids.find((id) => degree(id) === ids.length - 1);
  if (centre && ids.length >= 4 && pairs === ids.length - 1) {
    const spokes = byX.filter((id) => id !== centre);
    return [
      {
        rule: "layout",
        path: "parts",
        message: `Every edge goes to or from "${centre}", so this is a hub, but the boxes are in a row. Put "${centre}" in the middle: move ${place([[centre, HUB_CENTRE], ...spokes.map((id, index): [string, { x: number; y: number }] => [id, HUB_SPOKES[index]])])}. ${rest}`,
      },
    ];
  }

  const ring = CYCLES[ids.length];
  if (ring && pairs === ids.length && ids.every((id) => degree(id) === 2)) {
    // Walk the ring from the leftmost box so neighbours end up next to each other.
    const order = [byX[0]];
    while (order.length < ids.length) {
      const last = order[order.length - 1];
      const next = [...(links.get(last) ?? [])].find((id) => !order.includes(id));
      if (!next) return [];
      order.push(next);
    }
    return [
      {
        rule: "layout",
        path: "parts",
        message: `The edges form a loop through all ${ids.length} boxes, but the boxes are in a row, so the edge that closes the loop has to arc back over everything. Lay them out as a ring: move ${place(order.map((id, index): [string, { x: number; y: number }] => [id, ring[index]]))}. ${rest}`,
      },
    ];
  }
  return [];
}

/**
 * Notes about character rather than correctness. A scene with no look, no
 * icons and nothing but cards is not wrong, but it is indistinguishable from
 * every other scene made the same way.
 */
function styleNotes(doc: AnimDocument): Advice[] {
  const notes: Advice[] = [];
  const nodes = Object.entries(doc.parts).filter(
    (entry): entry is [string, NodePart] => entry[1].type === "node"
  );
  // A two-step starter or a single box is a sketch, not a finished scene.
  if (doc.steps.length < 3 || nodes.length < 2) return notes;

  if (doc.stage.look === undefined) {
    const pick = suggestLook(doc);
    notes.push({
      rule: "look",
      path: "stage.look",
      message: `No look is set, so this scene has the same plain style as every other unstyled scene. Add "look": "${pick}" to "stage" (${LOOKS[pick].feel}). It is assigned from the scene's title so that different scenes look different; use another only if the user asked for one by name. The looks are: ${LOOK_IDS.join(", ")}.`,
    });
  }

  if (nodes.every(([, part]) => !part.icon)) {
    const picks = nodes.map(
      ([id, part]) => `"icon": "${suggestIcon(id, part.label) ?? "box"}" to "${id}"`
    );
    notes.push({
      rule: "icons",
      path: "parts",
      message: `No box has an icon, so they can only be told apart by reading them. Add ${picks.join(", ")}.`,
    });
  }

  if (nodes.every(([, part]) => part.variant !== "actor")) {
    const people = nodes.filter(([id, part]) => {
      const icon = part.icon ?? suggestIcon(id, part.label);
      return icon === "user" || icon === "phone";
    });
    if (people.length > 0) {
      notes.push({
        rule: "actor",
        path: `parts.${people[0][0]}`,
        message: `Every box is a card, including the ${people.length === 1 ? "person" : "people"} in the story. Draw ${quote(people.map(([id]) => id))} as ${people.length === 1 ? "an actor" : "actors"}: add "variant": "actor" and remove ${people.length === 1 ? "its" : "their"} "rows" and "subtitle", which an actor does not show.`,
      });
    }
  }

  for (const [id, part] of nodes) {
    if (part.variant !== "actor" || !(part.rows?.length || part.subtitle)) continue;
    notes.push({
      rule: "actor-rows",
      path: `parts.${id}`,
      message: `"${id}" is an actor, which shows only its icon and name, so its ${part.rows?.length ? '"rows"' : '"subtitle"'} ${part.rows?.length && part.subtitle ? 'and "subtitle" are' : "is"} never drawn. Remove ${part.rows?.length && part.subtitle ? "them" : "it"}, or drop "variant" to make it a card again.`,
    });
  }

  return notes;
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
