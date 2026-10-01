/**
 * Where an edge is drawn.
 *
 * An edge used to be one straight line, centre to centre. That made two common
 * things look broken, and the only advice the format could give was "rearrange
 * your boxes":
 *
 * - **A message that skips a box.** In a row of client, gateway, service, the
 *   client talking to the service drew a line through the gateway. Authors who
 *   cannot see the result respond by deleting the edge, and with it the beat
 *   the animation existed to show.
 * - **A request and its reply as two edges.** Both drew on the same pixels.
 *
 * So the route is worked out here instead. Neighbours still get a straight
 * line. Two edges between the same pair run in parallel lanes. An edge whose
 * straight line would cross another box arcs round it: over the row when it
 * runs forwards, under it when it runs back, the way a sequence diagram reads.
 *
 * Pure geometry on the document, shared by the renderer and the design notes,
 * so a note about an edge always describes the line that is actually drawn.
 */

import type { AnimDocument, Part } from "./types";

export interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeRoute {
  /** SVG path data for the line; packets travel the same path. */
  d: string;
  kind: "straight" | "arc";
  /** Where the edge's text sits. */
  label: Point;
  /** The arrow head's tip, and its rotation in degrees. */
  end: Point;
  angle: number;
  /** Room for the text between the two boxes. Unlimited on an arc. */
  gap: number;
  /** Boxes the route still runs through. Empty for a clean route. */
  through: string[];
  /** Everything the line covers, for framing it with the camera. */
  bounds: Rect;
  /** The point a fraction `t` of the way along the line, from 0 to 1. */
  at: (t: number) => Point;
}

/** Distance between the centre lines of two edges joining the same pair. */
export const LANE_GAP = 30;

const ARC_SAMPLES = 24;
const STAGE_MARGIN = 6;

/**
 * The circle an actor is drawn as, in its box's own coordinates.
 *
 * It sits at the box's centre, not at the top, so an edge between an actor and
 * a card in the same row runs level: both are joined centre to centre. The
 * radius leaves room underneath for the name.
 */
export function actorCircle(box: { w: number; h: number }): {
  cx: number;
  cy: number;
  r: number;
} {
  const r = Math.max(14, Math.min(box.w, box.h - 56) / 2);
  return { cx: box.w / 2, cy: box.h / 2, r };
}

/** A rectangle, or the circle inside it when that is what is drawn. */
interface Anchor extends Rect {
  circle?: { cx: number; cy: number; r: number };
}

/**
 * What an edge attaches to: the thing that is actually drawn.
 *
 * A label is a point, so its edge meets the text's anchor rather than an
 * estimated text box. An actor is its circle, not the wider box that also
 * holds its name: a line that stopped at the box would end in empty space
 * beside the circle.
 */
