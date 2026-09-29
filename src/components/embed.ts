/**
 * Loading and pacing for the inline `::scene` embed, kept free of React so it
 * can be tested without a DOM.
 */

import { parseDocument } from "../core/parse";
import { htmlFileRefs, type HtmlAssets } from "../core/htmlParts";
import type { AnimDocument } from "../core/types";

export interface EmbedIO {
  readFile(): Promise<
    { ok: true; content: string } | { ok: false; error: string }
  >;
  readAssets(refs: string[]): Promise<{ assets: Record<string, string> }>;
}

export type EmbedLoad =
  | { ok: true; doc: AnimDocument; assets: HtmlAssets }
  | { ok: false; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read and parse an embedded scene. Never throws: a failed read, a rejected
 * call or a document with parse errors comes back as a message to show,
 * rather than a stage stuck on "Loading" or drawn blank.
 */
export async function loadEmbed(path: string, io: EmbedIO): Promise<EmbedLoad> {
  try {
    const file = await io.readFile();
    if (!file.ok) return { ok: false, error: file.error };
    const parsed = parseDocument(file.content);
    const errors = parsed.problems.filter((problem) => problem.level === "error");
    if (errors.length > 0) {
      const first = errors[0];
      const where = first.path ? `${first.path}: ` : "";
      return {
        ok: false,
        error: `${path} has ${errors.length} parse error${
          errors.length === 1 ? "" : "s"
        }. ${where}${first.message}`,
      };
    }
    const refs = htmlFileRefs(parsed.doc);
    const assets: HtmlAssets =
      refs.length > 0
        ? new Map(Object.entries((await io.readAssets(refs)).assets))
        : new Map();
    return { ok: true, doc: parsed.doc, assets };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/**
 * Moves an embed from step to step with one timer per step.
 *
 * An embed only changes at a step boundary, so a frame loop would do nothing
 * useful between them. `wrapped` marks the jump from the last step back to the
 * first, which plays as a hard cut, the same as in the editor.
 */
export class StepTicker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private index: number;

  constructor(
    private readonly durations: readonly number[],
    private readonly onStep: (index: number, wrapped: boolean) => void,
    startIndex = 0,
  ) {
    this.index = durations.length > 0 ? startIndex % durations.length : 0;
  }

  start(): void {
    // With one step there is nothing to advance to.
    if (this.timer !== null || this.durations.length < 2) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.index = (this.index + 1) % this.durations.length;
      this.onStep(this.index, this.index === 0);
      this.schedule();
    }, Math.max(1, this.durations[this.index]));
  }
}
