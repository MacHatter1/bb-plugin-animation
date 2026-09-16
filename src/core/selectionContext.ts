/**
 * What the chat panel learns when you click something on the stage.
 *
 * This is the load-bearing half of the whole editor. The user does not adjust
 * the animation with property fields; they click a part and describe the change
 * they want. That only works if the context chip carries enough for the agent to
 * act without a follow-up question -- which part, in which state, at which
 * moment, and what it was going to do next.
 *
 * The chat panel's context chips are the only place a selection is shown; the
 * stage itself only outlines the selected part.
 */

import {
  nextChangeFor,
  positionAt,
  resolveAtStep,
  stepsTouching,
} from "./timeline";
import type { AnimDocument, ResolvedPartState } from "./types";

/** Mirrors `EditorContextItem` from the SDK, kept local to avoid a hard dep. */
export interface AnimContextItem {
  id: string;
  label: string;
  description: string;
  icon?: string;
  groupLabel?: string;
  includeData?: boolean;
  data?: unknown;
}

const TEXT_LIMIT = 240;

function bounded(value: unknown, limit = TEXT_LIMIT): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 14))}… [truncated]`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export interface SelectionReadout {
  partId: string;
  label: string;
  type: string;
  /** State at the current playhead. */
  current: ResolvedPartState;
  /** The next change to this part, if any. */
  next: {
    state: ResolvedPartState;
    time: number;
    stepId: string;
  } | null;
  stepId: string | null;
  stepIndex: number;
  time: number;
}

/**
 * The container and spec behind a `partId/subId` selection.
 *
 * Split on the first `/` because that is exactly how a region becomes
 * addressable: the compiler writes `data-part="<partId>/<id>"` and
 * `baselineFor` registers the same string. Clicking a session row inside a
 * component hands `partIdFromEvent` the sub-part rather than its container, so
 * without this the chat panel loses the selection entirely -- which is worse
 * than what it showed before components existed.
 */
function resolveSubPart(
  doc: AnimDocument,
  partId: string
): { subId: string; label?: string } | null {
  const slash = partId.indexOf("/");
  if (slash === -1) return null;
  const container = doc.parts[partId.slice(0, slash)];
  if (!container || container.type !== "html") return null;
  const subId = partId.slice(slash + 1);
  const spec = container.subParts?.[subId];
  if (!spec) return null;
  return { subId, label: spec.label };
}

/**
 * Everything the context chips describe for the selected part. Returns null
 * when the part is gone, which happens if an agent deletes it while it is
 * selected.
 */
export function buildSelectionReadout(
  doc: AnimDocument,
  partId: string,
  time: number
): SelectionReadout | null {
  const part = doc.parts[partId];
  const sub = part ? null : resolveSubPart(doc, partId);
  if (!part && !sub) return null;

  const position = positionAt(doc, time);
  const states = resolveAtStep(doc, position.stepIndex);
  const current = states.get(partId);
  if (!current) return null;

  const change = nextChangeFor(doc, partId, position.stepIndex);
  const step =
    position.stepIndex >= 0 ? doc.steps[position.stepIndex] : undefined;

  return {
    partId,
    label: part ? part.label ?? partId : sub?.label ?? sub?.subId ?? partId,
    // "sub-part" rather than the container's type, because what the agent has
    // to know is that this is one region inside a component, not the whole
    // window. The container's id is the part of the selection id before the `/`.
    type: part ? part.type : "sub-part",
    current,
    next: change
      ? { state: change.state, time: change.time, stepId: change.step.id }
      : null,
    stepId: step?.id ?? null,
    stepIndex: position.stepIndex,
    time: position.time,
  };
}

/** The chip describing the selected part. */
export function buildPartContextItem(
  readout: SelectionReadout,
  doc: AnimDocument
): AnimContextItem {
  const touching = stepsTouching(doc, readout.partId);
  const touchingNames = touching
    .map((i) => doc.steps[i]?.id)
    .filter((id): id is string => Boolean(id));

  const sentences = [
    `Selected part "${bounded(readout.label, 120)}" (id "${bounded(
      readout.partId,
      120
    )}", type ${readout.type}) ` + `in an animation document.`,
    `At the current playhead (${formatSeconds(readout.time)}${
      readout.stepId ? `, during step "${bounded(readout.stepId, 80)}"` : ""
    }) ` +
      `it is state "${bounded(readout.current.state, 60)}" with tone "${
        readout.current.tone
      }".`,
  ];

  if (readout.next) {
    sentences.push(
      `It next becomes state "${bounded(
        readout.next.state.state,
        60
      )}" (tone "${readout.next.state.tone}") ` +
        `at ${formatSeconds(readout.next.time)} in step "${bounded(
          readout.next.stepId,
          80
        )}".`
    );
  } else {
    sentences.push("It does not change again for the rest of the animation.");
  }

  if (touchingNames.length > 0) {
    sentences.push(
      `Steps that assign it: ${touchingNames
        .map((n) => bounded(n, 60))
        .join(", ")}.`
    );
  } else {
    sentences.push(
      "No step assigns it; it holds its baseline state throughout."
    );
  }

  return {
    id: `scene-part:${bounded(readout.partId, 400)}`,
    label: bounded(readout.label, 120),
    description: sentences.join(" "),
    icon: "category",
    groupLabel: "parts",
    includeData: true,
    data: {
      partId: bounded(readout.partId, 200),
      type: readout.type,
      atMs: readout.time,
      step: readout.stepId,
      state: bounded(readout.current.state, 60),
      tone: readout.current.tone,
      next: readout.next
        ? {
            state: bounded(readout.next.state.state, 60),
            tone: readout.next.state.tone,
            atMs: readout.next.time,
            step: bounded(readout.next.stepId, 80),
          }
        : null,
    },
  };
}

