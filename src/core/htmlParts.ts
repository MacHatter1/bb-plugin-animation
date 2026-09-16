/**
 * Where an `html` part's markup comes from, and the one substitution it gets.
 *
 * This exists because the `html` part as first shipped could only carry inline
 * markup, and inline markup in JSON has no way to say "the same widget again
 * with different text". Authors answered that with generator scripts that
 * emitted the `.scene.json`, which quietly cost the format its main property:
 * the document stopped being the thing you edit. `htmlFile` + `vars` are the
 * smallest set of features that make the document authorable again.
 *
 * There is deliberately no bundled component library. The markup worth reusing
 * is always the author's own product, so a partial shipped here could only ever
 * be somebody else's app. Reuse is a `partials/` folder in your project that
 * `htmlFile` points at.
 *
 * `vars` is deliberately not a template language. There is no conditional, no
 * loop and no expression -- only `{{name}}` replaced by an HTML-escaped string.
 * Anything more would have to be re-implemented identically by the editor, the
 * standalone export and the GIF recorder, and the first time they disagreed the
 * "a frame is a pure function of (document, t)" guarantee would be gone.
 */

import type { AnimDocument, HtmlPart } from "./types";

/** Markup for each `htmlFile` path a document referenced, keyed as written. */
export type HtmlAssets = ReadonlyMap<string, string>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Values are text, never markup.
 *
 * `sanitizeHtml` runs downstream and would strip anything executable anyway,
 * but escaping here is what keeps a var from changing the *structure* of the
 * partial it lands in -- a value containing `</div>` should read as those
 * characters, not close the author's element.
 */
export function escapeVarValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Substitute `{{name}}`. An unknown name resolves to empty, never to itself. */
export function applyVars(
  markup: string,
  vars?: Record<string, string>
): string {
  if (!PLACEHOLDER.test(markup)) return markup;
  PLACEHOLDER.lastIndex = 0;
  return markup.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars?.[name];
    return value === undefined ? "" : escapeVarValue(value);
  });
}

/**
 * The markup this part draws, before sanitization.
 *
 * `htmlFile` wins over inline `html`, matching the order the parser validates
 * them in. An unresolved source renders as nothing rather than as a broken box:
 * the parser has already recorded a problem for it, and the stage is not the
 * place to surface one.
 */
export function resolveHtmlMarkup(
  part: HtmlPart,
  assets?: HtmlAssets
): string {
  const source = part.htmlFile
    ? assets?.get(part.htmlFile) ?? ""
    : part.html ?? "";
  return applyVars(source, part.vars);
}

/** Every distinct `htmlFile` a document names, in first-seen order. */
export function htmlFileRefs(doc: AnimDocument): string[] {
  const seen = new Set<string>();
  for (const part of Object.values(doc.parts)) {
    if (part.type === "html" && part.htmlFile) seen.add(part.htmlFile);
  }
  return [...seen];
}

/**
 * Resolve an `htmlFile` against the document that named it.
 *
 * Relative only. An absolute path would let a document pull markup from
 * anywhere the host can read, and `htmlFile` is meant to be "the file next to
 * this one", not a general include. `..` is allowed so a set of animations can
 * share a partials directory, but not past the filesystem root.
 */
export function resolveSiblingPath(
  basePath: string,
  ref: string
): string | null {
  if (ref.trim() === "" || /^(?:[A-Za-z]:)?[\\/]/.test(ref)) return null;
  const segments = basePath.replace(/[\\/][^\\/]*$/, "").split(/[\\/]/);
  for (const segment of ref.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Read every `htmlFile` a document references.
 *
 * Async, and therefore deliberately outside the renderer: `renderScene` stays a
 * pure function of (document, assets, t), so the editor preview, the standalone
 * export and the GIF recorder cannot drift by resolving files at different
 * times. Callers do the reading -- the editor through `host.fs`, the AI tools
 * through the filesystem service -- and hand the result in.
 *
 * A file that cannot be read is reported, not thrown: one missing partial
 * should cost you that part, not the whole stage.
 */
export async function loadHtmlAssets(
  doc: AnimDocument,
  basePath: string,
  readFile: (path: string) => Promise<string>
): Promise<{ assets: HtmlAssets; errors: string[] }> {
  const assets = new Map<string, string>();
  const errors: string[] = [];

  await Promise.all(
    htmlFileRefs(doc).map(async (ref) => {
      const path = resolveSiblingPath(basePath, ref);
      if (path === null) {
        errors.push(
          `htmlFile ${JSON.stringify(ref)} must be a path relative to the document.`
        );
        return;
      }
      try {
        assets.set(ref, await readFile(path));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        errors.push(
          `Could not read htmlFile ${JSON.stringify(ref)}: ${message}`
        );
      }
    })
  );

  return { assets, errors };
}
