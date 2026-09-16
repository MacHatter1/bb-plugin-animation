/**
 * The pure core: document plus a time resolves to what every part looks like.
 *
 * Everything downstream leans on this being a total function of
 * `(document, time)` with no hidden state and no wall clock. Scrubbing, play,
 * the selection readout, and (later) frame export all call the same resolver,
 * which is the only reason they can be trusted to agree with each other.
 *
 * States are **cumulative**: a step asserts what changes, and anything it does
 * not mention keeps whatever the previous step left. That is what makes a step
 * list readable -- you write the delta, not the whole world -- and it is why
 * resolving time `t` means folding every step up to `t` rather than reading one.
 */

import {
  DEFAULT_STATE,
  DEFAULT_TONE,
  type AnimDocument,
  type ResolvedPartState,
  type Step,
  type TimelinePosition,
} from "./types";

/** Total run time in milliseconds. */
export function totalDuration(doc: AnimDocument): number {
  return doc.steps.reduce((sum, step) => sum + step.duration, 0);
}

/** Start time of each step, parallel to `doc.steps`. */
export function stepStartTimes(doc: AnimDocument): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const step of doc.steps) {
    starts.push(acc);
    acc += step.duration;
  }
  return starts;
}

/**
 * Which step owns time `t`.
 *
 * Boundaries belong to the step that starts there, and a time at or past the
 * end resolves to the last step rather than to nothing -- an animation parked
 * at its end should show its final frame, not an empty stage.
 */
export function positionAt(doc: AnimDocument, time: number): TimelinePosition {
  if (doc.steps.length === 0) {
    return { time: 0, stepIndex: -1, offsetInStep: 0 };
  }
  const total = totalDuration(doc);
  const clamped = Math.max(0, Math.min(total, Math.round(time)));

  let acc = 0;
  for (let i = 0; i < doc.steps.length; i += 1) {
    const end = acc + doc.steps[i].duration;
    if (clamped < end) {
      return { time: clamped, stepIndex: i, offsetInStep: clamped - acc };
    }
    acc = end;
  }
  const last = doc.steps.length - 1;
  return {
    time: clamped,
    stepIndex: last,
    offsetInStep: doc.steps[last].duration,
  };
}

/** Start time of a step by index, or 0 when the index is out of range. */
export function startTimeOf(doc: AnimDocument, stepIndex: number): number {
  if (stepIndex <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < stepIndex && i < doc.steps.length; i += 1) {
    acc += doc.steps[i].duration;
  }
  return acc;
}

/**
 * Every addressable thing in the document and what it looks like before step 0.
 *
 * Sub-parts join the same map under `partId/subId`, so everything downstream --
 * `applyStep`, `resolveAtStep`, `buildTimeline`, `applyStates`, the standalone
 * player -- drives them without knowing they are nested. A region a component
 * declared is a first-class target of a step, or it is nothing.
 *
 * `DEFAULT_TONE` for a sub-part means "inherit the enclosing part", not "grey":
 * `stageCss` gives `.scene-subpart[data-tone="neutral"]` no rule at all, so
 * writing the default onto a nested region leaves the container's tone standing.
 */
function baselineFor(doc: AnimDocument): Map<string, ResolvedPartState> {
  const out = new Map<string, ResolvedPartState>();
  for (const [id, part] of Object.entries(doc.parts)) {
    out.set(id, {
      state: part.state ?? DEFAULT_STATE,
      tone: part.tone ?? DEFAULT_TONE,
    });
    if (part.type !== 'html' || !part.subParts) continue;
    for (const [subId, spec] of Object.entries(part.subParts)) {
      out.set(`${id}/${subId}`, {
        state: spec.state ?? DEFAULT_STATE,
        tone: spec.tone ?? DEFAULT_TONE,
      });
    }
  }
  return out;
}