/**
 * The chip describing the step under the playhead.
 *
 * Published alongside the part chip because "make this slower" is about the
 * step, while "make this red" is about the part, and the user says both without
 * distinguishing them.
 */
export function buildStepContextItem(
  doc: AnimDocument,
  time: number
): AnimContextItem | null {
  const position = positionAt(doc, time);
  if (position.stepIndex < 0) return null;
  const step = doc.steps[position.stepIndex];
  if (!step) return null;

  const assignments = Object.entries(step.set ?? {}).map(([partId, a]) => {
    const bits = [
      a.state ? `state "${bounded(a.state, 60)}"` : null,
      a.tone ? `tone "${a.tone}"` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `${bounded(partId, 80)} → ${bits}`;
  });

  const sentences = [
    `Current step "${bounded(step.id, 100)}" (step ${
      position.stepIndex + 1
    } of ${doc.steps.length}), ` + `duration ${step.duration}ms.`,
  ];
  if (step.caption) sentences.push(`Caption: "${bounded(step.caption, 200)}".`);
  sentences.push(
    assignments.length > 0
      ? `It sets: ${assignments.join("; ")}.`
      : "It sets nothing; it is a hold."
  );

  return {
    // Stable across playback boundaries so changing the current step refreshes
    // payload without resetting dismissals on an independently selected part.
    id: "scene-step:current",
    label: `Step: ${bounded(step.id, 80)}`,
    description: sentences.join(" "),
    icon: "schedule",
    groupLabel: "steps",
    includeData: true,
    data: {
      stepId: bounded(step.id, 120),
      index: position.stepIndex,
      durationMs: step.duration,
      caption: step.caption ? bounded(step.caption, 200) : null,
    },
  };
}

/** The full chip set for a selection, in the order the chat panel shows them. */
export function buildContextItems(
  doc: AnimDocument,
  partId: string | null,
  time: number
): AnimContextItem[] {
  const items: AnimContextItem[] = [];
  if (partId) {
    const readout = buildSelectionReadout(doc, partId, time);
    if (readout) items.push(buildPartContextItem(readout, doc));
  }
  const stepItem = buildStepContextItem(doc, time);
  if (stepItem) items.push(stepItem);
  return items;
}
