/**
 * The stage stylesheet: where the animation actually lives.
 *
 * Playback sets `data-state` and `data-tone` on parts; every rule here is keyed
 * off those attributes, and `transition` does the interpolation. That is the
 * whole runtime. Adding a new visual state means adding a selector here, not
 * teaching a scheduler about a new property.
 *
 * Theme tokens are injected rather than inherited: the stage renders inside an
 * iframe, so the host's `--nim-*` cascade does not reach it. `ThemeTokens` is
 * read from the host document and written into `:root` here, which is also what
 * makes the eventual standalone export theme-able by find-and-replace.
 */

import { PACKET_TRAVEL_S } from "./scene";

export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  purple: string;
}

export const FALLBACK_TOKENS: ThemeTokens = {
  bg: "#16181c",
  surface: "#1e2126",
  surfaceRaised: "#22262c",
  border: "#4a4a4a",
  borderStrong: "#5c5c5c",
  text: "#ffffff",
  textMuted: "#b3b3b3",
  textFaint: "#808080",
  accent: "#60a5fa",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#ef4444",
  purple: "#a78bfa",
};

/** Duration of the state-to-state transition, in milliseconds. */
export const TRANSITION_MS = 320;

/**
 * Keep document/theme values inside a CSS declaration and the surrounding
 * `<style>` raw-text element. CSS colors may contain functions and spaces, but
 * never need declaration/selector delimiters, markup, imports, or URLs.
 */
export function safeCssColor(
  value: string | undefined,
  fallback: string
): string {
  const candidate = value?.trim() ?? "";
  if (
    candidate === "" ||
    candidate.length > 256 ||
    /[<>{};@\\]/.test(candidate) ||
    /url\s*\(/i.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}

/**
 * Custom-property names a document may declare.
 *
 * These are written straight into a `<style>` block, so the *name* needs the
 * same care the *value* already gets from `safeCssColor` -- otherwise a
 * document could close the declaration and open a rule of its own.
 */
const CUSTOM_PROPERTY_NAME = /^--[a-z0-9-]+$/;

/**
 * Split a document's stamped `stage.theme` into stage tokens and pass-through
 * custom properties.
 *
 * Anything unrecognised is dropped rather than guessed at: a key that is
 * neither a known token nor a valid custom-property name has no rendering
 * meaning, and inventing one would make two consumers disagree the first time
 * they guessed differently.
 */
export function resolveStageTheme(
  theme: Record<string, string> | undefined,
  fallback: ThemeTokens = FALLBACK_TOKENS
): { tokens: ThemeTokens; custom: Record<string, string> } {
  const tokens: ThemeTokens = { ...fallback };
  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme ?? {})) {
    if (typeof value !== "string") continue;
    if (key in FALLBACK_TOKENS) {
      tokens[key as keyof ThemeTokens] = value;
    } else if (CUSTOM_PROPERTY_NAME.test(key)) {
      custom[key] = value;
    }
  }
  return { tokens, custom };
}

