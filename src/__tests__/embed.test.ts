// @vitest-environment node
/**
 * The inline `::scene` embed. Loading must always end in a stage or a message,
 * never a stage stuck on "Loading" or drawn blank, and playback must wake up
 * once per step rather than once per frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEmbed, StepTicker, type EmbedIO } from "../components/embed";
import { DEFAULT_ANIMATION_JSON } from "../template";

function io(content: string, assets: Record<string, string> = {}): EmbedIO {
  return {
    readFile: async () => ({ ok: true, content }),
    readAssets: async () => ({ assets }),
  };
}

describe("loadEmbed", () => {
  it("loads a valid scene with its partials", async () => {
    const scene = JSON.stringify({
      parts: {
        card: { type: "html", x: 0, y: 0, w: 100, h: 50, htmlFile: "card.html" },
      },
      steps: [{ id: "a", duration: 500 }],
    });
    const result = await loadEmbed("flow.scene.json", io(scene, { "card.html": "<p>hi</p>" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.steps).toHaveLength(1);
      expect(result.assets.get("card.html")).toBe("<p>hi</p>");
    }
  });

  it("reports a parse error instead of drawing an empty stage", async () => {
    const result = await loadEmbed("flow.scene.json", io("{ not json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^flow\.scene\.json has 1 parse error\. Not valid JSON/);
    }
  });

  it("reports a failed read", async () => {
    const result = await loadEmbed("flow.scene.json", {
      readFile: async () => ({ ok: false, error: "not found" }),
      readAssets: async () => ({ assets: {} }),
    });
    expect(result).toEqual({ ok: false, error: "not found" });
  });

  it("reports a rejected call instead of leaving the embed loading", async () => {
    const result = await loadEmbed("flow.scene.json", {
      readFile: () => Promise.reject(new Error("host went away")),
      readAssets: async () => ({ assets: {} }),
    });
    expect(result).toEqual({ ok: false, error: "host went away" });
  });

  it("loads the starter document", async () => {
    const result = await loadEmbed("a.scene.json", io(DEFAULT_ANIMATION_JSON));
    expect(result.ok).toBe(true);
  });
});

describe("StepTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances once per step and marks the wrap back to the first", () => {
    const seen: Array<[number, boolean]> = [];
    const ticker = new StepTicker([100, 200, 300], (index, wrapped) =>
      seen.push([index, wrapped]),
    );
    ticker.start();

    vi.advanceTimersByTime(100);
    expect(seen).toEqual([[1, false]]);
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([
      [1, false],
      [2, false],
      [0, true],
    ]);
    ticker.stop();
  });

  it("wakes per step, not per frame", () => {
    const onStep = vi.fn();
    const ticker = new StepTicker([1000, 1000], onStep);
    ticker.start();
    vi.advanceTimersByTime(10_000);
    // Ten seconds at 60fps would be 600 frames.
    expect(onStep).toHaveBeenCalledTimes(10);
    ticker.stop();
  });

  it("does nothing for a single step, and nothing after stop", () => {
    const onStep = vi.fn();
    const single = new StepTicker([500], onStep);
    single.start();
    vi.advanceTimersByTime(5000);
    expect(onStep).not.toHaveBeenCalled();

    const ticker = new StepTicker([100, 100], onStep);
    ticker.start();
    ticker.stop();
    vi.advanceTimersByTime(1000);
    expect(onStep).not.toHaveBeenCalled();
  });

  it("resumes from the step it was on", () => {
    const seen: number[] = [];
    const ticker = new StepTicker([100, 200, 300], (index) => seen.push(index), 2);
    ticker.start();
    vi.advanceTimersByTime(299);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0]);
    ticker.stop();
  });
});
