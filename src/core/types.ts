/**
 * The `.scene.json` document model.
 *
 * The animation is a named scene plus an ordered list of steps that assign
 * states to the scene's parts. Interpolation between steps is delegated to CSS
 * transitions, so the document says *what is true when*, never *how to tween*.
 *
 * Two properties are load-bearing and every change here has to preserve them:
 *
 * - **Times are integer milliseconds.** Never frame indices, never floats.
 *   Frames belong to rendering and export, not to the document.
 * - **Ids are names an agent can read and write.** `store`, `title-card`. Not
 *   generated handles. A plain `Edit` on this file has to be as legitimate an
 *   authoring path as the editor's own drag, which is what `serialize.ts`
 *   exists to guarantee.
 */

/** Part kinds the renderer knows how to draw. */
export type PartType = 'node' | 'edge' | 'label' | 'shape' | 'html';

/** Semantic colour roles, mapped to `--nim-*` tokens by the stage stylesheet. */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'data'
  | 'success'
  | 'warning'
  | 'error'
  | 'muted';

/**
 * A stamped palette. Keys naming a `ThemeTokens` field (`bg`, `accent`, ...)
 * override that token; keys of the form `--some-name` are emitted verbatim as
 * extra custom properties, which is how a project carries its own vocabulary
 * (`--nim-panel`, `--nim-phase-implementing`) into the stage.
 *
 * Stamped values rather than a theme *name* on purpose: no consumer then needs
 * a theme registry, and the extension stays neutral about whose product this is.
 * The cost is that changing a theme in the app does not reach existing
 * documents until they are restamped.
 */
export type StageTheme = Record<string, string>;

export interface StageSpec {
  width: number;
  height: number;
  fps: number;
  /** Optional background override; defaults to the stage surface token. */
  background?: string;
  /**
   * The palette this document renders under, read identically by the editor
   * preview and by every export. Absent means the stage's built-in fallback.
   */
  theme?: StageTheme;
}

interface PartBase {
  type: PartType;
  /** Human-facing name. Falls back to the part id when absent. */
  label?: string;
  /** Baseline tone before any step overrides it. */
  tone?: Tone;
  /** Baseline state before any step overrides it. Defaults to `idle`. */
  state?: string;
}

export interface NodePart extends PartBase {
  type: 'node';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Small mono line under the title. */
  subtitle?: string;
  /** Rows rendered inside the node body, e.g. key/value pairs. */
  rows?: Array<{ key: string; value?: string }>;
}

export interface EdgePart extends PartBase {
  type: 'edge';
  /** Part ids. The renderer resolves them to node anchor points. */
  from: string;
  to: string;
  /** Caption drawn at the midpoint. */
  text?: string;
  /**
   * How many packets travel the edge while it is flowing. 0 turns them off for
   * an edge that represents a relationship rather than traffic.
   */
  packets?: number;
}

export interface LabelPart extends PartBase {
  type: 'label';
  x: number;
  y: number;
  text: string;
  align?: 'start' | 'middle' | 'end';
  /** Rendered in the small tracked-out caps style used for scene captions. */
  caps?: boolean;
}

export interface ShapePart extends PartBase {
  type: 'shape';
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'rect' | 'circle';
  text?: string;
}

/**
 * Freeform markup, drawn in a `foreignObject` at the given box.
 *
 * The escape hatch for everything the primitive part types cannot express:
 * real typography and type scale, flow layout, a UI mock that has to look like
 * the product rather than like a diagram of it. `node`/`shape` deliberately
 * have no font-size control, and this is the answer to that, not a workaround.
 *
 * Two constraints keep it from undermining the format:
 *
 * - **The markup is static.** Script is stripped (see `sanitizeHtml`), so a
 *   frame stays a pure function of (document, t) and the editor, the packaged
 *   HTML and the GIF capture cannot disagree.
 * - **State still comes from steps.** The part gets the usual
 *   `data-state`/`data-tone` hooks, and `--scene-tone` resolves inside the
 *   markup, so authored HTML animates through the same mechanism as everything
 *   else instead of bringing its own.
 *
 * The markup comes from one of two places:
 *
 * - `htmlFile` points at a `.html` file beside the document. This is how a set
 *   of animations shares one look: keep a `partials/` folder of the surfaces
 *   your product actually has, and reference them by name. Authoring long
 *   markup as a JSON string literal is what forced generator scripts to exist,
 *   and this is the way out.
 * - `html` is the markup inline. Still right for a few lines.
 *
 * Deliberately no bundled component library. The interesting markup is always
 * the author's own product, and a partial shipped here could only ever be
 * somebody else's app.
 *
 * `vars` substitutes `{{name}}` placeholders in whichever source won, with the
 * values HTML-escaped. That is deliberately the whole template language: enough
 * to use one partial five times with different text, not enough to grow logic
 * that would have to be re-implemented by every renderer.
 */
