// @vitest-environment node
/**
 * The editor's save and reload rules. Each case is a way the editor used to
 * lose work or overwrite someone else's: an edit made mid-save marked saved,
 * two saves conflicting with each other, a poll landing mid-drag, undo after a
 * reload, and a conflict with no way out but discarding your changes.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DocumentSync,
  isOnDisk,
  type ReadResult,
  type WriteResult,
} from "../components/documentSync";

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A file on disk whose reads and writes can be held open mid-flight. */
function fakeDisk(initial: string) {
  let content = initial;
  let writeGate: ReturnType<typeof deferred> | null = null;
  let readGate: ReturnType<typeof deferred> | null = null;
  let active = 0;
  const state = {
    writes: [] as Array<{ content: string; expected: string | null }>,
    maxConcurrentWrites: 0,
    failNextWrite: false,
  };
  return {
    state,
    get content() {
      return content;
    },
    externalEdit(next: string) {
      content = next;
    },
    holdWrites() {
      writeGate = deferred();
      return writeGate;
    },
    holdReads() {
      readGate = deferred();
      return readGate;
    },
    io: {
      read: async (): Promise<ReadResult> => {
        const gate = readGate;
        const snapshot = { content, sha256: sha(content) };
        if (gate) await gate.promise;
        return { ok: true, ...snapshot };
      },
      write: async (
        next: string,
        expected: string | null,
      ): Promise<WriteResult> => {
        state.writes.push({ content: next, expected });
        active += 1;
        state.maxConcurrentWrites = Math.max(state.maxConcurrentWrites, active);
        try {
          if (writeGate) await writeGate.promise;
          if (state.failNextWrite) {
            state.failNextWrite = false;
            throw new Error("disk full");
          }
          if (expected !== sha(content)) {
            return { ok: true, outcome: "conflict", currentSha256: sha(content) };
          }
          content = next;
          return { ok: true, outcome: "written", sha256: sha(next) };
        } finally {
          active -= 1;
        }
      },
    },
  };
}

/** An editor document as a plain string, with the sync wired the usual way. */
function editor(initial = "v1") {
  const disk = fakeDisk(initial);
  const sync = new DocumentSync<string>(disk.io);
  sync.adopt(initial, sha(initial));
  let doc = initial;
  return {
    disk,
    sync,
    get doc() {
      return doc;
    },
    edit(next: string) {
      sync.edited(doc);
      doc = next;
    },
    save(options?: { overwrite?: boolean }) {
      return sync.save(() => doc, options);
    },
  };
}

describe("DocumentSync saving", () => {
  it("keeps an edit made during a save dirty, then writes it", async () => {
    const ed = editor();
    ed.edit("v2");
    const gate = ed.disk.holdWrites();
    const first = ed.save();

    ed.edit("v3");
    const second = ed.save();
    gate.resolve();

    expect(await first).toBe("saved");
    expect(await second).toBe("saved");
    expect(ed.disk.content).toBe("v3");
    expect(ed.sync.dirty).toBe(false);
  });

  it("runs one write at a time, so overlapping saves never conflict with each other", async () => {
    const ed = editor();
    ed.edit("v2");
    const gate = ed.disk.holdWrites();
    const autosave = ed.save();
    const manual = ed.save();
    gate.resolve();

    expect(await Promise.all([autosave, manual])).toEqual(["saved", "clean"]);
    expect(ed.disk.state.maxConcurrentWrites).toBe(1);
    expect(ed.disk.state.writes).toHaveLength(1);
    expect(ed.sync.conflict).toBe(false);
  });

  it("writes the latest document when a queued save finally runs", async () => {
    const ed = editor();
    ed.edit("v2");
    const gate = ed.disk.holdWrites();
    const first = ed.save();
    const queued = ed.save();
    ed.edit("v3");
    gate.resolve();
    await Promise.all([first, queued]);

    expect(ed.disk.state.writes.map((write) => write.content)).toEqual([
      "v2",
      "v3",
    ]);
    expect(ed.disk.state.writes[1].expected).toBe(sha("v2"));
  });

  it("reports a failed write as an error and stays dirty", async () => {
    const ed = editor();
    ed.edit("v2");
    ed.disk.state.failNextWrite = true;

    expect(await ed.save()).toBe("error");
    expect(ed.sync.lastError).toBe("disk full");
    expect(ed.sync.dirty).toBe(true);
    expect(ed.disk.content).toBe("v1");
  });
});

