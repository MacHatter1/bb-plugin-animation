/**
 * Document edits, as pure functions.
 *
 * Every direct-manipulation gesture in the editor lands here and nowhere else.
 * Keeping them pure buys three things at once: undo is a snapshot stack rather
 * than a set of inverse operations, the drag maths is unit-testable without a
 * DOM, and the agent's tools can eventually call exactly the same functions the
 * mouse does, so the two paths cannot drift.
 */

import { snapToFrame } from './timeline';
import type { AnimDocument, Step } from './types';

/** Shortest step the UI will let you drag to. Below this a block is unhittable. */
export const MIN_DURATION_MS = 40;
export const MAX_DURATION_MS = 600_000;

function clampDuration(ms: number): number {
  return Math.round(Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, ms)));
}

/**
 * Set one step's duration.
 *
 * This ripples: later steps keep their own durations and simply start later.
 * The alternative -- stealing the difference from the next step to hold total
 * run time constant -- reads as "two things moved when I dragged one thing",
 * and for an explainer animation the total length is an outcome, not a budget.
 */
export function setStepDuration(
  doc: AnimDocument,
  stepIndex: number,
  durationMs: number,
  options: { snap?: boolean } = {},
): AnimDocument {
  if (stepIndex < 0 || stepIndex >= doc.steps.length) return doc;
  const requested = options.snap === false ? durationMs : snapToFrame(doc, durationMs);
  const next = clampDuration(requested);
  if (next === doc.steps[stepIndex].duration) return doc;

  const steps = doc.steps.map((step, i) => (i === stepIndex ? { ...step, duration: next } : step));
  return { ...doc, steps };
}

/**
 * Move the boundary that sits after `stepIndex` by `deltaMs`.
 * Dragging right lengthens that step; dragging left shortens it.
 */
export function dragStepBoundary(
  doc: AnimDocument,
  stepIndex: number,
  deltaMs: number,
  options: { snap?: boolean } = {},
): AnimDocument {
  if (stepIndex < 0 || stepIndex >= doc.steps.length) return doc;
  return setStepDuration(doc, stepIndex, doc.steps[stepIndex].duration + deltaMs, options);
}

/** Move a step to a new index, keeping every other step's relative order. */
export function reorderStep(doc: AnimDocument, from: number, to: number): AnimDocument {
  if (from === to) return doc;
  if (from < 0 || from >= doc.steps.length) return doc;
  const target = Math.min(doc.steps.length - 1, Math.max(0, to));
  if (target === from) return doc;

  const steps = doc.steps.slice();
  const [moved] = steps.splice(from, 1);
  steps.splice(target, 0, moved);
  return { ...doc, steps };
}

/** Replace a step's caption; an empty caption removes the key entirely. */
export function setStepCaption(
  doc: AnimDocument,
  stepIndex: number,
  caption: string,
): AnimDocument {
  if (stepIndex < 0 || stepIndex >= doc.steps.length) return doc;
  const trimmed = caption.trim();
  const steps = doc.steps.map((step, i) => {
    if (i !== stepIndex) return step;
    const nextStep: Step = { ...step };
    if (trimmed === '') delete nextStep.caption;
    else nextStep.caption = trimmed;
    return nextStep;
  });
  return { ...doc, steps };
}

/** Set the stage frame rate. */
export function setFps(doc: AnimDocument, fps: number): AnimDocument {
  const next = Math.round(Math.min(120, Math.max(1, fps)));
  if (next === doc.stage.fps) return doc;
  return { ...doc, stage: { ...doc.stage, fps: next } };
}

/**
 * Assign a state (and optionally a tone) to a part within a step.
 *
 * Present so the editor and the agent share one write path even though the
 * current UI has no control that calls it -- the user asks the agent instead.
 */
export function setPartStateInStep(
  doc: AnimDocument,
  stepIndex: number,
  partId: string,
  assignment: { state?: string; tone?: AnimDocument['parts'][string]['tone'] },
): AnimDocument {
  if (stepIndex < 0 || stepIndex >= doc.steps.length) return doc;
  if (!doc.parts[partId]) return doc;

  const steps = doc.steps.map((step, i) => {
    if (i !== stepIndex) return step;
    const set = { ...(step.set ?? {}) };
    const merged = { ...(set[partId] ?? {}), ...assignment };
    const cleaned = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined),
    ) as { state?: string; tone?: AnimDocument['parts'][string]['tone'] };
    if (Object.keys(cleaned).length === 0) delete set[partId];
    else set[partId] = cleaned;
    const nextStep: Step = { ...step };
    if (Object.keys(set).length === 0) delete nextStep.set;
    else nextStep.set = set;
    return nextStep;
  });
  return { ...doc, steps };
}