export function buildStageCss(
  tokens: ThemeTokens,
  background?: string,
  custom?: Record<string, string>
): string {
  const safeTokens = Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [
      key,
      safeCssColor(value, FALLBACK_TOKENS[key as keyof ThemeTokens]),
    ])
  ) as unknown as ThemeTokens;
  const safeBackground = safeCssColor(background, safeTokens.bg);

  // A project's own vocabulary, emitted after the stage's own tokens so a
  // document cannot redefine `--scene-*` out from under the rules below.
  const customCss = Object.entries(custom ?? {})
    .filter(([name]) => CUSTOM_PROPERTY_NAME.test(name))
    .map(([name, value]) => {
      const safe = safeCssColor(value, "");
      return safe === "" ? "" : `\n  ${name}: ${safe};`;
    })
    .join("");

  return `
:root {
  --scene-bg: ${safeBackground};
  --scene-surface: ${safeTokens.surface};
  --scene-surface-raised: ${safeTokens.surfaceRaised};
  --scene-border: ${safeTokens.border};
  --scene-border-strong: ${safeTokens.borderStrong};
  --scene-text: ${safeTokens.text};
  --scene-text-muted: ${safeTokens.textMuted};
  --scene-text-faint: ${safeTokens.textFaint};

  --scene-tone-neutral: ${safeTokens.textFaint};
  --scene-tone-accent: ${safeTokens.accent};
  --scene-tone-data: ${safeTokens.purple};
  --scene-tone-success: ${safeTokens.success};
  --scene-tone-warning: ${safeTokens.warning};
  --scene-tone-error: ${safeTokens.error};
  --scene-tone-muted: ${safeTokens.textFaint};

  --scene-mono: ui-monospace, 'SF Mono', Monaco, 'Courier New', monospace;
  --scene-duration: ${TRANSITION_MS}ms;
  --scene-ease: cubic-bezier(0.4, 0, 0.2, 1);

  --anim-bg: var(--scene-bg);
  --anim-surface: var(--scene-surface);
  --anim-surface-raised: var(--scene-surface-raised);
  --anim-border: var(--scene-border);
  --anim-border-strong: var(--scene-border-strong);
  --anim-text: var(--scene-text);
  --anim-text-muted: var(--scene-text-muted);
  --anim-text-faint: var(--scene-text-faint);
  --anim-tone-neutral: var(--scene-tone-neutral);
  --anim-tone-accent: var(--scene-tone-accent);
  --anim-tone-data: var(--scene-tone-data);
  --anim-tone-success: var(--scene-tone-success);
  --anim-tone-warning: var(--scene-tone-warning);
  --anim-tone-error: var(--scene-tone-error);
  --anim-tone-muted: var(--scene-tone-muted);
  --anim-mono: var(--scene-mono);
  --anim-duration: var(--scene-duration);
  --anim-ease: var(--scene-ease);${customCss}
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  height: 100%;
  background: var(--scene-bg);
  overflow: hidden;
}

.scene-stage {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--scene-bg);
  user-select: none;
}

/* ---- tone resolution ---------------------------------------------------- */
.scene-part { --scene-tone: var(--scene-tone-neutral); }
.scene-part[data-tone="accent"]  { --scene-tone: var(--scene-tone-accent); }
.scene-part[data-tone="data"]    { --scene-tone: var(--scene-tone-data); }
.scene-part[data-tone="success"] { --scene-tone: var(--scene-tone-success); }
.scene-part[data-tone="warning"] { --scene-tone: var(--scene-tone-warning); }
.scene-part[data-tone="error"]   { --scene-tone: var(--scene-tone-error); }
.scene-part[data-tone="muted"]   { --scene-tone: var(--scene-tone-muted); }
.scene-part, .scene-subpart {
  --anim-tone: var(--scene-tone);
  --anim-tone-fill: var(--scene-tone-fill);
}

.scene-part {
  --scene-tone-fill: color-mix(in srgb, var(--scene-tone) 14%, transparent);
}

/* ---- sub-parts ---------------------------------------------------------- */
/*
 * A region a component declared inside one html part, addressed by steps as
 * partId/subId. Playback drives it with the same querySelector + setAttribute
 * it uses for a top-level part, so there is no second mechanism -- only a
 * second set of selectors.
 *
 * The one deliberate difference from .scene-part is what is NOT here: no
 * unconditional "--scene-tone: var(--scene-tone-neutral)". That default would
 * make a nested region *reset* to grey rather than inherit its container's
 * tone, so a window whose chrome is accent-blue would go grey wherever a
 * component happened to declare a region. Sub-parts are "inherit unless
 * overridden", which is also why neutral has no rule: for a sub-part, neutral
 * means "no opinion", and no opinion means take the parent's.
 */
.scene-subpart[data-tone="accent"]  { --scene-tone: var(--scene-tone-accent); }
.scene-subpart[data-tone="data"]    { --scene-tone: var(--scene-tone-data); }
.scene-subpart[data-tone="success"] { --scene-tone: var(--scene-tone-success); }
.scene-subpart[data-tone="warning"] { --scene-tone: var(--scene-tone-warning); }
.scene-subpart[data-tone="error"]   { --scene-tone: var(--scene-tone-error); }
.scene-subpart[data-tone="muted"]   { --scene-tone: var(--scene-tone-muted); }

/*
 * A custom property whose value contains var() is substituted where it is
 * declared, not where it is used, so a sub-part that overrides --scene-tone
 * would otherwise keep inheriting the container's already-resolved fill.
 * Recompute it exactly where the tone was overridden, and nowhere else.
 */
.scene-subpart[data-tone] {
  --scene-tone-fill: color-mix(in srgb, var(--scene-tone) 14%, transparent);
}

/*
 * State treatments mirror .scene-html, so a sub-part is not inert in the
 * states every other part type reacts to. Authored markup overrides any of it
 * by keying off the same attributes.
 */
.scene-subpart { transition: opacity var(--scene-duration) var(--scene-ease); }
.scene-subpart[data-state="hidden"]  { opacity: 0; }
.scene-subpart[data-state="waiting"] { opacity: 0.75; }
.scene-subpart[data-state="offline"] { opacity: 0.4; }

/* ---- nodes -------------------------------------------------------------- */
.scene-node-body {
  fill: var(--scene-surface);
  stroke: var(--scene-border);
  stroke-width: 1.3px;
  transition: fill var(--scene-duration) var(--scene-ease),
              stroke var(--scene-duration) var(--scene-ease),
              stroke-width var(--scene-duration) var(--scene-ease);
}
.scene-node-header { fill: var(--scene-surface-raised); }
.scene-node-rule { stroke: var(--scene-border); stroke-width: 1.2px; }
.scene-node-title {
  fill: var(--scene-text);
  font-family: var(--scene-mono);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.8px;
  transition: fill var(--scene-duration) var(--scene-ease);
}
.scene-node-subtitle,
.scene-row-key,
.scene-row-value {
  font-family: var(--scene-mono);
  font-size: 11px;
  transition: fill var(--scene-duration) var(--scene-ease);
}
.scene-node-subtitle { fill: var(--scene-text-faint); }
.scene-row-key { fill: var(--scene-text-muted); }
.scene-row-value { fill: var(--scene-text-faint); }
.scene-row-box {
  fill: var(--scene-surface-raised);
  stroke: var(--scene-border);
  stroke-width: 1.1px;
  transition: fill var(--scene-duration) var(--scene-ease),
              stroke var(--scene-duration) var(--scene-ease);
}
.scene-node-dot {
  fill: var(--scene-tone);
  opacity: 0;
  transition: opacity var(--scene-duration) var(--scene-ease),
              fill var(--scene-duration) var(--scene-ease);
}

/* Node states */
.scene-node[data-state="active"] .scene-node-body {
  fill: color-mix(in srgb, var(--scene-tone) 10%, var(--scene-surface));
  stroke: var(--scene-tone);
  stroke-width: 1.8px;
}
.scene-node[data-state="active"] .scene-node-dot { opacity: 1; }
.scene-node[data-state="active"] .scene-row-box:first-of-type {
  fill: var(--scene-tone-fill);
  stroke: var(--scene-tone);
}
.scene-node[data-state="offline"] .scene-node-body {
  fill: color-mix(in srgb, var(--scene-tone-error) 9%, var(--scene-surface));
  stroke: var(--scene-tone-error);
  stroke-dasharray: 4 3;
}
.scene-node[data-state="offline"] .scene-node-title { fill: var(--scene-text-faint); }
.scene-node[data-state="waiting"] .scene-node-body {
  stroke: var(--scene-tone-warning);
  stroke-dasharray: 5 4;
}
.scene-node[data-state="hidden"] { opacity: 0; }
.scene-node { transition: opacity var(--scene-duration) var(--scene-ease); }

/* ---- edges -------------------------------------------------------------- */
.scene-edge-line {
  fill: none;
  stroke: var(--scene-border);
  stroke-width: 1.4px;
  stroke-dasharray: 5 4;
}
.scene-edge-flow {
  fill: none;
  stroke: var(--scene-tone);
  stroke-width: 1.7px;
  /* Drawn on top of the dashed baseline and revealed by dash offset, so a
     "flowing" edge reads as the line filling in rather than blinking on. The
     path carries pathLength="1", so these are fractions of the edge, not px. */
  stroke-dasharray: 1 1;
  stroke-dashoffset: 1;
  opacity: 0;
  transition: opacity var(--scene-duration) var(--scene-ease),
              stroke var(--scene-duration) var(--scene-ease);
}

/* ---- edge packets ------------------------------------------------------- */
.scene-edge-packet {
  fill: var(--scene-tone);
  stroke: var(--scene-bg);
  stroke-width: 1px;
  opacity: 0;
  offset-rotate: 0deg;
  offset-distance: 0%;
  transition: fill var(--scene-duration) var(--scene-ease);
}

.scene-edge[data-state="flowing"] .scene-edge-packet,
.scene-edge[data-state="active"] .scene-edge-packet {
  animation: scene-packet-travel ${PACKET_TRAVEL_S}s linear infinite;
}

/*
 * A reply travels the same wire the other way. Reversing the packets rather
 * than drawing a second edge keeps the two nodes joined by one line -- two
 * overlapping edges between the same pair read as a rendering fault.
 */
.scene-edge[data-state="returning"] .scene-edge-packet {
  animation: scene-packet-travel ${PACKET_TRAVEL_S}s linear infinite reverse;
}

/*
 * Fading in and out at the ends stops a packet from appearing to burst out of
 * the source node and vanish into the target one; it enters and leaves the
 * wire instead.
 */
@keyframes scene-packet-travel {
  0%   { offset-distance: 0%;   opacity: 0; }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { offset-distance: 100%; opacity: 0; }
}

/*
 * A spinner for html parts: a ring with one lit arc, rotating. This is the
 * stage's only self-driven rotation -- the rotational counterpart to the edge
 * packet -- for a running/loading state that has to read as live rather than as
 * a static glyph. Colour is currentColor, so the badge hosting it sets the hue,
 * and the recorder captures it exactly as it captures a packet.
 */
@keyframes scene-spin {
  to { transform: rotate(360deg); }
}
.scene-spin {
  display: inline-block;
  box-sizing: border-box;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  animation: scene-spin 0.8s linear infinite;
}
.scene-edge-arrow path {
  fill: none;
  stroke: var(--scene-border);
  stroke-width: 1.6px;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke var(--scene-duration) var(--scene-ease);
}
.scene-edge-label rect {
  fill: var(--scene-bg);
  stroke: none;
}
.scene-edge-label text {
  fill: var(--scene-text-faint);
  font-family: var(--scene-mono);
  font-size: 12.5px;
  transition: fill var(--scene-duration) var(--scene-ease);
}

.scene-edge[data-state="flowing"] .scene-edge-flow,
.scene-edge[data-state="returning"] .scene-edge-flow,
.scene-edge[data-state="active"] .scene-edge-flow {
  opacity: 1;
  stroke-dashoffset: 0;
  transition: opacity var(--scene-duration) var(--scene-ease),
              stroke-dashoffset var(--scene-duration) var(--scene-ease);
}
.scene-edge[data-state="flowing"] .scene-edge-arrow path,
.scene-edge[data-state="returning"] .scene-edge-arrow path,
.scene-edge[data-state="active"] .scene-edge-arrow path { stroke: var(--scene-tone); }
.scene-edge[data-state="flowing"] .scene-edge-label text,
.scene-edge[data-state="returning"] .scene-edge-label text,
.scene-edge[data-state="active"] .scene-edge-label text { fill: var(--scene-tone); }
.scene-edge[data-state="hidden"] { opacity: 0; }
.scene-edge { transition: opacity var(--scene-duration) var(--scene-ease); }

/* ---- labels and shapes -------------------------------------------------- */
.scene-label {
  fill: var(--scene-text-muted);
  font-family: var(--scene-mono);
  font-size: 12px;
  transition: fill var(--scene-duration) var(--scene-ease),
              opacity var(--scene-duration) var(--scene-ease);
}
.scene-label-caps {
  fill: var(--scene-text-faint);
  letter-spacing: 1.4px;
}
.scene-label[data-state="active"] { fill: var(--scene-tone); }
.scene-label[data-state="hidden"] { opacity: 0; }

.scene-shape-body {
  fill: var(--scene-tone-fill);
  stroke: var(--scene-tone);
  stroke-width: 1.3px;
  transition: fill var(--scene-duration) var(--scene-ease),
              stroke var(--scene-duration) var(--scene-ease),
              opacity var(--scene-duration) var(--scene-ease);
}
.scene-shape-text {
  fill: var(--scene-text);
  font-family: var(--scene-mono);
  font-size: 11px;
}
.scene-shape[data-state="active"] .scene-shape-body {
  fill: color-mix(in srgb, var(--scene-tone) 65%, transparent);
}
.scene-shape[data-state="hidden"] { opacity: 0; }
.scene-shape { transition: opacity var(--scene-duration) var(--scene-ease); }

/* ---- html parts --------------------------------------------------------- */
/*
 * Authored markup gets the stage's typography and colour as a starting point,
 * then owns everything from there -- including font-size, which is exactly what
 * the primitive part types cannot offer. The --scene-tone property resolves here
 * through normal inheritance, so markup using it animates on step changes free.
 */
/*
 * Proportional by default, unlike the SVG part types, which are mono because
 * they are diagram furniture. An html part is usually prose or UI, and mono
 * headings read as a terminal mock; markup that wants code sets --scene-mono
 * itself, which is what the tool-call rows in the samples do.
 */
.scene-html-body {
  width: 100%;
  height: 100%;
  color: var(--scene-text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  overflow: hidden;
}

.scene-html-body a { color: var(--scene-tone); }

.scene-html { transition: opacity var(--scene-duration) var(--scene-ease); }
.scene-html[data-state="hidden"] { opacity: 0; }
/*
 * The waiting and offline states get a default treatment so an html part is not
 * inert in the states the other part types react to. Authored markup can
 * override any of it with its own rules keyed off the same attributes.
 */
.scene-html[data-state="waiting"] .scene-html-body { opacity: 0.75; }
.scene-html[data-state="offline"] .scene-html-body { opacity: 0.4; }

/* ---- selection ---------------------------------------------------------- */
.scene-part.scene-selected .scene-node-body,
.scene-part.scene-selected .scene-shape-body {
  stroke: var(--scene-tone-accent);
  stroke-width: 1.8px;
}
.scene-selection-ring {
  fill: none;
  stroke: var(--scene-tone-accent);
  stroke-width: 1.4px;
  stroke-dasharray: 3 3;
  pointer-events: none;
}

/*
 * An html part and a region inside one both outline instead of taking a stroke:
 * neither is an SVG shape, so there is no body element to put one on. An
 * outline rather than a border, because it does not participate in layout -- the markup
 * must not reflow just because someone clicked it -- and the offset is negative
 * so the ring stays inside the foreignObject, which clips at its declared box.
 *
 * Without these the two part types this format is now mostly built from are the
 * only ones with no visible selection at all.
 */
.scene-part.scene-selected .scene-html-body,
.scene-subpart.scene-selected {
  outline: 1.5px dashed var(--scene-tone-accent);
  outline-offset: -2px;
}

.scene-hit { fill: transparent; cursor: pointer; }

/*
 * Scrubbing must land on the destination immediately, not tween toward it --
 * dragging the playhead through five steps should not queue five animations.
 * The scheduler adds this class for the duration of a seek.
 */
.scene-no-transition, .scene-no-transition * {
  transition: none !important;
}

.scene-no-animation .scene-edge-packet,
.scene-no-animation .scene-spin {
  animation: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .scene-part, .scene-part * {
    transition-duration: 1ms !important;
  }
  /*
   * Packets are the one continuously-moving thing here, so reduced motion has
   * to stop them outright rather than just shorten a transition. The edge still
   * reads as active via its stroke; it just stops carrying traffic.
   */
  .scene-edge-packet {
    animation: none !important;
    opacity: 0 !important;
  }
  /* The spinner stops too, but stays visible -- the ring still reads as a
     running badge; it just stops turning. */
  .scene-spin {
    animation: none !important;
  }
}
`;
}