describe("DocumentSync conflicts", () => {
  it("stops saving after a conflict instead of retrying with a stale hash", async () => {
    const ed = editor();
    ed.disk.externalEdit("agent");
    ed.edit("mine");

    expect(await ed.save()).toBe("conflict");
    expect(await ed.save()).toBe("conflict");
    expect(ed.disk.state.writes).toHaveLength(1);
    expect(ed.disk.content).toBe("agent");
  });

  it("offers a way out that keeps local edits: overwrite the version now on disk", async () => {
    const ed = editor();
    ed.disk.externalEdit("agent");
    ed.edit("mine");
    await ed.save();

    expect(await ed.save({ overwrite: true })).toBe("saved");
    expect(ed.disk.content).toBe("mine");
    expect(ed.sync.conflict).toBe(false);
    expect(ed.sync.dirty).toBe(false);
  });

  it("does not export over a failed save", async () => {
    const ed = editor();
    ed.disk.externalEdit("agent");
    ed.edit("mine");

    expect(isOnDisk(await ed.save())).toBe(false);
    ed.disk.state.failNextWrite = true;
    expect(isOnDisk(await ed.save({ overwrite: true }))).toBe(false);
    expect(isOnDisk(await ed.save({ overwrite: true }))).toBe(true);
    expect(isOnDisk(await ed.save())).toBe(true);
  });
});

describe("DocumentSync reloading", () => {
  it("clears undo on reload, so undo cannot replay a pre-reload document", async () => {
    const ed = editor();
    ed.edit("v2");
    ed.edit("v3");
    ed.disk.externalEdit("agent");

    const result = await ed.sync.reload();
    expect(result.ok && result.content).toBe("agent");
    expect(ed.sync.undo("agent")).toBeUndefined();
    expect(ed.sync.redo("agent")).toBeUndefined();
    expect(ed.sync.dirty).toBe(false);
  });

  it("waits for a write in flight before reloading", async () => {
    const ed = editor();
    ed.edit("v2");
    const gate = ed.disk.holdWrites();
    const saving = ed.save();
    const reloading = ed.sync.reload();
    gate.resolve();

    await saving;
    const result = await reloading;
    expect(result.ok && result.content).toBe("v2");
    expect(ed.sync.dirty).toBe(false);
  });

  it("ignores a write that lands after the document was replaced", async () => {
    const ed = editor();
    ed.edit("v2");
    const gate = ed.disk.holdWrites();
    const saving = ed.save();
    ed.sync.adopt("other", sha("other"));
    gate.resolve();
    await saving;

    expect(ed.sync.dirty).toBe(false);
    expect(ed.sync.undo("other")).toBeUndefined();
  });
});

describe("DocumentSync polling", () => {
  it("takes a newer version from disk when nothing local would be lost", async () => {
    const ed = editor();
    ed.disk.externalEdit("agent");

    expect(await ed.sync.poll()).toEqual({
      content: "agent",
      sha256: sha("agent"),
    });
    expect(ed.sync.dirty).toBe(false);
  });

  it("returns nothing when the disk has not changed", async () => {
    const ed = editor();
    expect(await ed.sync.poll()).toBeNull();
  });

  it("leaves unsaved edits alone", async () => {
    const ed = editor();
    ed.edit("mine");
    ed.disk.externalEdit("agent");
    expect(await ed.sync.poll()).toBeNull();
  });

  it("leaves a drag in progress alone, before and after the read", async () => {
    const ed = editor();
    ed.disk.externalEdit("agent");
    expect(await ed.sync.poll(() => false)).toBeNull();

    let dragging = false;
    const gate = ed.disk.holdReads();
    const polling = ed.sync.poll(() => !dragging);
    dragging = true;
    gate.resolve();
    expect(await polling).toBeNull();
  });

  it("drops a read that raced a local edit, and the next save conflicts instead of reverting the agent", async () => {
    const ed = editor();
    ed.disk.externalEdit("agent");
    const gate = ed.disk.holdReads();
    const polling = ed.sync.poll();
    ed.edit("mine");
    gate.resolve();

    expect(await polling).toBeNull();
    expect(await ed.save()).toBe("conflict");
    expect(ed.disk.content).toBe("agent");
  });

  it("does not read the disk while a save is in flight", async () => {
    const ed = editor();
    ed.edit("v2");
    const gate = ed.disk.holdWrites();
    const saving = ed.save();
    expect(await ed.sync.poll()).toBeNull();
    gate.resolve();
    await saving;
  });
});
