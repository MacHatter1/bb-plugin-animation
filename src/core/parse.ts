/**
 * Reading `.scene.json` from disk.
 *
 * The parser is deliberately forgiving. Any agent with `Read`/`Edit` is a
 * first-class author of this file, so the common failure is not a corrupt
 * document but a near-miss: a duration written as a string, a tone we don't
 * know, a step that names a part that was since renamed. Throwing on those
 * would make the editor refuse to open a file a human can plainly read.
 *
 * So: repair what is repairable, record a problem, and keep going. Structural
 * damage and unsupported discriminators are errors: the editor may preview a
 * safe approximation, but saving is blocked rather than deleting source data.
 *
 * Unknown keys are **preserved**, not dropped. If a future format version (or
 * an agent working from newer instructions) writes a field this build does not
 * model, round-tripping through the editor must not silently delete it. The
 * `extras` bag carries those keys back to `serialize.ts`.
 */

import {
  DEFAULT_TONE,
  TONES,
  type AnimDocument,
  type BuildStamp,
  type Part,
  type PartAssignment,
  type Step,
  type SubPartSpec,
  type Tone,
} from "./types";

export interface Problem {
  level: "error" | "warning";
  /** Dotted path into the document, e.g. `steps[2].duration`. */
  path: string;
  message: string;
}

export interface DocumentExtras {
  root: Record<string, unknown>;
  stage: Record<string, unknown>;
  parts: Record<string, Record<string, unknown>>;
  rows: Record<string, Array<Record<string, unknown>>>;
  steps: Record<string, Record<string, unknown>>;
  assignments: Record<string, Record<string, Record<string, unknown>>>;
  /** Unknown keys inside a `subParts` entry, keyed part id then sub-part id. */
  subParts: Record<string, Record<string, Record<string, unknown>>>;
}

export interface ParseResult {
  doc: AnimDocument;
  extras: DocumentExtras;
  problems: Problem[];
}

const MIN_STEP_MS = 1;
const MAX_STEP_MS = 600_000;
const MIN_STAGE = 16;
const MAX_STAGE = 8192;

export function createEmptyExtras(): DocumentExtras {
  return {
    root: {},
    stage: {},
    parts: {},
    rows: {},
    steps: {},
    assignments: {},
    subParts: {},
  };
}

export function createEmptyDocument(): AnimDocument {
  return {
    version: 1,
    stage: { width: 1080, height: 470, fps: 25 },
    parts: {},
    steps: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept a number written as a number or as a numeric string. Agents and hand
 * edits produce `"800"` often enough that rejecting it would be pedantry.
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function coerceTone(
  value: unknown,
  path: string,
  problems: Problem[]
): Tone | undefined {
  if (value === undefined) return undefined;
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((TONES as readonly string[]).includes(s)) return s as Tone;
  problems.push({
    level: "warning",
    path,
    message: `Unknown tone ${JSON.stringify(
      value
    )}; falling back to "${DEFAULT_TONE}".`,
  });
  return undefined;
}

/**
 * `vars` for an html part: a flat string map, and nothing else.
 *
 * Non-string scalars are coerced rather than rejected -- an agent writing
 * `"count": 4` means the text "4" -- but a nested object or array is dropped
 * with a warning, because there is no substitution semantics that would make it
 * meaningful and silently stringifying it would print "[object Object]" on the
 * stage.
 */
function coerceVars(
  value: unknown,
  path: string,
  problems: Problem[]
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push({
      level: "warning",
      path: `${path}.vars`,
      message: "Vars must be an object of strings; ignored.",
    });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const text =
      typeof raw === "boolean" ? String(raw) : coerceString(raw);
    if (text === undefined) {
      problems.push({
        level: "warning",
        path: `${path}.vars.${key}`,
        message: "Var is not a string; ignored.",
      });
      continue;
    }
    out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `subParts`: what the compiler observed the component emit.
 *
 * Values are baselines, so tone goes through the same coercion a part's does.
 * Unknown keys inside an entry are handed to `extras` rather than dropped --
 * this is generated content, but a future compiler writing a field this build
 * does not model must not have it deleted by an unrelated save.
 */
function coerceSubParts(
  partId: string,
  value: unknown,
  path: string,
  problems: Problem[],
  extras: DocumentExtras
): Record<string, SubPartSpec> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    problems.push({
      level: "warning",
      path: `${path}.subParts`,
      message: "Sub-parts must be an object; ignored.",
    });
    return undefined;
  }
  const out: Record<string, SubPartSpec> = {};
  const leftovers: Record<string, Record<string, unknown>> = {};
  for (const [subId, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      problems.push({
        level: "warning",
        path: `${path}.subParts.${subId}`,
        message: "Not an object; sub-part ignored.",
      });
      continue;
    }
    const label = coerceString(raw.label);
    const tone = coerceTone(raw.tone, `${path}.subParts.${subId}.tone`, problems);
    const state = coerceString(raw.state);
    const extra = leftoverKeys(raw, ["label", "tone", "state"]);
    if (raw.tone !== undefined && tone === undefined) extra.tone = raw.tone;
    if (Object.keys(extra).length > 0) leftovers[subId] = extra;
    out[subId] = {
      ...(label !== undefined ? { label } : {}),
      ...(tone !== undefined ? { tone } : {}),
      ...(state !== undefined ? { state } : {}),
    };
  }
  if (Object.keys(leftovers).length > 0) extras.subParts[partId] = leftovers;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Collect keys we did not consume so the serializer can write them back. */
function leftoverKeys(
  source: Record<string, unknown>,
  consumed: readonly string[]
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!consumed.includes(key)) extra[key] = source[key];
  }
  return extra;
}

