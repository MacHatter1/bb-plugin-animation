/**
 * Scene rendering: document to SVG markup.
 *
 * The whole scene is emitted once, up front, and never re-emitted to animate.
 * Playback works by setting `data-state` / `data-tone` on these elements and
 * letting CSS transitions do the interpolation -- which is why every part is
 * tagged with `data-part` and carries its state on the element rather than in
 * the geometry.
 *
 * Emitting markup as a string rather than building DOM keeps this a pure
 * function, so the same code path produces the in-editor stage and (later) the
 * standalone exported file, with no chance of the two diverging.
 */

import type {
  AnimDocument,
  EdgePart,
  HtmlPart,
  LabelPart,
  NodePart,
  Part,
  ShapePart,
} from "../core/types";
import { DEFAULT_STATE, DEFAULT_TONE } from "../core/types";
import { sanitizeHtml } from "../core/sanitizeHtml";
import { resolveHtmlMarkup, type HtmlAssets } from "../core/htmlParts";
import { routeEdge } from "../core/route";

/** Escape text for XML content and attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function partAttrs(id: string, part: Part, extraClass: string): string {
  const state = part.state ?? DEFAULT_STATE;
  const tone = part.tone ?? DEFAULT_TONE;
  return (
    `class="${extraClass}" data-part="${escapeXml(id)}" ` +
    `data-state="${escapeXml(state)}" data-tone="${escapeXml(tone)}"`
  );
}

function renderNode(id: string, part: NodePart): string {
  const title = escapeXml((part.label ?? id).toUpperCase());
  const headerH = 34;
  const rows = part.rows ?? [];

  const pieces: string[] = [];
  pieces.push(
    `<rect class="scene-node-body" width="${part.w}" height="${part.h}" rx="4"/>`
  );
  pieces.push(
    `<rect class="scene-node-header" width="${part.w}" height="${headerH}" rx="4"/>`
  );
  pieces.push(`<path class="scene-node-rule" d="M0 ${headerH} H${part.w}"/>`);
  pieces.push(`<text class="scene-node-title" x="16" y="23">${title}</text>`);
  pieces.push(
    `<circle class="scene-node-dot" cx="${part.w - 16}" cy="17" r="3.6"/>`
  );

  let cursor = headerH + 22;
  if (part.subtitle) {
    pieces.push(
      `<text class="scene-node-subtitle" x="16" y="${cursor}">${escapeXml(
        part.subtitle
      )}</text>`
    );
    cursor += 16;
  }

  const rowH = 26;
  const rowGap = 6;
  rows.forEach((row, index) => {
    const y = cursor + index * (rowH + rowGap);
    if (y + rowH > part.h - 6) return; // Don't spill past the node body.
    pieces.push(
      `<g class="scene-row"><rect class="scene-row-box" x="16" y="${y}" width="${
        part.w - 32
      }" height="${rowH}" rx="3"/>` +
        `<text class="scene-row-key" x="28" y="${y + 17}">${escapeXml(
          row.key
        )}</text>` +
        (row.value
          ? `<text class="scene-row-value" x="${part.w - 28}" y="${
              y + 17
            }" text-anchor="end">${escapeXml(row.value)}</text>`
          : "") +
        `</g>`
    );
  });

  return (
    `<g ${partAttrs(id, part, "scene-part scene-node")} transform="translate(${
      part.x
    } ${part.y})">` +
    pieces.join("") +
    `</g>`
  );
}

export const DEFAULT_PACKET_COUNT = 3;
/** One packet's trip along an edge, in seconds. */
export const PACKET_TRAVEL_S = 1.6;

/**
 * The travelling squares that make an edge read as carrying traffic.
 *
 * This is the one thing in the format that genuinely needs continuous motion:
 * a state change can say "this edge is busy", but only movement says "data is
 * going that way". CSS motion path does it declaratively -- each packet rides
 * the same `d` the line is drawn from, so the two can never disagree about
 * where the edge is.
 *
 * The negative `animation-delay` is what spaces them out: it starts each packet
 * partway through its own cycle, so the moment the edge turns on there is
 * already a stream rather than a single square leaving the origin.
 */
function renderEdgePackets(part: EdgePart, d: string): string {
  const count = part.packets ?? DEFAULT_PACKET_COUNT;
  if (count <= 0) return "";

  const packets: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const delay = (-(i / count) * PACKET_TRAVEL_S).toFixed(3);
    packets.push(
      `<rect class="scene-edge-packet" x="-5" y="-5" width="10" height="10" rx="2" ` +
        `style="offset-path: path('${d}'); animation-delay: ${delay}s"/>`
    );
  }
  return `<g class="scene-edge-packets">${packets.join("")}</g>`;
}

