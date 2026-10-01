/**
 * Assembling and driving the stage iframe.
 *
 * The stage renders inside a script-disabled, same-origin sandboxed iframe, written with
 * `open()/write()/close()` the way the mockup editor does. Same-origin is what
 * lets the host set `data-state` directly on the scene's elements instead of
 * shuttling messages across a boundary -- the animation is a few attribute
 * writes per step, and a postMessage protocol for that would be pure ceremony.
 */

import type { AnimDocument, ResolvedPartState } from "../core/types";
import {
  cameraTransform,
  staggerDelays,
  type Camera,
} from "../core/camera";
import { renderScene } from "./scene";
import type { HtmlAssets } from "../core/htmlParts";
import { buildStageCss, resolveStageTheme, type ThemeTokens } from "./stageCss";
import { lookFor } from "../core/looks";

/**
 * `tokens` is the fallback, not the answer: a document that stamps
 * `stage.theme` renders under its own palette here, in the standalone export
 * and in the recorder alike. That is the point of stamping it -- the preview
 * and the export used to read different palettes and quietly disagree.
 */
export function buildStageDocument(
  doc: AnimDocument,
  tokens: ThemeTokens,
  assets?: HtmlAssets
): string {
  // A document that names a look takes that look's palette. One that does not
  // keeps the host's tokens, as it always has.
  const look = lookFor(doc.stage.look);
  const theme = resolveStageTheme(
    doc.stage.theme,
    doc.stage.look ? look.tokens : tokens
  );
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${buildStageCss(
    theme.tokens,
    doc.stage.background,
    theme.custom,
    look
  )}</style></head>
<body>${renderScene(doc, assets)}</body></html>`;
}

/** Write a fresh scene into the frame. Replaces whatever was there. */
export function writeStageDocument(
  frame: HTMLIFrameElement,
  doc: AnimDocument,
  tokens: ThemeTokens,
  assets?: HtmlAssets
): void {
  const frameDoc = frame.contentDocument;
  if (!frameDoc) return;
  frameDoc.open();
  frameDoc.write(buildStageDocument(doc, tokens, assets));
  frameDoc.close();
}

/**
 * Push resolved states onto the scene.
 *
 * `immediate` suppresses transitions for one frame, which is what makes
 * scrubbing feel like scrubbing: dragging the playhead across several steps
 * should show each destination directly rather than queue a tween per step.
 * The class has to be removed on a later frame, after layout has observed the
 * new values, or the browser coalesces both changes and animates anyway.
 */
export function applyStates(
  frameDoc: Document,
  states: Map<string, ResolvedPartState>,
  options: {
    immediate?: boolean;
    /** Part ids in reading order; parts changed together start in this order. */
    order?: readonly string[];
  } = {}
): void {
  const root = frameDoc.documentElement;
  if (!root) return;

  if (options.immediate) {
    root.classList.add("scene-no-transition", "scene-no-animation");
  }

  const changed: Array<{ id: string; el: Element }> = [];
  for (const [partId, state] of states) {
    const el = frameDoc.querySelector(`[data-part="${CSS.escape(partId)}"]`);
    if (!el) continue;
    let didChange = false;
    if (el.getAttribute("data-state") !== state.state) {
      el.setAttribute("data-state", state.state);
      didChange = true;
    }
    if (el.getAttribute("data-tone") !== state.tone) {
      el.setAttribute("data-tone", state.tone);
      didChange = true;
    }
    if (didChange) changed.push({ id: partId, el });
  }
  staggerChanged(changed, options.immediate ? undefined : options.order);

  if (options.immediate) {
    // Flush the animation:none state before restoring packet animations. This
    // restarts their negative-delay cycle at every settled boundary seek, so a
    // given boundary always renders the same frame.
    void root.getBoundingClientRect();
    root.classList.remove("scene-no-animation");
    void root.getBoundingClientRect();

    // Two frames: one for the attribute write to be flushed, one to re-enable
    // transitions without the pending change being caught by them.
    const win = frameDoc.defaultView;
    const raf = win?.requestAnimationFrame?.bind(win);
    if (raf) {
      raf(() => raf(() => root.classList.remove("scene-no-transition")));
    } else {
      root.classList.remove("scene-no-transition");
    }
  }
}

/**
 * Give each changed part its start delay. With no order, as on a seek, every
 * delay is cleared, so nothing lags behind the playhead.
 */
function staggerChanged(
  changed: Array<{ id: string; el: Element }>,
  order: readonly string[] | undefined
): void {
  const rank = new Map((order ?? []).map((id, index) => [id, index]));
  // A region inside an html part moves with the part that holds it.
  const rankOf = (id: string) =>
    rank.get(id) ?? rank.get(id.split("/")[0]) ?? Number.MAX_SAFE_INTEGER;
  const sorted = order
    ? [...changed].sort((a, b) => rankOf(a.id) - rankOf(b.id))
    : changed;
  const delays = order ? staggerDelays(sorted.length) : [];
  sorted.forEach(({ el }, index) => {
    (el as SVGElement | HTMLElement).style?.setProperty(
      "--scene-delay",
      `${delays[index] ?? 0}ms`
    );
  });
}

/** Point the stage's camera. Call before `applyStates` so a seek covers both. */
export function applyCamera(frameDoc: Document, camera: Camera): void {
  const group = frameDoc.querySelector(".scene-camera");
  const style = (group as SVGElement | null)?.style;
  if (!style) return;
  const transform = cameraTransform(camera);
  if (style.transform !== transform) style.transform = transform;
}

/** Pause/resume every CSS transition and packet animation in the stage. */
export function setStageAnimationsPaused(
  frameDoc: Document,
  paused: boolean
): void {
  const animations = frameDoc.getAnimations?.() ?? [];
  for (const animation of animations) {
    if (paused) animation.pause();
    else animation.play();
  }
}

/** Mark one part as selected, clearing any previous selection. */
export function applySelection(
  frameDoc: Document,
  partId: string | null
): void {
  frameDoc.querySelectorAll(".scene-selected").forEach((el) => {
    el.classList.remove("scene-selected");
  });
  if (!partId) return;
  const el = frameDoc.querySelector(`[data-part="${CSS.escape(partId)}"]`);
  el?.classList.add("scene-selected");
}

/** The part id under a click, or null when the click missed everything. */
export function partIdFromEvent(event: Event): string | null {
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== "function") return null;
  const owner = target.closest("[data-part]");
  return owner?.getAttribute("data-part") ?? null;
}