function anchorRect(part: Part | undefined): Anchor | null {
  if (!part || part.type === "edge") return null;
  if (part.type === "label") return { x: part.x, y: part.y, w: 0, h: 0 };
  if (part.type === "node" && part.variant === "actor") {
    const { cx, cy, r } = actorCircle(part);
    const circle = { cx: part.x + cx, cy: part.y + cy, r };
    return { x: circle.cx - r, y: circle.cy - r, w: r * 2, h: r * 2, circle };
  }
  return { x: part.x, y: part.y, w: part.w, h: part.h };
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function inside(rect: Rect, point: Point, shrink = 3): boolean {
  return (
    point.x > rect.x + shrink &&
    point.x < rect.x + rect.w - shrink &&
    point.y > rect.y + shrink &&
    point.y < rect.y + rect.h - shrink
  );
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * Where the segment from `start`, a point inside `rect`, towards `toward`
 * leaves the rectangle. A point-sized rect returns the point itself.
 */
function exitPoint(rect: Anchor, start: Point, toward: Point): Point {
  const dx = toward.x - start.x;
  const dy = toward.y - start.y;
  if ((dx === 0 && dy === 0) || rect.w === 0 || rect.h === 0) return start;
  if (rect.circle) {
    // Where the ray from `start` leaves the circle. `start` is inside it
    // unless a lane has been pushed past its edge, in which case the square
    // around it is the better answer.
    const { cx, cy, r } = rect.circle;
    const ox = start.x - cx;
    const oy = start.y - cy;
    const a = dx * dx + dy * dy;
    const b = ox * dx + oy * dy;
    const c = ox * ox + oy * oy - r * r;
    if (c < 0) {
      const t = (-b + Math.sqrt(b * b - a * c)) / a;
      return { x: start.x + dx * t, y: start.y + dy * t };
    }
  }
  const tx =
    dx === 0
      ? Infinity
      : ((dx > 0 ? rect.x + rect.w : rect.x) - start.x) / dx;
  const ty =
    dy === 0
      ? Infinity
      : ((dy > 0 ? rect.y + rect.h : rect.y) - start.y) / dy;
  const t = Math.min(tx, ty);
  return { x: start.x + dx * t, y: start.y + dy * t };
}

/** Does the segment a-b pass through `rect`, shrunk by a hair? */
function segmentCrosses(a: Point, b: Point, rect: Rect): boolean {
  const left = rect.x + 3;
  const right = rect.x + rect.w - 3;
  const top = rect.y + 3;
  const bottom = rect.y + rect.h - 3;
  if (left >= right || top >= bottom) return false;
  // Liang-Barsky: clip the segment's parameter range against each side.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: Array<[number, number]> = [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function boundsOf(points: Point[]): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function fmt(point: Point): string {
  return `${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
}

/** Boxes an edge has to avoid: every node and html part that is not an end. */
function obstaclesFor(
  doc: AnimDocument,
  edgeFrom: string,
  edgeTo: string,
  from: Rect,
  to: Rect
): Array<{ id: string; rect: Rect }> {
  const out: Array<{ id: string; rect: Rect }> = [];
  for (const [id, part] of Object.entries(doc.parts)) {
    if (id === edgeFrom || id === edgeTo) continue;
    if (part.type !== "node" && part.type !== "html") continue;
    const rect = { x: part.x, y: part.y, w: part.w, h: part.h };
    // A box drawn around an end is its container, not something in the way.
    if (contains(rect, from) || contains(rect, to)) continue;
    out.push({ id, rect });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * How far this edge sits from the pair's centre line. Edges joining the same
 * two parts share the line out evenly, in id order, so each gets its own lane
 * whichever way it points.
 */
function laneOffset(
  doc: AnimDocument,
  id: string,
  from: string,
  to: string,
  room: number
): number {
  const siblings = Object.keys(doc.parts)
    .filter((other) => {
      const part = doc.parts[other];
      return (
        part.type === "edge" &&
        ((part.from === from && part.to === to) ||
          (part.from === to && part.to === from))
      );
    })
    .sort();
  if (siblings.length < 2) return 0;
  // Many edges between one pair close up, so the outer lanes still leave and
  // arrive on the boxes' facing sides rather than off their corners.
  const gap = Math.min(LANE_GAP, (room * 0.72) / (siblings.length - 1));
  return (siblings.indexOf(id) - (siblings.length - 1) / 2) * gap;
}

function arc(
  from: Rect,
  to: Rect,
  side: 1 | -1,
  lift: number,
  horizontal: boolean
): { points: [Point, Point, Point, Point]; samples: Point[] } {
  const ca = centerOf(from);
  const cb = centerOf(to);
  let a: Point;
  let b: Point;
  let c1: Point;
  let c2: Point;
  if (horizontal) {
    // Leave and arrive on the side facing the other box, a quarter of the way
    // along, so an arc out of a box and an arc into it do not share a point.
    const lean = Math.sign(cb.x - ca.x) || 1;
    a = { x: ca.x + lean * from.w * 0.25, y: side < 0 ? from.y : from.y + from.h };
    b = { x: cb.x - lean * to.w * 0.25, y: side < 0 ? to.y : to.y + to.h };
    c1 = { x: a.x, y: a.y + side * lift };
    c2 = { x: b.x, y: b.y + side * lift };
  } else {
    const lean = Math.sign(cb.y - ca.y) || 1;
    a = { x: side < 0 ? from.x : from.x + from.w, y: ca.y + lean * from.h * 0.25 };
    b = { x: side < 0 ? to.x : to.x + to.w, y: cb.y - lean * to.h * 0.25 };
    c1 = { x: a.x + side * lift, y: a.y };
    c2 = { x: b.x + side * lift, y: b.y };
  }
  const samples = Array.from({ length: ARC_SAMPLES + 1 }, (_, index) =>
    cubicAt(a, c1, c2, b, index / ARC_SAMPLES)
  );
  return { points: [a, c1, c2, b], samples };
}

/** The plate an edge's text is drawn on: as wide as the text, one line high. */
const LABEL_HEIGHT = 20;
function labelWidth(text: string): number {
  return Math.max(40, text.length * 7.6 + 16);
}
/** Where along its line a label goes when the middle is already taken. */
const LABEL_FALLBACKS = [0.28, 0.72, 0.16, 0.84];

/**
 * The route for one edge, or null when it has nothing to join.
 *
 * A label sits at the middle of its line. It moves only when another label's
 * plate would cover it there, as happens where two diagonals cross: then the
 * later edge in id order slides its label along its own line until it is
 * clear. Overlap is measured on the plates themselves, so two parallel lanes,
 * whose labels sit one above the other without touching, both stay centred.
 */
export function routeEdge(doc: AnimDocument, id: string): EdgeRoute | null {
  const route = baseRoute(doc, id);
  const part = doc.parts[id];
  if (!route || !part || part.type !== "edge" || !part.text) return route;

  const taken: Array<{ at: Point; w: number }> = [];
  for (const other of Object.keys(doc.parts).sort()) {
    if (other >= id) break;
    const otherPart = doc.parts[other];
    if (otherPart.type !== "edge" || !otherPart.text) continue;
    const otherRoute = baseRoute(doc, other);
    if (otherRoute) {
      taken.push({ at: otherRoute.label, w: labelWidth(otherPart.text) });
    }
  }
  const width = labelWidth(part.text);
  const clear = (point: Point) =>
    taken.every(
      (label) =>
        Math.abs(label.at.x - point.x) >= (label.w + width) / 2 + 6 ||
        Math.abs(label.at.y - point.y) >= LABEL_HEIGHT + 4
    );
  if (clear(route.label)) return route;

  // A label that has to move must not land on a box, its own ends included.
  const boxes = Object.values(doc.parts).flatMap((other) => {
    const rect = anchorRect(other);
    return rect && rect.w > 0 ? [rect] : [];
  });
  const offBoxes = (point: Point) =>
    boxes.every(
      (box) =>
        point.x + width / 2 <= box.x ||
        point.x - width / 2 >= box.x + box.w ||
        point.y + LABEL_HEIGHT / 2 <= box.y ||
        point.y - LABEL_HEIGHT / 2 >= box.y + box.h
    );
  for (const t of LABEL_FALLBACKS) {
    const point = route.at(t);
    if (clear(point) && offBoxes(point)) return { ...route, label: point };
  }
  return route;
}

function baseRoute(doc: AnimDocument, id: string): EdgeRoute | null {
  const part = doc.parts[id];
  if (!part || part.type !== "edge") return null;
  const from = anchorRect(doc.parts[part.from]);
  const to = anchorRect(doc.parts[part.to]);
  if (!from || !to) return null;

  const ca = centerOf(from);
  const cb = centerOf(to);
  const obstacles = obstaclesFor(doc, part.from, part.to, from, to);

  // Lanes are laid out across a direction both edges of a pair agree on, so a
  // request and its reply land on opposite sides rather than the same one.
  const flip = part.from > part.to ? -1 : 1;
  const dx = (cb.x - ca.x) * flip;
  const dy = (cb.y - ca.y) * flip;
  const length = Math.hypot(dx, dy) || 1;
  // How much of the facing sides the lanes may use: the smaller box's extent
  // across the line between them.
  const across = (rect: Rect) =>
    (Math.abs(dy) * rect.w + Math.abs(dx) * rect.h) / length;
  const room = Math.min(across(from) || Infinity, across(to) || Infinity);
  const offset = laneOffset(
    doc,
    id,
    part.from,
    part.to,
    Number.isFinite(room) ? room : LANE_GAP * 4
  );
  const shift = { x: (-dy / length) * offset, y: (dx / length) * offset };
  const sa = { x: ca.x + shift.x, y: ca.y + shift.y };
  const sb = { x: cb.x + shift.x, y: cb.y + shift.y };
  const a = exitPoint(from, sa, sb);
  const b = exitPoint(to, sb, sa);

  const blocked = obstacles.filter(({ rect }) => segmentCrosses(a, b, rect));
  if (blocked.length === 0) {
    return {
      d: `M${fmt(a)} L${fmt(b)}`,
      kind: "straight",
      label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      end: b,
      angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      gap: Math.hypot(b.x - a.x, b.y - a.y),
      through: [],
      bounds: boundsOf([a, b]),
      at: (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    };
  }

  const horizontal = Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y);
  const span = horizontal ? Math.abs(cb.x - ca.x) : Math.abs(cb.y - ca.y);
  // Forwards goes over (or to the right of) the boxes, back goes under.
  const forward = horizontal ? cb.x >= ca.x : cb.y >= ca.y;
  const preferred: 1 | -1 = horizontal ? (forward ? -1 : 1) : forward ? 1 : -1;
  const baseLift = Math.min(130, Math.max(56, 36 + span * 0.12));

  const hits = (samples: Point[]) =>
    obstacles.filter(({ rect }) => samples.some((point) => inside(rect, point)));
  const offStage = (samples: Point[]) =>
    samples.some(
      (point) =>
        point.x < STAGE_MARGIN ||
        point.y < STAGE_MARGIN ||
        point.x > doc.stage.width - STAGE_MARGIN ||
        point.y > doc.stage.height - STAGE_MARGIN
    );

  let best: { curve: ReturnType<typeof arc>; hit: string[] } | null = null;
  const attempts: Array<[1 | -1, number]> = [
    [preferred, baseLift],
    [-preferred as 1 | -1, baseLift],
    [preferred, baseLift * 1.7],
    [-preferred as 1 | -1, baseLift * 1.7],
  ];
  for (const [side, lift] of attempts) {
    const curve = arc(from, to, side, lift, horizontal);
    const hit = hits(curve.samples).map((item) => item.id);
    const clean = hit.length === 0 && !offStage(curve.samples);
    if (clean) {
      best = { curve, hit };
      break;
    }
    if (!best || hit.length < best.hit.length) best = { curve, hit };
  }
  const { curve, hit } = best as { curve: ReturnType<typeof arc>; hit: string[] };
  const [p0, p1, p2, p3] = curve.points;

  return {
    d: `M${fmt(p0)} C${fmt(p1)}, ${fmt(p2)}, ${fmt(p3)}`,
    kind: "arc",
    label: cubicAt(p0, p1, p2, p3, 0.5),
    end: p3,
    angle: (Math.atan2(p3.y - p2.y, p3.x - p2.x) * 180) / Math.PI,
    gap: Infinity,
    through: hit,
    bounds: boundsOf(curve.samples),
    at: (t) => cubicAt(p0, p1, p2, p3, t),
  };
}