function renderEdge(id: string, part: EdgePart, doc: AnimDocument): string {
  // A dangling edge renders as nothing rather than as a line to the origin,
  // which would look like a bug in the animation rather than in the document.
  const route = routeEdge(doc, id);
  if (!route) return "";
  const { d } = route;

  const pieces: string[] = [];
  pieces.push(`<path class="scene-edge-line" d="${d}"/>`);
  // `pathLength="1"` normalises the dash maths, so the reveal can be expressed
  // as a 0..1 dash offset regardless of how long the edge actually is.
  pieces.push(`<path class="scene-edge-flow" pathLength="1" d="${d}"/>`);
  pieces.push(renderEdgePackets(part, d));

  // Arrow head, rotated to the direction the line arrives from.
  pieces.push(
    `<g class="scene-edge-arrow" transform="translate(${route.end.x.toFixed(
      1
    )} ${route.end.y.toFixed(1)}) rotate(${route.angle.toFixed(1)})">` +
      `<path d="M-10 -6 L0 0 L-10 6"/></g>`
  );

  if (part.text) {
    const label = escapeXml(part.text);
    const width = Math.max(40, label.length * 7.6 + 16);
    pieces.push(
      `<g class="scene-edge-label" transform="translate(${route.label.x.toFixed(
        1
      )} ${route.label.y.toFixed(1)})">` +
        `<rect x="${(-width / 2).toFixed(1)}" y="-11" width="${width.toFixed(
          1
        )}" height="20" rx="3"/>` +
        `<text x="0" y="4" text-anchor="middle">${label}</text></g>`
    );
  }

  return `<g ${partAttrs(id, part, "scene-part scene-edge")}>${pieces.join(
    ""
  )}</g>`;
}

function renderLabel(id: string, part: LabelPart): string {
  const anchor =
    part.align === "end" ? "end" : part.align === "middle" ? "middle" : "start";
  const cls =
    part.size === "title"
      ? "scene-label scene-label-title"
      : part.caps
        ? "scene-label scene-label-caps"
        : "scene-label";
  return (
    `<text ${partAttrs(id, part, `scene-part ${cls}`)} x="${part.x}" y="${
      part.y
    }" ` + `text-anchor="${anchor}">${escapeXml(part.text)}</text>`
  );
}

function renderShape(id: string, part: ShapePart): string {
  const body =
    part.shape === "circle"
      ? `<circle class="scene-shape-body" cx="${part.w / 2}" cy="${
          part.h / 2
        }" r="${Math.min(part.w, part.h) / 2}"/>`
      : `<rect class="scene-shape-body" width="${part.w}" height="${part.h}" rx="3"/>`;
  const text = part.text
    ? `<text class="scene-shape-text" x="${part.w / 2}" y="${
        part.h / 2 + 4
      }" text-anchor="middle">${escapeXml(part.text)}</text>`
    : "";
  return (
    `<g ${partAttrs(id, part, "scene-part scene-shape")} transform="translate(${
      part.x
    } ${part.y})">` +
    body +
    text +
    `</g>`
  );
}

/**
 * Freeform markup in a `foreignObject`.
 *
 * The markup is sanitized rather than escaped: the point of this part type is
 * that the author's elements survive as elements. What must not survive is
 * anything executable -- the standalone export is a real page carrying a real
 * script, so unchecked markup there would run on whoever opens the file.
 *
 * The XHTML namespace on the wrapper is required, not decorative: without it
 * the browser parses the subtree as SVG and silently renders nothing.
 */
function renderHtml(
  id: string,
  part: HtmlPart,
  assets?: HtmlAssets
): string {
  return (
    `<g ${partAttrs(id, part, "scene-part scene-html")} transform="translate(${
      part.x
    } ${part.y})">` +
    `<foreignObject width="${part.w}" height="${part.h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="scene-html-body">` +
    sanitizeHtml(resolveHtmlMarkup(part, assets)) +
    `</div></foreignObject></g>`
  );
}

/**
 * Draw order: edges first so they sit behind nodes, then everything else in
 * canonical id order. Explicit z-control is deliberately not in the format
 * yet; sorting here keeps the live view identical before and after save, since
 * the serializer also canonicalizes part ids.
 */
function drawOrder(doc: AnimDocument): string[] {
  const ids = Object.keys(doc.parts).sort();
  const edges = ids.filter((id) => doc.parts[id].type === "edge");
  const rest = ids.filter((id) => doc.parts[id].type !== "edge");
  return [...edges, ...rest];
}

export function renderPart(
  id: string,
  doc: AnimDocument,
  assets?: HtmlAssets
): string {
  const part = doc.parts[id];
  if (!part) return "";
  switch (part.type) {
    case "node":
      return renderNode(id, part);
    case "edge":
      return renderEdge(id, part, doc);
    case "label":
      return renderLabel(id, part);
    case "shape":
      return renderShape(id, part);
    case "html":
      return renderHtml(id, part, assets);
    default:
      return "";
  }
}

/** A description of the animation for assistive technology. */
export function sceneAriaLabel(doc: AnimDocument): string {
  const partCount = Object.keys(doc.parts).length;
  const captions = doc.steps
    .map((s) => s.caption?.trim())
    .filter((c): c is string => Boolean(c));
  const narration = captions.length > 0 ? ` Steps: ${captions.join(" ")}` : "";
  return `Animated diagram with ${partCount} parts and ${doc.steps.length} steps.${narration}`;
}

export function renderScene(doc: AnimDocument, assets?: HtmlAssets): string {
  const body = drawOrder(doc)
    .map((id) => renderPart(id, doc, assets))
    .join("");
  return (
    `<svg class="scene-stage" xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${doc.stage.width} ${doc.stage.height}" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" ` +
    // Everything sits inside one group, so a step's `focus` can zoom the whole
    // scene by setting a single transform instead of touching every part.
    `aria-label="${escapeXml(
      sceneAriaLabel(doc)
    )}"><g class="scene-camera">${body}</g></svg>`
  );
}
