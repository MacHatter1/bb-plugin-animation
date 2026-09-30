/**
 * Where the stage is looking, and the order parts move in.
 *
 * Both are pure functions of the document, like the state resolver, so the
 * editor preview, the chat embed and the standalone export cannot disagree
 * about either.
 *
 * A step's `focus` names the parts that matter for that beat. The camera fits
 * them with some air, never zooms past `MAX_ZOOM`, and never shows anything
 * outside the stage. No focus means the whole stage.
 */

import { routeEdge } from "./route";
import type { AnimDocument, Part } from "./types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `scale` then translate by (`x`, `y`), in stage units. */
export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export const WHOLE_STAGE: Camera = { scale: 1, x: 0, y: 0 };

/** Past this a 13px node title is poster-sized and the context is gone. */
export const MAX_ZOOM = 2.4;
/** Below this the move is too small to read as one, so the stage stays whole. */
const MIN_ZOOM = 1.08;
/** Air around the focused parts, as a fraction of the stage's shorter side. */
const FOCUS_PADDING = 0.09;

/** Gap between the parts of one step starting to move, in milliseconds. */
export const STAGGER_MS = 70;
/** A step's changes all start within this window, however many there are. */
export const STAGGER_BUDGET_MS = 280;

/** Approximate widths of the stage's mono text, in stage units per character. */
export const LABEL_CHAR_W = 7.3;
export const LABEL_CAPS_CHAR_W = 8.7;
export const LABEL_TITLE_CHAR_W = 12.6;

function labelWidth(part: { text: string; caps?: boolean; size?: string }): number {
  const perChar =
    part.size === "title"
      ? LABEL_TITLE_CHAR_W
      : part.caps
        ? LABEL_CAPS_CHAR_W
        : LABEL_CHAR_W;
  return part.text.length * perChar;
}

/**
 * The box a part occupies on the stage. An edge spans its two endpoints; a
 * label's box is estimated from its text. Null when there is nothing to draw,
 * such as an edge whose endpoint is missing.
 */
export function partBox(doc: AnimDocument, id: string): Box | null {
  const part: Part | undefined = doc.parts[id];
  if (!part) {
    // `window/title` addresses a region inside the html part `window`.
    const slash = id.indexOf("/");
    return slash > 0 ? partBox(doc, id.slice(0, slash)) : null;
  }
  if (part.type === "node" || part.type === "shape" || part.type === "html") {
    return { x: part.x, y: part.y, w: part.w, h: part.h };
  }
  if (part.type === "label") {
    const w = labelWidth(part);
    const title = part.size === "title";
    const x =
      part.align === "end"
        ? part.x - w
        : part.align === "middle"
          ? part.x - w / 2
          : part.x;
    return title ? { x, y: part.y - 24, w, h: 32 } : { x, y: part.y - 12, w, h: 16 };
  }
  const from = doc.parts[part.from];
  const to = doc.parts[part.to];
  if (!from || !to || from.type === "edge" || to.type === "edge") return null;
  const a = partBox(doc, part.from);
  const b = partBox(doc, part.to);
  if (!a || !b) return null;
  // An arc rises above or drops below its two ends, so it is part of the box.
  const route = routeEdge(doc, id);
  return route ? union(union(a, b), route.bounds) : union(a, b);
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The camera for one step. `stepIndex` out of range gives the whole stage. */
export function cameraAtStep(doc: AnimDocument, stepIndex: number): Camera {
  const focus = doc.steps[stepIndex]?.focus;
  if (focus === undefined) return WHOLE_STAGE;
  const ids = typeof focus === "string" ? [focus] : focus;

  let target: Box | null = null;
  for (const id of ids) {
    const box = partBox(doc, id);
    if (box) target = target ? union(target, box) : box;
  }
  if (!target) return WHOLE_STAGE;

  const { width, height } = doc.stage;
  const pad = Math.min(width, height) * FOCUS_PADDING;
  // The view keeps the stage's aspect ratio, so nothing is ever stretched.
  const viewW = Math.max(
    target.w + pad * 2,
    ((target.h + pad * 2) * width) / height,
    width / MAX_ZOOM
  );
  if (width / viewW < MIN_ZOOM) return WHOLE_STAGE;
  const viewH = (viewW * height) / width;

  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const viewX = clamp(target.x + target.w / 2 - viewW / 2, width - viewW);
  const viewY = clamp(target.y + target.h / 2 - viewH / 2, height - viewH);

  const scale = width / viewW;
  return {
    scale: round(scale),
    x: round(-viewX * scale),
    y: round(-viewY * scale),
  };
}

/** True when any step moves the camera, so consumers can skip the work. */
export function usesFocus(doc: AnimDocument): boolean {
  return doc.steps.some((step) => step.focus !== undefined);
}

/** The CSS transform for a camera, applied to the scene's camera group. */
export function cameraTransform(camera: Camera): string {
  return `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
}

/**
 * Every part id in reading order: left to right, then top to bottom.
 *
 * Parts that change in the same step start a beat apart in this order, which
 * is what makes a step read as a sweep across the diagram rather than as
 * everything snapping at once. Ids are the tie-break, so the order is total.
 */
export function readingOrder(doc: AnimDocument): string[] {
  const position = (id: string) => {
    const box = partBox(doc, id);
    return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: 0, y: 0 };
  };
  return Object.keys(doc.parts).sort((a, b) => {
    const pa = position(a);
    const pb = position(b);
    return pa.x - pb.x || pa.y - pb.y || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/**
 * Start delays for the parts one step changes, given in reading order.
 * The first moves at once; the rest follow within `STAGGER_BUDGET_MS`.
 */
export function staggerDelays(count: number): number[] {
  if (count <= 1) return count === 1 ? [0] : [];
  const gap = Math.min(STAGGER_MS, STAGGER_BUDGET_MS / (count - 1));
  return Array.from({ length: count }, (_, index) => Math.round(index * gap));
}