/**
 * `stage.theme`: a flat map of colour strings, and nothing else.
 *
 * Deliberately not validated against a token list. The known-token names are
 * one namespace and the project's own `--custom-property` names are another,
 * and which is which is `resolveStageTheme`'s business at render time -- the
 * parser rejecting an unfamiliar name would make adding a project token a
 * change to the extension.
 */
function coerceTheme(
  value: unknown,
  problems: Problem[]
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    problems.push({
      level: "warning",
      path: "stage.theme",
      message: "Theme must be an object of colour strings; ignored.",
    });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const text = coerceString(raw);
    if (text === undefined) {
      problems.push({
        level: "warning",
        path: `stage.theme.${key}`,
        message: "Theme value is not a string; ignored.",
      });
      continue;
    }
    out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const STAGE_KEYS = ["width", "height", "fps", "background", "theme"];

function parseStage(
  raw: unknown,
  problems: Problem[],
  extras: DocumentExtras
): AnimDocument["stage"] {
  const fallback = createEmptyDocument().stage;
  if (!isPlainObject(raw)) {
    if (raw !== undefined) {
      problems.push({
        level: "warning",
        path: "stage",
        message: "Not an object; using defaults.",
      });
    }
    return fallback;
  }
  extras.stage = leftoverKeys(raw, STAGE_KEYS);

  const width = coerceNumber(raw.width);
  const height = coerceNumber(raw.height);
  const fps = coerceNumber(raw.fps);

  const stage: AnimDocument["stage"] = {
    width:
      width === null
        ? fallback.width
        : Math.round(clamp(width, MIN_STAGE, MAX_STAGE)),
    height:
      height === null
        ? fallback.height
        : Math.round(clamp(height, MIN_STAGE, MAX_STAGE)),
    fps: fps === null ? fallback.fps : Math.round(clamp(fps, 1, 120)),
  };
  const background = coerceString(raw.background);
  if (background) stage.background = background;
  const theme = coerceTheme(raw.theme, problems);
  if (theme) stage.theme = theme;

  if (width !== null && stage.width !== width) {
    problems.push({
      level: "warning",
      path: "stage.width",
      message: `Clamped to ${stage.width}.`,
    });
  }
  if (height !== null && stage.height !== height) {
    problems.push({
      level: "warning",
      path: "stage.height",
      message: `Clamped to ${stage.height}.`,
    });
  }
  if (fps !== null && stage.fps !== fps) {
    problems.push({
      level: "warning",
      path: "stage.fps",
      message: `Clamped to ${stage.fps}.`,
    });
  }
  return stage;
}

const COMMON_PART_KEYS = ["type", "label", "tone", "state"];

function parsePart(
  id: string,
  raw: unknown,
  problems: Problem[],
  extras: DocumentExtras
): Part | null {
  const path = `parts.${id}`;
  if (!isPlainObject(raw)) {
    problems.push({
      level: "error",
      path,
      message: "Not an object; part dropped.",
    });
    return null;
  }

  const declared =
    typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const label = coerceString(raw.label);
  const tone = coerceTone(raw.tone, `${path}.tone`, problems);
  const state = coerceString(raw.state);

  const base = {
    ...(label !== undefined ? { label } : {}),
    ...(tone !== undefined ? { tone } : {}),
    ...(state !== undefined ? { state } : {}),
  };

  const preserveInvalidTone = (extra: Record<string, unknown>): void => {
    if (raw.tone !== undefined && tone === undefined) extra.tone = raw.tone;
  };

  const num = (key: string, fallback: number): number => {
    const n = coerceNumber(raw[key]);
    if (n === null) {
      if (raw[key] !== undefined) {
        problems.push({
          level: "warning",
          path: `${path}.${key}`,
          message: `Not a number; using ${fallback}.`,
        });
      }
      return fallback;
    }
    return Math.round(n);
  };

  const dimension = (key: "w" | "h", fallback: number): number => {
    const value = num(key, fallback);
    const bounded = Math.round(clamp(value, 1, MAX_STAGE));
    if (bounded !== value) {
      problems.push({
        level: "warning",
        path: `${path}.${key}`,
        message: `Dimension ${value} is out of range; clamped to ${bounded}.`,
      });
    }
    return bounded;
  };

  switch (declared) {
    case "edge": {
      const from = coerceString(raw.from);
      const to = coerceString(raw.to);
      if (!from || !to) {
        problems.push({
          level: "error",
          path,
          message: 'Edge needs both "from" and "to"; part dropped.',
        });
        return null;
      }
      extras.parts[id] = leftoverKeys(raw, [
        ...COMMON_PART_KEYS,
        "from",
        "to",
        "text",
        "packets",
      ]);
      preserveInvalidTone(extras.parts[id]);
      const text = coerceString(raw.text);
      const packetsRaw = coerceNumber(raw.packets);
      const packets =
        packetsRaw === null ? undefined : Math.round(clamp(packetsRaw, 0, 12));
      if (packetsRaw !== null && packets !== Math.round(packetsRaw)) {
        problems.push({
          level: "warning",
          path: `${path}.packets`,
          message: `Clamped to ${packets}.`,
        });
      }
      return {
        type: "edge",
        ...base,
        from,
        to,
        ...(text !== undefined ? { text } : {}),
        ...(packets !== undefined ? { packets } : {}),
      };
    }

    case "label": {
      const text = coerceString(raw.text) ?? label ?? id;
      extras.parts[id] = leftoverKeys(raw, [
        ...COMMON_PART_KEYS,
        "x",
        "y",
        "text",
        "align",
        "caps",
      ]);
      preserveInvalidTone(extras.parts[id]);
      const alignRaw = coerceString(raw.align);
      const align =
        alignRaw === "start" || alignRaw === "middle" || alignRaw === "end"
          ? alignRaw
          : undefined;
      if (raw.align !== undefined && align === undefined)
        extras.parts[id].align = raw.align;
      return {
        type: "label",
        ...base,
        x: num("x", 0),
        y: num("y", 0),
        text,
        ...(align !== undefined ? { align } : {}),
        ...(raw.caps === true ? { caps: true } : {}),
      };
    }

    case "shape": {
      extras.parts[id] = leftoverKeys(raw, [
        ...COMMON_PART_KEYS,
        "x",
        "y",
        "w",
        "h",
        "shape",
        "text",
      ]);
      preserveInvalidTone(extras.parts[id]);
      const shapeRaw = coerceString(raw.shape);
      const shape =
        shapeRaw === "circle"
          ? "circle"
          : shapeRaw === "rect"
          ? "rect"
          : undefined;
      if (raw.shape !== undefined && shape === undefined)
        extras.parts[id].shape = raw.shape;
      const text = coerceString(raw.text);
      return {
        type: "shape",
        ...base,
        x: num("x", 0),
        y: num("y", 0),
        w: dimension("w", 80),
        h: dimension("h", 80),
        ...(shape !== undefined ? { shape } : {}),
        ...(text !== undefined ? { text } : {}),
      };
    }

    case "html": {
      extras.parts[id] = leftoverKeys(raw, [
        ...COMMON_PART_KEYS,
        "x",
        "y",
        "w",
        "h",
        "html",
        "htmlFile",
        "vars",
        "component",
        "props",
        "subParts",
        "build",
      ]);
      preserveInvalidTone(extras.parts[id]);

      const markup = coerceString(raw.html);
      const htmlFile = coerceString(raw.htmlFile);
      const vars = coerceVars(raw.vars, path, problems);
      const component = coerceString(raw.component);
      const subParts = coerceSubParts(id, raw.subParts, path, problems, extras);

      // Props are the compiler's business, not the parser's: they are carried
      // by reference and written back untouched, so a compile and a save cannot
      // fight over key order or over a value shape this build has no opinion on.
      const props = isPlainObject(raw.props)
        ? (raw.props as Record<string, unknown>)
        : undefined;
      if (raw.props !== undefined && props === undefined) {
        problems.push({
          level: "warning",
          path: `${path}.props`,
          message: "Props must be an object; kept but not used.",
        });
        extras.parts[id].props = raw.props;
      }

      // Carried by reference for the same reason as `props`: it is the
      // compiler's record of its own inputs, and nothing here reads it.
      const build = isPlainObject(raw.build)
        ? (raw.build as BuildStamp)
        : undefined;
      if (raw.build !== undefined && build === undefined) {
        extras.parts[id].build = raw.build;
      }

      // `htmlFile` wins over inline `html`. Say so when both are present rather
      // than silently honouring one: a part that draws markup the author did
      // not expect is far harder to spot than a warning.
      const sources = [
        htmlFile !== undefined ? "htmlFile" : null,
        markup !== undefined ? "html" : null,
      ].filter((name): name is string => name !== null);

      if (sources.length === 0) {
        // A `component` with no `html` yet is a document that has been written
        // but not compiled -- a normal intermediate state, and a warning rather
        // than a dropped part so the author can still see and edit their props.
        if (component !== undefined) {
          problems.push({
            level: "warning",
            path: `${path}.html`,
            message:
              'Component part has no compiled markup yet; run the compiler.',
          });
        } else {
          problems.push({
            level: "error",
            path: `${path}.html`,
            message: 'Html part needs "html", "htmlFile" or "component"; part dropped.',
          });
          return null;
        }
      }
      if (sources.length > 1) {
        problems.push({
          level: "warning",
          path,
          message: 'Html part sets htmlFile and html; using "htmlFile".',
        });
      }

      return {
        type: "html",
        ...base,
        x: num("x", 0),
        y: num("y", 0),
        w: dimension("w", 200),
        h: dimension("h", 120),
        // Both sources the author wrote are kept, even the one precedence will
        // ignore, so a save never silently deletes markup they can still see in
        // the file. `resolveHtmlMarkup` applies the same order at render time.
        ...(component !== undefined ? { component } : {}),
        ...(props !== undefined ? { props } : {}),
        ...(subParts !== undefined ? { subParts } : {}),
        ...(build !== undefined ? { build } : {}),
        ...(htmlFile !== undefined ? { htmlFile } : {}),
        ...(markup !== undefined ? { html: markup } : {}),
        ...(vars !== undefined ? { vars } : {}),
      };
    }

    case "node":
    default: {
      if (declared !== "node") {
        problems.push({
          level: declared === "" ? "warning" : "error",
          path: `${path}.type`,
          message:
            declared === ""
              ? 'Missing type; using "node".'
              : `Unsupported type ${JSON.stringify(
                  raw.type
                )}; previewed as "node" but saving is blocked.`,
        });
      }
      extras.parts[id] = leftoverKeys(raw, [
        ...COMMON_PART_KEYS,
        "x",
        "y",
        "w",
        "h",
        "subtitle",
        "rows",
      ]);
      preserveInvalidTone(extras.parts[id]);
      if (declared !== "node" && raw.type !== undefined)
        extras.parts[id].type = raw.type;
      const subtitle = coerceString(raw.subtitle);
      const rows: Array<{ key: string; value?: string }> = [];
      const rowExtras: Array<Record<string, unknown>> = [];
      if (Array.isArray(raw.rows)) {
        raw.rows.forEach((row, index) => {
          if (!isPlainObject(row)) {
            problems.push({
              level: "error",
              path: `${path}.rows[${index}]`,
              message:
                "Not an object; row omitted from the preview and saving is blocked.",
            });
            return;
          }
          const key = coerceString(row.key);
          if (!key) {
            problems.push({
              level: "error",
              path: `${path}.rows[${index}].key`,
              message:
                "Missing row key; row omitted from the preview and saving is blocked.",
            });
            return;
          }
          const value = coerceString(row.value);
          rows.push({ key, ...(value !== undefined ? { value } : {}) });
          rowExtras.push(leftoverKeys(row, ["key", "value"]));
        });
      } else if (raw.rows !== undefined) {
        problems.push({
          level: "error",
          path: `${path}.rows`,
          message:
            "Not an array; rows omitted from the preview and saving is blocked.",
        });
      }
      if (rowExtras.length > 0) extras.rows[id] = rowExtras;
      return {
        type: "node",
        ...base,
        x: num("x", 0),
        y: num("y", 0),
        w: dimension("w", 200),
        h: dimension("h", 120),
        ...(subtitle !== undefined ? { subtitle } : {}),
        ...(rows.length > 0 ? { rows } : {}),
      };
    }
  }
}

const STEP_KEYS = ["id", "duration", "caption", "set"];

function parseStep(
  raw: unknown,
  index: number,
  usedIds: Set<string>,
  knownParts: Set<string>,
  problems: Problem[],
  extras: DocumentExtras
): Step | null {
  const path = `steps[${index}]`;
  if (!isPlainObject(raw)) {
    problems.push({
      level: "error",
      path,
      message: "Not an object; step dropped.",
    });
    return null;
  }

  let id = coerceString(raw.id)?.trim() || `step-${index + 1}`;
  if (usedIds.has(id)) {
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n += 1;
    problems.push({
      level: "warning",
      path: `${path}.id`,
      message: `Duplicate step id "${id}"; renamed to "${id}-${n}".`,
    });
    id = `${id}-${n}`;
  }
  usedIds.add(id);

  const rawDuration = coerceNumber(raw.duration);
  let duration = rawDuration === null ? 800 : Math.round(rawDuration);
  if (rawDuration === null && raw.duration !== undefined) {
    problems.push({
      level: "warning",
      path: `${path}.duration`,
      message: "Not a number; using 800ms.",
    });
  }
  if (duration < MIN_STEP_MS || duration > MAX_STEP_MS) {
    const clamped = clamp(duration, MIN_STEP_MS, MAX_STEP_MS);
    problems.push({
      level: "warning",
      path: `${path}.duration`,
      message: `Duration ${duration}ms out of range; clamped to ${clamped}ms.`,
    });
    duration = clamped;
  }

  const set: Record<string, PartAssignment> = {};
  const assignmentExtras: Record<string, Record<string, unknown>> = {};
  if (isPlainObject(raw.set)) {
    for (const [partId, assignment] of Object.entries(raw.set)) {
      if (!isPlainObject(assignment)) {
        problems.push({
          level: "error",
          path: `${path}.set.${partId}`,
          message:
            "Not an object; assignment omitted from the preview and saving is blocked.",
        });
        continue;
      }
      if (!knownParts.has(partId)) {
        // Kept, not dropped: renaming a part should not silently delete the
        // steps that drive it. The renderer ignores it; the author can see it.
        problems.push({
          level: "warning",
          path: `${path}.set.${partId}`,
          message: `No part named "${partId}"; assignment kept but inert.`,
        });
      }
      const state = coerceString(assignment.state);
      const tone = coerceTone(
        assignment.tone,
        `${path}.set.${partId}.tone`,
        problems
      );
      const extra = leftoverKeys(assignment, ["state", "tone"]);
      if (assignment.tone !== undefined && tone === undefined)
        extra.tone = assignment.tone;
      if (Object.keys(extra).length > 0) assignmentExtras[partId] = extra;
      const entry: PartAssignment = {
        ...(state !== undefined ? { state } : {}),
        ...(tone !== undefined ? { tone } : {}),
      };
      if (Object.keys(entry).length > 0 || Object.keys(extra).length > 0)
        set[partId] = entry;
    }
  } else if (raw.set !== undefined) {
    problems.push({
      level: "error",
      path: `${path}.set`,
      message:
        "Not an object; assignments omitted from the preview and saving is blocked.",
    });
  }

  extras.steps[id] = leftoverKeys(raw, STEP_KEYS);
  if (Object.keys(assignmentExtras).length > 0)
    extras.assignments[id] = assignmentExtras;
  const caption = coerceString(raw.caption);
  return {
    id,
    duration,
    ...(caption !== undefined ? { caption } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
  };
}

const ROOT_KEYS = ["version", "stage", "parts", "steps"];

/**
 * Parse document text. Never throws; unparseable input comes back as an empty
 * document plus an error problem, so the editor can show the failure instead of
 * refusing to mount.
 */
export function parseDocument(text: string): ParseResult {
  const problems: Problem[] = [];
  const extras = createEmptyExtras();

  let raw: unknown;
  if (text.trim() === "") {
    return { doc: createEmptyDocument(), extras, problems };
  }
  try {
    raw = JSON.parse(text);
  } catch (err) {
    problems.push({
      level: "error",
      path: "",
      message: `Not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return { doc: createEmptyDocument(), extras, problems };
  }

  if (!isPlainObject(raw)) {
    problems.push({
      level: "error",
      path: "",
      message: "Top level is not an object.",
    });
    return { doc: createEmptyDocument(), extras, problems };
  }

  extras.root = leftoverKeys(raw, ROOT_KEYS);

  if (raw.version !== undefined && raw.version !== 1) {
    problems.push({
      level: "error",
      path: "version",
      message: `Unsupported version ${JSON.stringify(
        raw.version
      )}; previewed as version 1 but saving is blocked.`,
    });
    extras.root.version = raw.version;
  }

  const stage = parseStage(raw.stage, problems, extras);

  const parts: Record<string, Part> = {};
  if (isPlainObject(raw.parts)) {
    for (const [id, value] of Object.entries(raw.parts)) {
      const part = parsePart(id, value, problems, extras);
      if (part) parts[id] = part;
    }
  } else if (raw.parts !== undefined) {
    problems.push({
      level: "error",
      path: "parts",
      message: "Not an object; no parts previewed and saving is blocked.",
    });
  }

  // Sub-parts are step targets in their own right, so a step naming
  // `chrome/session-a` is addressing something real and must not be warned at.
  const knownParts = new Set(Object.keys(parts));
  for (const [id, part] of Object.entries(parts)) {
    if (part.type !== "html" || !part.subParts) continue;
    for (const subId of Object.keys(part.subParts)) {
      knownParts.add(`${id}/${subId}`);
    }
  }
  const usedIds = new Set<string>();
  const steps: Step[] = [];
  if (Array.isArray(raw.steps)) {
    raw.steps.forEach((value, index) => {
      const step = parseStep(
        value,
        index,
        usedIds,
        knownParts,
        problems,
        extras
      );
      if (step) steps.push(step);
    });
  } else if (raw.steps !== undefined) {
    problems.push({
      level: "error",
      path: "steps",
      message: "Not an array; no steps previewed and saving is blocked.",
    });
  }

  return { doc: { version: 1, stage, parts, steps }, extras, problems };
}
