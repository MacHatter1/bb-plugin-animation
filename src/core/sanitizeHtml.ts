/**
 * Allowlist sanitizer for `html` part markup.
 *
 * This is a security boundary, not a tidy-up pass. The in-editor stage renders
 * in a script-disabled sandboxed iframe, so nothing here can run there -- but
 * `standalone.ts` exports a real page that *does* carry a `<script>` (the
 * playback runtime), and that file is meant to be shared. Markup that reaches
 * the export unchecked would execute on whoever opens it.
 *
 * So the rule is allowlist, never denylist: an element or attribute that is not
 * named below is dropped. A new tag being silently stripped is a bug report; a
 * new tag being silently permitted is a vulnerability.
 *
 * The second reason this is strict: the format's determinism guarantee. Frames
 * must be a pure function of (document, t) or scrubbing, GIF export and the
 * packaged HTML stop agreeing with each other. Script is what would break that,
 * so `html` parts are static markup whose *state* is animated by steps, exactly
 * like every other part type.
 *
 * No DOM is used -- this runs in the renderer and in export paths alike.
 */

/** Elements whose content is dropped along with the tag itself. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
  "form",
]);

/** Elements that may appear in `html` part markup. */
const ALLOWED_TAGS = new Set([
  "div", "span", "p", "br", "hr",
  "a", "img",
  "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark",
  "code", "pre", "kbd", "samp", "blockquote",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "figure", "figcaption",
  "section", "header", "footer", "main", "article", "aside", "nav",
]);

/** Elements that never have a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "img"]);

/**
 * Attributes allowed on any permitted element. `aria-*` is handled separately.
 *
 * The three `data-*` names are the sub-part protocol: markup inside a single
 * `html` part declares its own animatable regions, and the stage drives them
 * with the same `querySelector` + `setAttribute` it uses for top-level parts.
 * They are named individually rather than allowing `data-*` wholesale, because
 * a blanket rule would also carry through whatever a future host attaches
 * meaning to.
 */
const ALLOWED_ATTRS = new Set([
  "class",
  "style",
  "title",
  "alt",
  "width",
  "height",
  "colspan",
  "rowspan",
  "dir",
  "lang",
  "role",
  "data-part",
  "data-state",
  "data-tone",
]);

/** CSS constructs that can fetch or execute, regardless of surrounding syntax. */
const DANGEROUS_CSS = /(expression\s*\(|javascript\s*:|behaviou?r\s*:|-moz-binding|@import|<\/)/i;

/**
 * `url(...)` is the one CSS function that reaches the network. Allow only
 * inline images and https, so a shared export cannot be a tracking beacon.
 */
function cssUrlsAreSafe(value: string): boolean {
  const urls = value.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi);
  for (const match of urls) {
    const target = match[2].trim().toLowerCase();
    if (!target.startsWith("data:image/") && !target.startsWith("https://")) {
      return false;
    }
  }
  return true;
}

function safeStyle(value: string): string | null {
  if (DANGEROUS_CSS.test(value)) return null;
  if (!cssUrlsAreSafe(value)) return null;
  return value.replace(/--anim-/g, "--scene-");
}

const LEGACY_SCENE_CLASSES: Record<string, string> = {
  "anim-part": "scene-part",
  "anim-subpart": "scene-subpart",
  "anim-spin": "scene-spin",
  "anim-selected": "scene-selected",
};

function rewriteLegacyClass(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => LEGACY_SCENE_CLASSES[token] ?? token)
    .join(" ");
}

function safeHref(value: string): string | null {
  const v = value.trim();
  if (v.startsWith("#")) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^mailto:/i.test(v)) return v;
  return null;
}