function applyStep(into: Map<string, ResolvedPartState>, step: Step): void {
  if (!step.set) return;
  for (const [partId, assignment] of Object.entries(step.set)) {
    const current = into.get(partId);
    // Assignments naming a part that no longer exists are inert here; the
    // parser already warned, and inventing a part would be worse than ignoring.
    if (!current) continue;
    into.set(partId, {
      state: assignment.state ?? current.state,
      tone: assignment.tone ?? current.tone,
    });
  }
}

/**
 * Resolve every part's state after `stepIndex` has been applied.
 * `stepIndex` of -1 gives the baseline, before any step runs.
 */
export function resolveAtStep(
  doc: AnimDocument,
  stepIndex: number
): Map<string, ResolvedPartState> {
  const states = baselineFor(doc);
  for (let i = 0; i <= stepIndex && i < doc.steps.length; i += 1) {
    applyStep(states, doc.steps[i]);
  }
  return states;
}

/** Resolve every part's state at a wall-clock offset into the animation. */
export function resolveAtTime(
  doc: AnimDocument,
  time: number
): Map<string, ResolvedPartState> {
  return resolveAtStep(doc, positionAt(doc, time).stepIndex);
}

/**
 * The next step that changes `partId`, looked up from `fromStepIndex`.
 *
 * This is what lets the selection readout say "becomes active at 2.0s" rather
 * than only "is idle now". Without the lookahead the readout describes a frozen
 * instant, which is not enough to have a conversation about a change.
 */
export function nextChangeFor(
  doc: AnimDocument,
  partId: string,
  fromStepIndex: number
): {
  stepIndex: number;
  step: Step;
  time: number;
  state: ResolvedPartState;
} | null {
  const running = resolveAtStep(doc, fromStepIndex);
  const current = running.get(partId);
  if (!current) return null;

  let seen = { ...current };
  for (let i = fromStepIndex + 1; i < doc.steps.length; i += 1) {
    const step = doc.steps[i];
    const assignment = step.set?.[partId];
    if (!assignment) continue;
    const next: ResolvedPartState = {
      state: assignment.state ?? seen.state,
      tone: assignment.tone ?? seen.tone,
    };
    if (next.state !== seen.state || next.tone !== seen.tone) {
      return { stepIndex: i, step, time: startTimeOf(doc, i), state: next };
    }
    seen = next;
  }
  return null;
}

/** Every step index that assigns anything to `partId`. */
export function stepsTouching(doc: AnimDocument, partId: string): number[] {
  const out: number[] = [];
  doc.steps.forEach((step, index) => {
    if (step.set?.[partId]) out.push(index);
  });
  return out;
}

/** Round a time to the nearest whole frame at the stage's fps. */
export function snapToFrame(doc: AnimDocument, time: number): number {
  const fps = doc.stage.fps > 0 ? doc.stage.fps : 25;
  const frameMs = 1000 / fps;
  return Math.round(Math.round(time / frameMs) * frameMs);
}

/** Frame index at a time, for the transport readout. */
export function frameAt(doc: AnimDocument, time: number): number {
  const fps = doc.stage.fps > 0 ? doc.stage.fps : 25;
  return Math.floor((time / 1000) * fps);
}

/**
 * Phase 1 deliberately seeks only to settled step boundaries. CSS transitions
 * are wall-clock animations, so pretending an arbitrary mid-transition time is
 * seekable would make scrubbing disagree with playback and later frame export.
 */
export function snapToStepBoundary(doc: AnimDocument, time: number): number {
  const boundaries = [...stepStartTimes(doc), totalDuration(doc)];
  if (boundaries.length === 0) return 0;
  const clamped = Math.max(0, Math.min(totalDuration(doc), Math.round(time)));
  return boundaries.reduce(
    (nearest, boundary) =>
      Math.abs(boundary - clamped) < Math.abs(nearest - clamped)
        ? boundary
        : nearest,
    boundaries[0] ?? 0
  );
}
