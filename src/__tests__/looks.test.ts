// @vitest-environment node
/**
 * Looks, icons and actors: the things that stop every scene looking alike.
 *
 * A look must change the picture, must never need the author to supply colours,
 * and must round-trip. The style notes must point a scene at a look and icons
 * that fit what it is about, since the author usually cannot see the result.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, ICONS, suggestIcon } from "../core/icons";
import { lintDocument, suggestLook } from "../core/lint";
import { LOOKS, LOOK_IDS, lookFor } from "../core/looks";
import { parseDocument } from "../core/parse";
import { serializeDocument } from "../core/serialize";
import type { AnimDocument } from "../core/types";
import { renderPart, renderScene } from "../render/scene";
import { buildStageDocument } from "../render/stageDocument";
import { buildStandaloneDocument } from "../render/standalone";
import { FALLBACK_TOKENS } from "../render/stageCss";

function scene(stage: Record<string, unknown>, parts: Record<string, unknown>, steps = 3): AnimDocument {
  const { doc, problems } = parseDocument(
    JSON.stringify({
      stage: { width: 1200, height: 560, fps: 25, ...stage },
      parts,
      steps: Array.from({ length: steps }, (_, i) => ({
        id: `s${i}`,
        duration: 2500,
        caption: "One short sentence here.",
        set: i === 0 ? {} : { [Object.keys(parts)[0]]: { state: i % 2 ? "active" : "idle" } },
      })),
    })
  );
  expect(problems.filter((problem) => problem.level === "error")).toEqual([]);
  return doc;
}

const card = (x: number, extra: Record<string, unknown> = {}) => ({
  type: "node",
  x,
  y: 190,
  w: 220,
  h: 144,
  ...extra,
});

describe("looks", () => {
  it("offers several, each with its own palette and character", () => {
    expect(LOOK_IDS.length).toBeGreaterThanOrEqual(10);
    const backgrounds = new Set(LOOK_IDS.map((id) => LOOKS[id].tokens.bg));
    expect(backgrounds.size).toBe(LOOK_IDS.length);
    const fonts = new Set(LOOK_IDS.map((id) => LOOKS[id].vars.font));
    expect(fonts.size).toBeGreaterThan(1);
    const radii = new Set(LOOK_IDS.map((id) => LOOKS[id].vars.radius));
    expect(radii.size).toBeGreaterThan(3);
    // At least one light look, so not every scene is dark.
    expect(LOOK_IDS.some((id) => LOOKS[id].tokens.bg.toLowerCase() > "#c")).toBe(true);
  });

  it("draws the stage and the export in the look's palette", () => {
    const doc = scene({ look: "paper" }, { a: card(60) });
    const paper = LOOKS.paper.tokens;
    for (const html of [
      buildStageDocument(doc, FALLBACK_TOKENS),
      buildStandaloneDocument(doc, FALLBACK_TOKENS),
    ]) {
      expect(html).toContain(`--scene-bg: ${paper.bg};`);
      expect(html).toContain(`--scene-tone-accent: ${paper.accent};`);
      expect(html).toContain("--scene-radius: 11px;");
      expect(html).not.toContain(`--scene-bg: ${FALLBACK_TOKENS.bg};`);
    }
  });

  it("keeps the host's palette for a scene that names no look", () => {
    const html = buildStageDocument(scene({}, { a: card(60) }), FALLBACK_TOKENS);
    expect(html).toContain(`--scene-bg: ${FALLBACK_TOKENS.bg};`);
    expect(html).toContain("--scene-radius: 4px;");
  });

  it("lets stage.theme override single colours on top of a look", () => {
    const doc = scene({ look: "blueprint", theme: { accent: "#ff00aa" } }, { a: card(60) });
    const html = buildStageDocument(doc, FALLBACK_TOKENS);
    expect(html).toContain("--scene-tone-accent: #ff00aa;");
    expect(html).toContain(`--scene-bg: ${LOOKS.blueprint.tokens.bg};`);
  });

  it("draws a backdrop pattern only for looks that have one", () => {
    expect(renderScene(scene({ look: "blueprint" }, { a: card(60) }))).toContain(
      'id="scene-pattern"'
    );
    expect(renderScene(scene({ look: "neon" }, { a: card(60) }))).not.toContain(
      "scene-pattern"
    );
  });

  it("uppercases titles in some looks and leaves them as written in others", () => {
    const parts = { a: card(60, { label: "Object store" }) };
    expect(renderPart("a", scene({ look: "slate" }, parts))).toContain(">OBJECT STORE<");
    expect(renderPart("a", scene({ look: "paper" }, parts))).toContain(">Object store<");
  });

  it("round-trips, and keeps a look it does not know", () => {
    const text = `{
  "version": 1,
  "stage": {
    "width": 1200,
    "height": 560,
    "fps": 25,
    "look": "terminal"
  },
  "parts": {},
  "steps": []
}
`;
    const known = parseDocument(text);
    expect(known.problems).toEqual([]);
    expect(serializeDocument(known.doc, known.extras)).toBe(text);

    const unknown = parseDocument(text.replace("terminal", "vaporwave"));
    expect(unknown.problems[0]).toMatchObject({ level: "warning", path: "stage.look" });
    expect(unknown.doc.stage.look).toBeUndefined();
    expect(lookFor(unknown.doc.stage.look).id).toBe("slate");
    expect(JSON.parse(serializeDocument(unknown.doc, unknown.extras)).stage.look).toBe(
      "vaporwave"
    );
  });
});

describe("icons and actors", () => {
  it("has an icon for every name, drawn as plain shapes", () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const name of ICON_NAMES) {
      expect(ICONS[name]).toMatch(/^(<(path|circle|rect|ellipse) [^<>]*\/>)+$/);
    }
  });

  it("draws a node's icon beside its title and moves the title over", () => {
    const plain = renderPart("a", scene({}, { a: card(60) }));
    const iconed = renderPart("a", scene({}, { a: card(60, { icon: "database" }) }));
    expect(plain).not.toContain("scene-node-icon");
    expect(plain).toContain('class="scene-node-title" x="16"');
    expect(iconed).toContain("scene-node-icon");
    expect(iconed).toContain('class="scene-node-title" x="37"');
  });

  it("warns about an icon it does not have, and keeps it on save", () => {
    const text = JSON.stringify({ parts: { a: card(60, { icon: "unicorn" }) }, steps: [] });
    const { doc, extras, problems } = parseDocument(text);
    expect(problems[0]).toMatchObject({ level: "warning", path: "parts.a.icon" });
    expect(renderPart("a", doc)).not.toContain("scene-node-icon");
    expect(JSON.parse(serializeDocument(doc, extras)).parts.a.icon).toBe("unicorn");
  });

  it("draws an actor as a circle with its icon and name, not a card", () => {
    const doc = scene({}, { u: card(60, { label: "User", variant: "actor", icon: "user" }) });
    const svg = renderPart("u", doc);
    expect(svg).toContain("scene-actor");
    expect(svg).toContain('<circle class="scene-node-body"');
    expect(svg).toContain("scene-node-icon");
    expect(svg).not.toContain("scene-node-header");
    expect(svg).not.toContain("scene-row");
    // It keeps the same box and state hooks, so steps and edges treat it as a node.
    expect(svg).toContain('data-part="u"');
    expect(svg).toContain('transform="translate(60 190)"');
  });

  it("suggests icons from what a box is called", () => {
    expect(suggestIcon("browser", "Browser")).toBe("browser");
    expect(suggestIcon("idp", "Identity provider")).toBe("lock");
    expect(suggestIcon("ordersDb", undefined)).toBe("database");
    expect(suggestIcon("jobQueue", "Queue")).toBe("queue");
    expect(suggestIcon("resolver", "Resolver")).toBe("globe");
    expect(suggestIcon("thing", "Thing")).toBeNull();
  });
});

describe("style notes", () => {
  const rules = (doc: AnimDocument) => lintDocument(doc).map((note) => note.rule);
  const note = (doc: AnimDocument, rule: string) =>
    lintDocument(doc).find((item) => item.rule === rule)?.message ?? "";

  it("asks an unstyled scene for a look, icons and an actor, with the values to use", () => {
    const doc = scene({}, {
      user: card(60, { label: "User" }),
      gateway: card(490, { label: "API gateway" }),
      ordersDb: card(920, { label: "Orders DB" }),
      title: { type: "label", x: 60, y: 56, text: "How a checkout order is placed", size: "title" },
    });
    expect(rules(doc)).toEqual(expect.arrayContaining(["look", "icons", "actor"]));
    expect(note(doc, "look")).toContain(`Add "look": "${suggestLook(doc)}" to "stage"`);
    expect(note(doc, "icons")).toContain(
      '"icon": "user" to "user", "icon": "shield" to "gateway", "icon": "database" to "ordersDb"'
    );
    expect(note(doc, "actor")).toContain('Draw "user" as an actor');
  });

  it("is quiet once the scene has a look, icons and an actor", () => {
    const doc = scene({ look: "daylight" }, {
      user: card(60, { label: "User", icon: "user", variant: "actor" }),
      gateway: card(490, { icon: "shield" }),
      ordersDb: card(920, { icon: "database" }),
    });
    const style = rules(doc).filter((rule) => ["look", "icons", "actor", "actor-rows"].includes(rule));
    expect(style).toEqual([]);
  });

  it("assigns looks from the title, spread across all of them", () => {
    const about = (title: string) =>
      suggestLook(
        scene({}, { a: card(60), t: { type: "label", x: 60, y: 56, text: title, size: "title" } })
      );
    const titles = [
      "OAuth 2.0 authorization code flow",
      "DNS lookup lifecycle",
      "Circuit breaker states",
      "Git rebase versus merge",
      "HTTPS TLS handshake",
      "CI/CD pipeline",
      "Rolling deployment",
      "Job queue with retry",
      "Cache-aside read path",
      "How a CDN serves an image",
      "Two-phase commit",
      "Raft leader election",
    ];
    const picks = titles.map(about);
    // The same scene always gets the same look, and never the plain default.
    expect(titles.map(about)).toEqual(picks);
    expect(picks).not.toContain("slate");
    // A dozen technical subjects do not collapse onto one or two looks.
    expect(new Set(picks).size).toBeGreaterThanOrEqual(6);
    const most = Math.max(...LOOK_IDS.map((id) => picks.filter((pick) => pick === id).length));
    expect(most).toBeLessThanOrEqual(3);
  });

  it("says an actor's rows are not drawn", () => {
    const doc = scene({ look: "slate" }, {
      user: card(60, { icon: "user", variant: "actor", rows: [{ key: "a" }] }),
      b: card(490, { icon: "box" }),
    });
    expect(note(doc, "actor-rows")).toContain('"user" is an actor');
  });

  it("leaves a two-step sketch alone", () => {
    const doc = scene({}, { a: card(60), b: card(490) }, 2);
    expect(rules(doc).filter((rule) => ["look", "icons"].includes(rule))).toEqual([]);
  });
});

describe("the skill stays in step with the code", () => {
  const skill = readFileSync(
    join(__dirname, "..", "..", "skills/animation/SKILL.md"),
    "utf8"
  );

  it("names every look and every icon an author can use", () => {
    for (const id of LOOK_IDS) expect(skill).toContain(`\`${id}\``);
    for (const name of ICON_NAMES) expect(skill).toContain(`\`${name}\``);
  });

  it("gives the same hub and ring positions the layout notes do", () => {
    for (const position of [
      "`x: 490, y: 270`",
      "`x: 60, y: 270`; `x: 920, y: 270`; `x: 490, y: 490`; `x: 490, y: 50`",
      "`x: 150, y: 140`; `x: 830, y: 140`; `x: 830, y: 430`; `x: 150, y: 430`",
      "`x: 150, y: 140`; `x: 830, y: 140`; `x: 490, y: 430`",
    ]) {
      expect(skill).toContain(position);
    }
  });
});

describe("layout notes", () => {
  const rules = (doc: AnimDocument) => lintDocument(doc).map((note) => note.rule);
  const layout = (doc: AnimDocument) =>
    lintDocument(doc).find((item) => item.rule === "layout")?.message ?? "";
  const edge = (from: string, to: string, text = "go") => ({ type: "edge", from, to, text });
  const styled = { look: "slate" };
  const box = (x: number, y = 190) => card(x, { icon: "box", w: 195, y });

  /** Apply the "x", "y" moves a layout note lists, the way an author would. */
  function applyMoves(message: string, parts: Record<string, any>, stage: Record<string, unknown>) {
    for (const [, id, x, y] of message.matchAll(/"([A-Za-z0-9]+)" to "x": (\d+), "y": (\d+)/g)) {
      parts[id] = { ...parts[id], x: Number(x), y: Number(y), w: 220, h: 144 };
    }
    return scene({ ...stage, height: 700 }, parts);
  }

  it("spots a hub drawn as a row, and its positions draw clean", () => {
    const parts: Record<string, any> = {
      browser: box(60),
      resolver: box(355),
      root: box(650),
      tld: box(945),
      ask: edge("browser", "resolver"),
      askRoot: edge("resolver", "root"),
      askTld: edge("resolver", "tld"),
    };
    const message = layout(scene(styled, parts));
    expect(message).toContain('Every edge goes to or from "resolver", so this is a hub');
    expect(message).toContain('"resolver" to "x": 490, "y": 270');
    const moved = applyMoves(message, parts, styled);
    expect(rules(moved)).not.toContain("layout");
    expect(rules(moved).filter((rule) => ["overlap", "off-stage", "edge-crosses", "edge-text-fit"].includes(rule))).toEqual([]);
  });

  it("spots a loop drawn as a row, and its positions draw clean", () => {
    const parts: Record<string, any> = {
      closed: box(60),
      open: box(355),
      half: box(650),
      probe: box(945),
      a: edge("closed", "open", "failures pass the limit"),
      b: edge("open", "half", "after a timeout"),
      c: edge("half", "probe", "one trial"),
      d: edge("probe", "closed", "it succeeds"),
    };
    const message = layout(scene(styled, parts));
    expect(message).toContain("The edges form a loop through all 4 boxes");
    const moved = applyMoves(message, parts, styled);
    expect(rules(moved)).not.toContain("layout");
    expect(rules(moved).filter((rule) => ["overlap", "off-stage", "edge-crosses", "edge-text-fit"].includes(rule))).toEqual([]);
  });

  it("leaves a chain in its row, and a deliberate layout alone", () => {
    const chain = {
      a: box(60),
      b: box(355),
      c: box(650),
      d: box(945),
      e1: edge("a", "b"),
      e2: edge("b", "c"),
      e3: edge("c", "d"),
    };
    expect(rules(scene(styled, chain))).not.toContain("layout");

    const stacked = {
      hub: box(490, 270),
      a: box(60, 270),
      b: box(920, 270),
      c: box(490, 490),
      e1: edge("hub", "a"),
      e2: edge("hub", "b"),
      e3: edge("hub", "c"),
    };
    expect(rules(scene({ ...styled, height: 700 }, stacked))).not.toContain("layout");
  });

  it("lets a vertical edge carry long text, since the text runs sideways", () => {
    const parts = {
      top: card(490, { icon: "box", y: 50 }),
      bottom: card(490, { icon: "box", y: 270 }),
      down: edge("top", "bottom", "a fairly long label for a short drop"),
    };
    expect(rules(scene({ ...styled, height: 700 }, parts))).not.toContain("edge-text-fit");
  });
});

