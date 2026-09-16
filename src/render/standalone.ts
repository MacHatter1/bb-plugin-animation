/**
 * Exporting an animation as a self-contained HTML file.
 *
 * The design constraint that shapes everything here: **the animation cannot be
 * exported as stamped frames.** Interpolation is CSS transitions and the edge
 * packets are CSS animations, so baking `data-state` into a series of snapshots
 * produces a stepped slideshow with motionless packets. The export has to stay
 * *real playback* -- a live scene with something changing its attributes on a
 * clock -- which is why the output carries a script at all.
 *
 * It does not, however, re-implement the resolver. `resolveAtStep` stays the
 * single source of truth: this module runs it once per step at build time and
 * emits the answers as data. The player shipped in the file is a dumb applier
 * with no notion of steps, cumulative state, or tone inheritance. That keeps the
 * invariant the rest of the extension relies on -- one resolver, so scrubbing,
 * playback and export can never disagree -- and it means a change to how states
 * resolve needs no change here.
 *
 * This deliberately does **not** reuse `buildStageDocument`. That function
 * produces the in-editor stage, whose contract is a script-disabled sandboxed
 * iframe; bolting a `<script>` onto it would quietly erode that. The two share
 * `buildStageCss` and `renderScene` instead, which is where the actual overlap
 * is.
 */

import type { AnimDocument } from "../core/types";
import { resolveAtStep, startTimeOf, totalDuration } from "../core/timeline";
import { renderScene } from "./scene";
import type { HtmlAssets } from "../core/htmlParts";
import { buildStageCss, resolveStageTheme, type ThemeTokens } from "./stageCss";

/** One step's worth of attribute writes: part id -> [state, tone]. */
type StateDelta = Record<string, [string, string]>;

interface TimelineEntry {
  /** Milliseconds from the start of the animation. */
  t: number;
  /** Attributes to write when the playhead reaches `t`. */
  s: StateDelta;
}

/**
 * The precomputed timeline.
 *
 * Entry 0 is the **complete** resolved state of every part; later entries carry
 * only what changed since the one before. That split is what makes looping
 * correct without a separate reset path -- wrapping round re-applies entry 0,
 * which by construction mentions every part, so nothing can be left behind from
 * the end of the previous pass.
 */
export function buildTimeline(doc: AnimDocument): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let previous: Map<string, { state: string; tone: string }> | null = null;

  for (let index = 0; index < doc.steps.length; index += 1) {
    const resolved = resolveAtStep(doc, index);
    const delta: StateDelta = {};

    for (const [partId, next] of resolved) {
      const before = previous?.get(partId);
      if (before && before.state === next.state && before.tone === next.tone) {
        continue;
      }
      delta[partId] = [next.state, next.tone];
    }

    entries.push({ t: startTimeOf(doc, index), s: delta });
    previous = new Map(
      [...resolved].map(([id, value]) => [
        id,
        { state: value.state, tone: value.tone },
      ])
    );
  }

  return entries;
}

/**
 * Embed a value as JSON inside a `<script>` block.
 *
 * Part ids and state names come from a user-authored document, so a literal
 * `</script>` in one would otherwise close the block and spill the rest of the
 * timeline into the page as markup. Escaping `<` sidesteps that without needing
 * to reason about where in the string it appeared.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The player.
 *
 * Position is derived from `performance.now()` modulo the total rather than
 * accumulated per frame, so it cannot drift and it resynchronises for free when
 * the tab is backgrounded and rAF stops firing. Applying forward from entry 0
 * after a wrap is what makes the loop a clean reset rather than a smear of
 * whatever the last pass happened to leave set.
 */
const PLAYER = `
(function () {
  var stage = document.querySelector('[data-scene-stage]');
  if (!stage || !TIMELINE.length) return;

  function apply(entry) {
    for (var id in entry.s) {
      var el = stage.querySelector('[data-part="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!el) continue;
      el.setAttribute('data-state', entry.s[id][0]);
      el.setAttribute('data-tone', entry.s[id][1]);
    }
  }

  function applyThrough(from, to) {
    for (var i = from; i <= to; i += 1) apply(TIMELINE[i]);
  }

  function indexAt(t) {
    var i = 0;
    while (i + 1 < TIMELINE.length && TIMELINE[i + 1].t <= t) i += 1;
    return i;
  }

  var last = -1;
  var origin = null;
  var paused = false;
  var pausedAt = 0;

  function frame(now) {
    if (!paused) {
      if (origin === null) origin = now;
      var t = TOTAL > 0 ? (now - origin) % TOTAL : 0;
      var index = indexAt(t);
      if (index !== last) {
        // Going backwards means the loop wrapped; entry 0 is complete, so
        // replaying from there restores every part rather than only the ones
        // this step happens to mention.
        applyThrough(index < last ? 0 : last + 1, index);
        last = index;
      }
    }
    requestAnimationFrame(frame);
  }

  // Click to pause, so a reader can stop on the beat they care about.
  document.addEventListener('click', function () {
    paused = !paused;
    if (paused) {
      pausedAt = performance.now();
    } else if (origin !== null) {
      origin += performance.now() - pausedAt;
    }
    document.documentElement.setAttribute('data-scene-paused', paused ? 'true' : 'false');
  });

  // Capture hooks, present only when the file is built for GIF export. The
  // recorder needs to start the clock at t=0 on its own signal: it cannot rely
  // on load timing, and a GIF that starts three steps in is not the animation.
  if (CAPTURE_HOOKS) {
    window.__scene = {
      total: TOTAL,
      restart: function () {
        origin = null;
        last = 0;
        paused = false;
        applyThrough(0, 0);
      }
    };
  }

  applyThrough(0, 0);
  last = 0;
  requestAnimationFrame(frame);
})();
`;

/**
 * Page chrome for the standalone file.
 *
 * `buildStageCss` already sizes the stage to fill its container and paints the
 * background, so this only has to stop the packet animations while paused --
 * pausing the clock alone would freeze the state machine but leave packets
 * sliding along their edges, which reads as a broken pause rather than a stop.
 */
const PAGE_CSS = `
html[data-scene-paused="true"] .scene-edge-packet { animation-play-state: paused; }
body { cursor: pointer; }
`;

export interface StandaloneOptions {
  /** Document title. Defaults to the file's own name upstream. */
  title?: string;
  /**
   * Expose `window.__scene` so a recorder can restart the clock at t=0.
   * Off for files handed to a user; on only for the GIF capture pass.
   */
  captureHooks?: boolean;
  /** Markup for the document's `htmlFile` refs, resolved by the caller. */
  assets?: HtmlAssets;
}

export function buildStandaloneDocument(
  doc: AnimDocument,
  tokens: ThemeTokens,
  options: StandaloneOptions = {}
): string {
  const timeline = buildTimeline(doc);
  const total = totalDuration(doc);
  const title = options.title ?? "Animation";
  // `tokens` is the fallback; a document that stamps `stage.theme` wins, which
  // is what keeps this file and the in-editor preview the same picture.
  const theme = resolveStageTheme(doc.stage.theme, tokens);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(title)}</title>
<style>${buildStageCss(
    theme.tokens,
    doc.stage.background,
    theme.custom
  )}${PAGE_CSS}</style>
</head>
<body>
<div data-scene-stage style="width:100%;height:100%">${renderScene(doc, options.assets)}</div>
<script>
var TIMELINE = ${embedJson(timeline)};
var TOTAL = ${total};
var CAPTURE_HOOKS = ${options.captureHooks ? "true" : "false"};
${PLAYER}
</script>
</body>
</html>
`;
}

/** Escape text destined for HTML content (not attributes). */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