function safeSrc(value: string): string | null {
  const v = value.trim();
  if (/^data:image\//i.test(v)) return v;
  if (/^https:\/\//i.test(v)) return v;
  return null;
}

/**
 * Escape an attribute value, leaving entities that are already entities alone.
 *
 * Same rule as `escapeText`, and for the same reason: sanitizing an already-
 * sanitized document has to be a no-op. It matters more here than it looks.
 * `renderToStaticMarkup` writes `'` as `&#x27;`, so a component whose style
 * carries a quoted font family (`font-family:...,'Segoe UI',...`) arrives with
 * entities in it. Escaping the `&` unconditionally turned that into
 * `&amp;#x27;`, the browser rendered the literal text `&#x27;` inside the CSS
 * value, and the font silently fell back -- invisible in a screenshot, visible
 * in a video.
 *
 * `<`, `>` and `"` stay unconditional: an entity decodes only after the parser
 * has already found the attribute's end, so nothing here can break out of the
 * quoting.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape a run of text between tags.
 *
 * foreignObject content is parsed as XML, not HTML, so a bare `&` is a parse
 * error rather than a stray ampersand -- it would take the whole stage down,
 * not just the one part. Existing entities are left alone so escaping an
 * already-escaped document is a no-op.
 */
function escapeText(value: string): string {
  return value
    .replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const ATTR_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g;

function sanitizeAttributes(tag: string, raw: string): string {
  const kept: string[] = [];
  for (const match of raw.matchAll(ATTR_PATTERN)) {
    const name = match[1].toLowerCase();
    let value = match[2] ?? "";
    if (value.startsWith('"') || value.startsWith("'")) {
      value = value.slice(1, -1);
    }

    // Event handlers are the whole reason this function exists.
    if (name.startsWith("on")) continue;

    let out: string | null = null;
    if (name === "style") out = safeStyle(value);
    else if (name === "class") out = rewriteLegacyClass(value);
    else if (name === "href" && tag === "a") out = safeHref(value);
    else if (name === "src" && tag === "img") out = safeSrc(value);
    else if (name.startsWith("aria-")) out = value;
    else if (ALLOWED_ATTRS.has(name)) out = value;

    if (out === null) continue;
    kept.push(`${name}="${escapeAttr(out)}"`);
  }
  return kept.length > 0 ? ` ${kept.join(" ")}` : "";
}

/**
 * Walk the markup tag by tag, rebuilding it from only what is allowed.
 *
 * A tokenizer rather than a chain of regex replacements: replacement passes are
 * defeated by nesting (`<scr<script>ipt>`), and each new pattern has to be
 * correct against the output of every previous one. Walking once and emitting
 * only recognised constructs has no such interaction.
 */
export function sanitizeHtml(input: string): string {
  const out: string[] = [];
  let i = 0;
  // Names of unclosed allowed elements, so stray close tags can be dropped.
  const open: string[] = [];

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out.push(escapeText(input.slice(i)));
      break;
    }
    out.push(escapeText(input.slice(i, lt)));

    // Comments and doctypes carry no content we want.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      // An unterminated `<` is text, not a tag.
      out.push("&lt;");
      i = lt + 1;
      continue;
    }

    const rawTag = input.slice(lt + 1, gt);
    const closing = rawTag.startsWith("/");
    const body = closing ? rawTag.slice(1) : rawTag;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(body.trim());

    if (!nameMatch) {
      out.push("&lt;");
      i = lt + 1;
      continue;
    }

    const tag = nameMatch[1].toLowerCase();

    if (DROP_WITH_CONTENT.has(tag)) {
      if (closing) {
        i = gt + 1;
        continue;
      }
      // Skip to the matching close tag so the content goes too.
      const close = new RegExp(`</\\s*${tag}\\s*>`, "i");
      const rest = input.slice(gt + 1);
      const found = close.exec(rest);
      i = found ? gt + 1 + found.index + found[0].length : input.length;
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown element: drop the tag, keep whatever it wrapped.
      i = gt + 1;
      continue;
    }

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at !== -1) {
        // Close anything left dangling inside it, innermost first.
        for (let k = open.length - 1; k >= at; k -= 1) out.push(`</${open[k]}>`);
        open.length = at;
      }
      i = gt + 1;
      continue;
    }

    const attrs = sanitizeAttributes(
      tag,
      body.slice(nameMatch[1].length).replace(/\/\s*$/, "")
    );
    if (VOID_TAGS.has(tag)) {
      out.push(`<${tag}${attrs}/>`);
    } else {
      out.push(`<${tag}${attrs}>`);
      open.push(tag);
    }
    i = gt + 1;
  }

  // foreignObject content is parsed as XML, so nothing may be left unclosed.
  for (let k = open.length - 1; k >= 0; k -= 1) out.push(`</${open[k]}>`);
  return out.join("");
}
