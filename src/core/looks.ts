/**
 * Looks: a scene's whole visual character, chosen by one word.
 *
 * Tones say what a colour *means* (accent, success, error). A look says what
 * the scene *feels like*: its palette, its type, how round its corners are,
 * what sits behind the diagram, and how parts arrive. Without looks every
 * scene came out as the same dark row of cards, whatever it was about.
 *
 * A look is a name rather than a set of numbers for the same reason a label's
 * size is: an author who cannot see the result can pick "blueprint" for a
 * network diagram, but cannot tune fourteen hex values into something that
 * works. `stage.theme` still overrides individual colours on top of a look.
 */

/** The colours a stage is drawn in. Tones map onto these. */
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

export type BackdropPattern = "none" | "grid" | "dots";

export interface Look {
  id: string;
  /** What it feels like, and what it suits. Shown in the skill and in notes. */
  feel: string;
  tokens: ThemeTokens;
  /** Node titles and caps labels are uppercased. Off for the friendlier looks. */
  caps: boolean;
  pattern: BackdropPattern;
  /** Values for the `--scene-*` style variables the stage stylesheet reads. */
  vars: {
    radius: number;
    font: string;
    titleFont: string;
    /** Dash pattern of an idle edge. */
    edgeDash: string;
    packetRadius: number;
    /** How strongly an active node glows, as a percentage of its tone. */
    glow: number;
    /** Where a hidden part waits before it arrives, as a CSS `translate`. */
    enterFrom: string;
    enterEase: string;
  };
  /** Rules only this look needs. Trusted constants, never document input. */
  css: string;
}

const MONO = "ui-monospace, 'SF Mono', Monaco, 'Courier New', monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const ROUNDED = "'Avenir Next', 'Nunito', 'Segoe UI', system-ui, sans-serif";
const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

const SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** The default, and the palette every scene had before looks existed. */
export const SLATE_TOKENS: ThemeTokens = {
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

export const LOOKS: Record<string, Look> = {
  slate: {
    id: "slate",
    feel: "neutral dark cards; a safe default for anything",
    tokens: SLATE_TOKENS,
    caps: true,
    pattern: "none",
    vars: {
      radius: 4,
      font: MONO,
      titleFont: SANS,
      edgeDash: "5 4",
      packetRadius: 2,
      glow: 42,
      enterFrom: "0 14px",
      enterEase: SETTLE,
    },
    css: "",
  },
  blueprint: {
    id: "blueprint",
    feel: "engineering drawing on deep blue with a grid; infrastructure, networks, protocols",
    tokens: {
      bg: "#0b2545",
      surface: "#0d2b50",
      surfaceRaised: "#123a6b",
      border: "#4f7fbd",
      borderStrong: "#8fb8ee",
      text: "#eaf4ff",
      textMuted: "#b7d2f2",
      textFaint: "#7fa3cf",
      accent: "#5ce1ff",
      success: "#7ef0b0",
      warning: "#ffd166",
      error: "#ff8a7a",
      purple: "#c4a7ff",
    },
    caps: true,
    pattern: "grid",
    vars: {
      radius: 2,
      font: MONO,
      titleFont: MONO,
      edgeDash: "8 5",
      packetRadius: 1,
      glow: 36,
      enterFrom: "0 12px",
      enterEase: SETTLE,
    },
    css: `
.scene-label-title { letter-spacing: 1.5px; text-transform: uppercase; font-size: 21px; }
.scene-node-body { stroke-width: 1.5px; }
`,
  },
  paper: {
    id: "paper",
    feel: "warm and light with a serif heading; teaching a concept, explaining an idea",
    tokens: {
      bg: "#f6f1e7",
      surface: "#fffdf8",
      surfaceRaised: "#f3ecdd",
      border: "#cdbfa6",
      borderStrong: "#a8977a",
      text: "#2a2520",
      textMuted: "#5b5246",
      textFaint: "#8a7f6f",
      accent: "#3b5bdb",
      success: "#2b8a3e",
      warning: "#c77700",
      error: "#c92a2a",
      purple: "#7048e8",
    },
    caps: false,
    pattern: "dots",
    vars: {
      radius: 11,
      font: ROUNDED,
      titleFont: SERIF,
      edgeDash: "2 5",
      packetRadius: 5,
      glow: 26,
      enterFrom: "-16px 0",
      enterEase: SETTLE,
    },
    css: `
.scene-label-title { font-size: 27px; font-weight: 700; letter-spacing: 0; }
.scene-node-title { font-size: 14px; letter-spacing: 0.1px; }
.scene-node-subtitle, .scene-row-key, .scene-row-value { font-size: 11.5px; }
.scene-edge-line { stroke-linecap: round; }
`,
  },
  neon: {
    id: "neon",
    feel: "black with vivid glowing colour; launches, product moments, anything that should feel exciting",
    tokens: {
      bg: "#06050c",
      surface: "#110f1f",
      surfaceRaised: "#191531",
      border: "#3a2f66",
      borderStrong: "#5b49a3",
      text: "#f5f0ff",
      textMuted: "#b9aee0",
      textFaint: "#7a6fa6",
      accent: "#ff4fd8",
      success: "#5dffb0",
      warning: "#ffd84f",
      error: "#ff5470",
      purple: "#4fd8ff",
    },
    caps: true,
    pattern: "none",
    vars: {
      radius: 14,
      font: SANS,
      titleFont: SANS,
      edgeDash: "1 6",
      packetRadius: 5,
      glow: 78,
      enterFrom: "0 22px",
      enterEase: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    },
    css: `
.scene-label-title { font-size: 26px; font-weight: 800; letter-spacing: -0.4px; }
.scene-node-title { letter-spacing: 1.2px; }
.scene-edge-line { stroke-linecap: round; stroke-width: 1.8px; }
.scene-edge-flow { stroke-width: 2.2px; }
`,
  },
  terminal: {
    id: "terminal",
    feel: "green on black, square and blocky; command lines, developer tooling, low-level systems",
    tokens: {
      bg: "#020a05",
      surface: "#04140a",
      surfaceRaised: "#072012",
      border: "#1f6b3c",
      borderStrong: "#2f9a58",
      text: "#8dffba",
      textMuted: "#4fd88a",
      textFaint: "#2f9a58",
      accent: "#35f08a",
      success: "#b6ff5c",
      warning: "#ffc83d",
      error: "#ff5e5e",
      purple: "#5ee6ff",
    },
    caps: true,
    pattern: "none",
    vars: {
      radius: 0,
      font: MONO,
      titleFont: MONO,
      edgeDash: "2 4",
      packetRadius: 0,
      glow: 30,
      enterFrom: "0 0",
      // Blocky on purpose: parts appear in steps, like a screen redrawing.
      enterEase: "steps(4, end)",
    },
    css: `
.scene-label-title { font-size: 20px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
.scene-node-header { fill: var(--scene-border); opacity: 0.35; }
`,
  },
  daylight: {
    id: "daylight",
    feel: "clean and light, like product documentation; business flows, user journeys, how-to guides",
    tokens: {
      bg: "#f3f6fb",
      surface: "#ffffff",
      surfaceRaised: "#eaf0f8",
      border: "#c5d0de",
      borderStrong: "#93a4ba",
      text: "#16202e",
      textMuted: "#44546a",
      textFaint: "#7a8aa0",
      accent: "#1f6feb",
      success: "#1a7f4b",
      warning: "#b86a00",
      error: "#d1242f",
      purple: "#8250df",
    },
    caps: false,
    pattern: "grid",
    vars: {
      radius: 8,
      font: SANS,
      titleFont: SANS,
      edgeDash: "4 4",
      packetRadius: 5,
      glow: 24,
      enterFrom: "0 12px",
      enterEase: SETTLE,
    },
    css: `
.scene-label-title { font-size: 25px; font-weight: 700; letter-spacing: -0.3px; }
.scene-node-title { font-size: 13.5px; letter-spacing: 0.1px; }
.scene-node-subtitle, .scene-row-key, .scene-row-value { font-size: 11.5px; }
`,
  },
  chalk: {
    id: "chalk",
    feel: "a green chalkboard with chalk-white lines; walking through an idea step by step",
    tokens: {
      bg: "#1e3b32",
      surface: "#1e3b32",
      surfaceRaised: "#25483d",
      border: "#9fc2b3",
      borderStrong: "#d6ebe2",
      text: "#f3f7f1",
      textMuted: "#cfe1d8",
      textFaint: "#93b3a5",
      accent: "#ffe27a",
      success: "#a8f0b0",
      warning: "#ffb86b",
      error: "#ff9c9c",
      purple: "#c9b8ff",
    },
    caps: false,
    pattern: "none",
    vars: {
      radius: 6,
      font: ROUNDED,
      titleFont: ROUNDED,
      edgeDash: "1 7",
      packetRadius: 5,
      glow: 22,
      enterFrom: "0 10px",
      enterEase: SETTLE,
    },
    css: `
.scene-label-title { font-size: 27px; font-weight: 700; }
.scene-node-body { stroke-width: 2px; stroke-linejoin: round; }
.scene-node-header { fill: transparent; }
.scene-node-rule { stroke-dasharray: 3 5; stroke-linecap: round; }
.scene-row-box { fill: transparent; stroke-dasharray: 2 4; }
.scene-edge-line { stroke-width: 2.2px; stroke-linecap: round; }
.scene-edge-flow { stroke-width: 2.4px; stroke-linecap: round; }
.scene-node-title { font-size: 14px; }
.scene-node-subtitle, .scene-row-key, .scene-row-value { font-size: 12px; }
`,
  },
  ink: {
    id: "ink",
    feel: "black line drawing on white, like a wireframe or a technical paper; precise, no decoration",
    tokens: {
      bg: "#ffffff",
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      border: "#1a1a1a",
      borderStrong: "#000000",
      text: "#111111",
      textMuted: "#3d3d3d",
      textFaint: "#7a7a7a",
      accent: "#e8390e",
      success: "#0b7a3b",
      warning: "#b35c00",
      error: "#c4001a",
      purple: "#4a2fd0",
    },
    caps: true,
    pattern: "none",
    vars: {
      radius: 0,
      font: MONO,
      titleFont: SERIF,
      edgeDash: "none",
      packetRadius: 0,
      glow: 0,
      enterFrom: "14px 0",
      enterEase: SETTLE,
    },
    css: `
.scene-label-title { font-size: 28px; font-weight: 700; font-style: italic; }
.scene-node-body { stroke-width: 1.6px; }
.scene-node-header { fill: transparent; }
.scene-node-rule { stroke: var(--scene-border); stroke-width: 1.6px; }
.scene-row-box { stroke-width: 1px; }
.scene-edge-line { stroke-width: 1.2px; }
.scene-node[data-state="active"] .scene-node-body { stroke-width: 3px; }
`,
  },
  sunset: {
    id: "sunset",
    feel: "warm dusk colours, plum and coral, soft and rounded; stories about people and outcomes",
    tokens: {
      bg: "#21121f",
      surface: "#2e1a2b",
      surfaceRaised: "#3a2136",
      border: "#6b4060",
      borderStrong: "#96608a",
      text: "#fff2ea",
      textMuted: "#e4c3bf",
      textFaint: "#a98296",
      accent: "#ff8a5c",
      success: "#ffd166",
      warning: "#ffb347",
      error: "#ff5c7a",
      purple: "#c58cff",
    },
    caps: false,
    pattern: "none",
    vars: {
      radius: 16,
      font: ROUNDED,
      titleFont: SERIF,
      edgeDash: "6 6",
      packetRadius: 5,
      glow: 55,
      enterFrom: "0 18px",
      enterEase: SETTLE,
    },
    css: `
.scene-label-title { font-size: 28px; font-weight: 700; }
.scene-node-header { fill: transparent; }
.scene-node-rule { stroke: transparent; }
.scene-node-title { font-size: 14px; }
.scene-node-subtitle, .scene-row-key, .scene-row-value { font-size: 11.5px; }
.scene-edge-line { stroke-linecap: round; }
`,
  },
  mint: {
    id: "mint",
    feel: "fresh and light, soft green with teal, very rounded; friendly product walkthroughs",
    tokens: {
      bg: "#eef8f3",
      surface: "#ffffff",
      surfaceRaised: "#dff2e9",
      border: "#a9d5c3",
      borderStrong: "#6fb39a",
      text: "#0f2f27",
      textMuted: "#3a5f54",
      textFaint: "#6f9186",
      accent: "#0c8f7a",
      success: "#1f9d55",
      warning: "#c97a00",
      error: "#d64545",
      purple: "#6d5bd0",
    },
    caps: false,
    pattern: "dots",
    vars: {
      radius: 18,
      font: ROUNDED,
      titleFont: ROUNDED,
      edgeDash: "3 5",
      packetRadius: 5,
      glow: 28,
      enterFrom: "0 16px",
      enterEase: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    },
    css: `
.scene-label-title { font-size: 26px; font-weight: 800; letter-spacing: -0.3px; }
.scene-node-rule { stroke: transparent; }
.scene-node-title { font-size: 14px; }
.scene-node-subtitle, .scene-row-key, .scene-row-value { font-size: 11.5px; }
.scene-edge-line { stroke-linecap: round; stroke-width: 1.8px; }
`,
  },
};

export const DEFAULT_LOOK = "slate";

/** Every look's name, default first. */
export const LOOK_IDS: readonly string[] = Object.keys(LOOKS);

/** The look a document asks for, or the default when it names none or an unknown one. */
export function lookFor(id: string | undefined): Look {
  return (id !== undefined && LOOKS[id]) || LOOKS[DEFAULT_LOOK];
}