export interface HtmlPart extends PartBase {
  type: 'html';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Inline markup. Sanitized at the render boundary; never trusted as authored. */
  html?: string;
  /** Path to a `.html` file, relative to the `.scene.json` that names it. */
  htmlFile?: string;
  /** `{{name}}` substitutions, HTML-escaped before they reach the markup. */
  vars?: Record<string, string>;
  /**
   * Path to a `.tsx` component, relative to the document.
   *
   * Authoring only. Nothing renders it: a compile step runs the component with
   * `props` and writes the result into `html`, so every consumer keeps drawing
   * the same static string and none of them needs React, a bundler, or the
   * filesystem. `component` and `props` are here so a recompile has its inputs
   * in the document rather than in someone's shell history.
   */
  component?: string;
  /**
   * Arguments the component was rendered with.
   *
   * Carried opaquely -- parsed once and written back by reference. The
   * extension has no schema for it and must never reorder or coerce it, or a
   * compile and a save would fight over the file.
   */
  props?: Record<string, unknown>;
  /**
   * Animatable regions the compiled markup declares, keyed by the id after the
   * `partId/` prefix. Generated: the compiler rewrites this from the markup it
   * just produced, so it cannot describe a region the component stopped
   * emitting.
   */
  subParts?: Record<string, SubPartSpec>;
  /** Staleness hashes. Never consulted at render time -- see `parse.ts`. */
  build?: BuildStamp;
}

/** A sub-part's baseline, before any step assigns to `partId/subId`. */
export interface SubPartSpec {
  /** Human-facing name for the selection readout. */
  label?: string;
  /**
   * Baseline tone. Absent -- and `neutral` -- both mean "inherit the enclosing
   * part's tone"; see the `.scene-subpart` block in `stageCss.ts`.
   */
  tone?: Tone;
  /** Baseline state before any step overrides it. Defaults to `idle`. */
  state?: string;
}

/**
 * What the last compile saw.
 *
 * `props` is a hash of the props in this document, so *any* consumer can notice
 * "these props were edited and never recompiled" with no filesystem at all.
 * `source` covers the component module and everything it imports, so it can
 * only be checked where the `.tsx` is readable. Neither is consulted while
 * rendering: a stale document draws the last thing compiled, which someone can
 * look at and understand, rather than nothing.
 */
export interface BuildStamp {
  props?: string;
  source?: string;
}

export type Part = NodePart | EdgePart | LabelPart | ShapePart | HtmlPart;

/** What a step asserts about one part. */
export interface PartAssignment {
  state?: string;
  tone?: Tone;
}

export interface Step {
  id: string;
  /** Milliseconds this step holds before the next one begins. */
  duration: number;
  caption?: string;
  /** Part id to the state that becomes true when this step starts. */
  set?: Record<string, PartAssignment>;
}

export interface AnimDocument {
  version: 1;
  stage: StageSpec;
  parts: Record<string, Part>;
  steps: Step[];
}

/** A part's fully-resolved appearance at a point in time. */
export interface ResolvedPartState {
  state: string;
  tone: Tone;
}

/** Where the playhead is, expressed in the document's own terms. */
export interface TimelinePosition {
  /** Milliseconds from the start of the animation. */
  time: number;
  /** Index into `steps`, or -1 when the document has no steps. */
  stepIndex: number;
  /** Milliseconds elapsed inside the current step. */
  offsetInStep: number;
}

export const DEFAULT_STATE = 'idle';
export const DEFAULT_TONE: Tone = 'neutral';

export const TONES: readonly Tone[] = [
  'neutral',
  'accent',
  'data',
  'success',
  'warning',
  'error',
  'muted',
] as const;

/** Frame rates whose frame delay is a whole number of milliseconds. */
export const SUGGESTED_FPS: readonly number[] = [10, 20, 25, 50] as const;
