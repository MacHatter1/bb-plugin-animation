/**
 * Keeping the editor's document and the file on disk in step.
 *
 * Deliberately free of React, so the ordering rules can be tested without a
 * DOM. The editor owns the document; this owns *when* it may be written, and
 * when a version from disk may replace it:
 *
 * - **One write at a time.** A save asked for while another is in flight waits
 *   for it, then writes whatever the document is by then.
 * - **Dirty is a revision count, not a flag.** An edit made while a save is in
 *   flight is still dirty when that save lands, so it is never marked saved.
 * - **Disk wins only when nothing local can be lost.** A polled version is
 *   taken only with no unsaved edit, no save in flight, no gesture in progress,
 *   and no edit made while the read was on its way back.
 * - **A conflict stops saving until the user picks a side.** Reload takes the
 *   disk version; overwrite keeps theirs, against the version now on disk.
 */

export type WriteResult =
  | { ok: true; outcome: "written"; sha256: string }
  | { ok: true; outcome: "conflict"; currentSha256: string | null }
  | { ok: false; error: string };

export type ReadResult =
  | { ok: true; content: string; sha256: string }
  | { ok: false; error: string };

export interface SyncIO {
  read(): Promise<ReadResult>;
  write(content: string, expectedSha256: string | null): Promise<WriteResult>;
}

/** `clean` means there was nothing to write. */
export type SaveOutcome = "saved" | "clean" | "conflict" | "error";

/** True when, after this outcome, the file on disk matches the editor. */
export function isOnDisk(outcome: SaveOutcome): boolean {
  return outcome === "saved" || outcome === "clean";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Snapshot undo. Snapshots are cheap because documents are never mutated. */
export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly limit = 60) {}

  record(previous: T): void {
    this.past = [...this.past.slice(-(this.limit - 1)), previous];
    this.future = [];
  }

  undo(current: T): T | undefined {
    const previous = this.past.pop();
    if (previous !== undefined) this.future.push(current);
    return previous;
  }

  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next !== undefined) this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}

export class DocumentSync<T> {
  readonly history: EditHistory<T>;

  private sha256: string | null = null;
  private savedText: string | null = null;
  private revision = 0;
  private savedRevision = 0;
  /** Bumped by `adopt`, so a write that lands after a reload changes nothing. */
  private generation = 0;
  private inFlight: Promise<SaveOutcome> | null = null;
  private conflicted = false;
  /** What the disk reported at the last conflict: the version to overwrite. */
  private diskSha256: string | null = null;
  private error: string | null = null;

  constructor(
    private readonly io: SyncIO,
    private readonly onChange: () => void = () => undefined,
    historyLimit = 60,
  ) {
    this.history = new EditHistory<T>(historyLimit);
  }

  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  get saving(): boolean {
    return this.inFlight !== null;
  }

  get conflict(): boolean {
    return this.conflicted;
  }

  get lastError(): string | null {
    return this.error;
  }

  /** Take `content` as the file's current state, and forget local history. */
  adopt(content: string, sha256: string): void {
    this.sha256 = sha256;
    this.savedText = content;
    this.generation += 1;
    this.revision += 1;
    this.savedRevision = this.revision;
    this.conflicted = false;
    this.diskSha256 = null;
    this.error = null;
    this.history.clear();
    this.onChange();
  }

  /** Record a committed edit. `previous` is what undo returns to. */
  edited(previous: T): void {
    this.history.record(previous);
    this.bump();
  }

  undo(current: T): T | undefined {
    const previous = this.history.undo(current);
    if (previous !== undefined) this.bump();
    return previous;
  }

  redo(current: T): T | undefined {
    const next = this.history.redo(current);
    if (next !== undefined) this.bump();
    return next;
  }

  /**
   * Write the document. `serialize` runs when the write actually starts, so a
   * save that had to wait writes the latest document, not the one it was
   * asked for with.
   */
  async save(
    serialize: () => string,
    options: { overwrite?: boolean } = {},
  ): Promise<SaveOutcome> {
    while (this.inFlight) await this.inFlight;
    if (this.conflicted && !options.overwrite) return "conflict";
    if (!this.dirty && !options.overwrite) return "clean";

    const text = serialize();
    const expected = this.conflicted ? this.diskSha256 : this.sha256;
    this.inFlight = this.write(text, expected, this.revision, this.generation);
    this.onChange();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
      this.onChange();
    }
  }

  /** Replace the editor's copy with the file on disk, discarding local edits. */
  async reload(): Promise<ReadResult> {
    while (this.inFlight) await this.inFlight;
    const result = await this.readSafely();
    if (result.ok) this.adopt(result.content, result.sha256);
    return result;
  }

  /**
   * Look for a newer version on disk. Returns it when it was taken, or null
   * when there was nothing new or taking it could have lost local work.
   * `canApply` is the editor's say, such as "no drag in progress".
   */
  async poll(
    canApply: () => boolean = () => true,
  ): Promise<{ content: string; sha256: string } | null> {
    const quiet = () =>
      !this.dirty && !this.inFlight && !this.conflicted && canApply();
    if (!quiet()) return null;
    const revision = this.revision;
    const result = await this.readSafely();
    if (!result.ok || this.revision !== revision || !quiet()) return null;
    if (result.sha256 === this.sha256 || result.content === this.savedText) {
      return null;
    }
    this.adopt(result.content, result.sha256);
    return { content: result.content, sha256: result.sha256 };
  }

  private bump(): void {
    this.revision += 1;
    this.onChange();
  }

  private async readSafely(): Promise<ReadResult> {
    try {
      return await this.io.read();
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  private async write(
    text: string,
    expected: string | null,
    revision: number,
    generation: number,
  ): Promise<SaveOutcome> {
    let result: WriteResult;
    try {
      result = await this.io.write(text, expected);
    } catch (error) {
      result = { ok: false, error: describe(error) };
    }
    // Reloaded while this write was in flight: the editor now shows the disk
    // version, and the next poll picks up whatever this write left there.
    if (generation !== this.generation) {
      return result.ok && result.outcome === "written" ? "saved" : "error";
    }
    if (!result.ok) {
      this.error = result.error;
      return "error";
    }
    if (result.outcome === "conflict") {
      this.conflicted = true;
      this.diskSha256 = result.currentSha256;
      return "conflict";
    }
    this.sha256 = result.sha256;
    this.savedText = text;
    this.savedRevision = revision;
    this.conflicted = false;
    this.diskSha256 = null;
    this.error = null;
    return "saved";
  }
}
