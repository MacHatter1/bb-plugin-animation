/**
 * Keyboard and drag rules for the editor, as plain functions so they can be
 * tested without a DOM.
 */

export type EditorShortcut = "save" | "undo" | "redo" | "toggle";

/** What has focus when a key is pressed. */
export type FocusKind = "text" | "button" | "other";

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * Classify an event target.
 *
 * Duck-typed rather than `instanceof Element`, because keys pressed inside the
 * stage iframe come from that frame's realm, where the parent's `Element` does
 * not match.
 */
export function focusKind(target: unknown): FocusKind {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== "function") return "other";
  if (
    element.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  ) {
    return "text";
  }
  if (element.closest("button")) return "button";
  return "other";
}

/**
 * The editor command a key press means, if any.
 *
 * A text field keeps every key, so ⌘Z there undoes typing, not the document.
 * A focused button keeps Space, which already clicks it, but ⌘S and ⌘Z still
 * reach the editor: after pressing Play they are exactly what you reach for.
 */
export function editorShortcut(
  event: KeyPress,
  focus: FocusKind,
): EditorShortcut | null {
  if (focus === "text") return null;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && key === "s") return "save";
  if (mod && key === "z") return event.shiftKey ? "redo" : "undo";
  if (!mod && event.code === "Space" && focus !== "button") return "toggle";
  return null;
}

/** The duration a boundary drag asks for at `clientX`. */
export function draggedDuration(
  drag: { startX: number; startDuration: number; msPerPixel: number },
  clientX: number,
): number {
  if (drag.msPerPixel === 0) return drag.startDuration;
  return drag.startDuration + (clientX - drag.startX) * drag.msPerPixel;
}

/**
 * One boundary drag, from the first move to release or cancel.
 *
 * Every preview is computed from the document as it was when the drag began,
 * so a drag is a single edit however many moves it takes. Cancelling returns
 * that document, and so does a commit that changes nothing, rather than
 * leaving the last preview on screen.
 */
export class RetimeDrag<T> {
  private base: T | null = null;

  constructor(
    private readonly apply: (base: T, stepIndex: number, duration: number) => T,
  ) {}

  get active(): boolean {
    return this.base !== null;
  }

  preview(current: T, stepIndex: number, duration: number): T {
    if (this.base === null) this.base = current;
    return this.apply(this.base, stepIndex, duration);
  }

  commit(
    current: T,
    stepIndex: number,
    duration: number,
  ): { doc: T; base: T; changed: boolean } {
    const base = this.base ?? current;
    this.base = null;
    const doc = this.apply(base, stepIndex, duration);
    return { doc, base, changed: doc !== base };
  }

  /** End the drag without an edit. Returns the document to show again. */
  cancel(): T | null {
    const base = this.base;
    this.base = null;
    return base;
  }
}
