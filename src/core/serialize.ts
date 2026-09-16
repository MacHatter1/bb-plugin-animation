/**
 * Writing `.scene.json` back to disk, canonically.
 *
 * The invariant this file exists to hold: **an agent editing the file by hand
 * and the editor performing the same edit must produce byte-identical output.**
 * If they diverge, every agent edit shows up as a spurious diff the next time
 * the editor saves, and the file stops being a shared authoring surface.
 *
 * That means output is fully determined by the document: fixed key order (not
 * insertion order, which differs between a hand edit and a rebuilt object),
 * two-space indent, one trailing newline. Unknown keys carried in `extras` are
 * written after the known ones in sorted order, so a field this build does not
 * model still round-trips.
 */

import type { AnimDocument, Part, Step } from "./types";
import { createEmptyExtras, type DocumentExtras } from "./parse";

const STAGE_ORDER = ["width", "height", "fps", "background", "theme"] as const;

/**
 * A sub-part entry's key order. Sub-part *ids* keep the order the compiler
 * emitted them in, which is DOM order -- sorting them would scramble the one
 * cue an author has for where a region sits inside the component.
 */
const SUB_PART_ORDER = ["label", "tone", "state"] as const;

const PART_ORDER: Record<Part["type"], readonly string[]> = {
  node: [
    "type",
    "label",
    "tone",
    "state",
    "x",
    "y",
    "w",
    "h",
    "subtitle",
    "rows",
  ],
  edge: ["type", "label", "tone", "state", "from", "to", "text", "packets"],
  label: ["type", "label", "tone", "state", "x", "y", "text", "align", "caps"],
  shape: [
    "type",
    "label",
    "tone",
    "state",
    "x",
    "y",
    "w",
    "h",
    "shape",
    "text",
  ],
  html: [
    "type",
    "label",
    "tone",
    "state",
    "x",
    "y",
    "w",
    "h",
    "component",
    "props",
    "subParts",
    "build",
    "htmlFile",
    "html",
    "vars",
  ],
};

const STEP_ORDER = ["id", "duration", "caption", "set"] as const;
const ASSIGNMENT_ORDER = ["state", "tone"] as const;
const ROOT_ORDER = ["version", "stage", "parts", "steps"] as const;

/**
 * Rebuild `source` with `order` first (skipping absent keys), then every
 * remaining key sorted. Sorting the tail is what makes the output stable when
 * the extras bag was itself built from an object with arbitrary key order.
 */
function ordered(
  source: Record<string, unknown>,
  order: readonly string[],
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  const tail = { ...extra };
  for (const key of Object.keys(source)) {
    if (!order.includes(key) && source[key] !== undefined)
      tail[key] = source[key];
  }
  for (const key of Object.keys(tail).sort()) {
    if (tail[key] !== undefined) out[key] = tail[key];
  }
  return out;
}

function serializePart(
  part: Part,
  extra?: Record<string, unknown>,
  rowExtras?: Array<Record<string, unknown>>,
  subPartExtras?: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  if (part.type === "html" && part.subParts) {
    const subParts: Record<string, unknown> = {};
    for (const [subId, spec] of Object.entries(part.subParts)) {
      subParts[subId] = ordered(
        spec as unknown as Record<string, unknown>,
        SUB_PART_ORDER,
        subPartExtras?.[subId]
      );
    }
    return ordered(
      { ...part, subParts } as unknown as Record<string, unknown>,
      PART_ORDER.html,
      extra
    );
  }
  if (part.type !== "node" || !part.rows) {
    return ordered(
      part as unknown as Record<string, unknown>,
      PART_ORDER[part.type],
      extra
    );
  }
  const source = {
    ...part,
    rows: part.rows.map((row, index) =>
      ordered(
        row as unknown as Record<string, unknown>,
        ["key", "value"],
        rowExtras?.[index]
      )
    ),
  };
  return ordered(
    source as unknown as Record<string, unknown>,
    PART_ORDER.node,
    extra
  );
}

function serializeStep(
  step: Step,
  extra?: Record<string, unknown>,
  assignmentExtras?: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  const set = step.set ?? {};
  const assignmentIds = [
    ...new Set([...Object.keys(set), ...Object.keys(assignmentExtras ?? {})]),
  ];
  const normalizedSet =
    assignmentIds.length > 0
      ? assignmentIds.sort().reduce<Record<string, unknown>>((acc, partId) => {
          acc[partId] = ordered(
            (set[partId] ?? {}) as unknown as Record<string, unknown>,
            ASSIGNMENT_ORDER,
            assignmentExtras?.[partId]
          );
          return acc;
        }, {})
      : undefined;

  const source: Record<string, unknown> = {
    id: step.id,
    duration: step.duration,
    ...(step.caption !== undefined ? { caption: step.caption } : {}),
    ...(normalizedSet && Object.keys(normalizedSet).length > 0
      ? { set: normalizedSet }
      : {}),
  };
  return ordered(source, STEP_ORDER, extra);
}

/**
 * Build the canonical plain object for a document. Exposed separately from
 * `serializeDocument` so tests can assert on structure without re-parsing.
 */
export function toCanonicalObject(
  doc: AnimDocument,
  extras: DocumentExtras = createEmptyExtras()
): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  // Sorted so two documents with the same parts serialize identically no matter
  // which order the editor happened to insert them in.
  for (const id of Object.keys(doc.parts).sort()) {
    parts[id] = serializePart(
      doc.parts[id],
      extras.parts[id],
      extras.rows[id],
      extras.subParts[id]
    );
  }

  // Steps keep document order -- it *is* the animation.
  const steps = doc.steps.map((step) =>
    serializeStep(step, extras.steps[step.id], extras.assignments[step.id])
  );

  const root: Record<string, unknown> = {
    version: 1,
    stage: ordered(
      doc.stage as unknown as Record<string, unknown>,
      STAGE_ORDER,
      extras.stage
    ),
    parts,
    steps,
  };
  return ordered(root, ROOT_ORDER, extras.root);
}

export function serializeDocument(
  doc: AnimDocument,
  extras: DocumentExtras = createEmptyExtras()
): string {
  return `${JSON.stringify(toCanonicalObject(doc, extras), null, 2)}\n`;
}
