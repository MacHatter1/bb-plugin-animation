---
name: animation
description: Author step-based explainer diagrams as .scene.json files for BB's Animation plugin. Use when the user wants to animate a diagram, show how a system/protocol/algorithm behaves over time, build a motion explainer, export animation HTML, or turn a static architecture diagram into something that plays.
---

# Animation - step-based explainer diagrams

`.scene.json` files open in BB's Animation editor: a named scene plus an ordered list of steps that assign states to the scene's parts. You write plain JSON. Any agent can author or edit one with `Write` and `Edit` -- there is no binary format and no tool call required to author. Existing `.anim.json` files, `::animation` embeds, and Nimbalyst `anim-subpart` / `anim-spin` / `--anim-*` tokens still work. Write `.scene.json`, `::scene`, `scene-subpart`, `scene-spin`, and `--scene-*`.

BB surfaces:

- Open `*.scene.json` in the file preview (Animation editor).
- `bb animation new|validate|export` from a thread workspace.
- Native tools `animation_export_html` and `animation_validate`.
- Inline chat preview: `::scene{file="docs/flow.scene.json"}`.
- Click a part on the stage to quote its current state into chat.

## When to use this

- Explaining how a system behaves **over time**: a request crossing a network, a consensus round, a cache filling, a build pipeline, a queue draining.
- Turning a static architecture diagram into something that plays.
- Showing a failure and a recovery: the retry, the rollback, the rejected review.

**Do not use it** when a static diagram says the same thing. If nothing changes between the first frame and the last, you want a Mermaid block or a still drawing, not an animation.

## The mental model

Three rules drive every decision in this format:

1. **The document says what is true when, never how to tween.** There are no keyframes, easing curves, or property tracks. You assign a *state* to a part, and CSS transitions interpolate. Adding motion means naming a state, not scripting a timeline.
2. **States are cumulative.** A step asserts only what changes; every part it does not mention keeps whatever the previous step left it in. Write deltas. **To turn something off you must explicitly set it back** -- it will not decay on its own.
3. **Ids are names, not handles.** `store`, `title-card`, `queueTask01`. You will reference them constantly in `set` blocks; make them readable.

Times are **integer milliseconds**. Never frame indices, never floats.

## Document structure

```json
{
  "version": 1,
  "stage": { "width": 1200, "height": 640, "fps": 25 },
  "parts": { "<id>": { "type": "node" | "edge" | "label" | "shape", ... } },
  "steps": [ { "id": "...", "duration": 800, "caption": "...", "set": { ... } } ]
}
```

### stage

| Field | Notes |
| --- | --- |
| `width`, `height` | Clamped to 16..8192. The stage scales to fit the pane, so these set the aspect ratio and the coordinate system, not the pixel size. |
| `fps` | Only affects frame snapping and the readout. Use 25 unless you have a reason. Whole-millisecond frame rates: 10, 20, 25, 50. |
| `background` | Optional override. Omit it and the stage uses the theme surface, which is what you want -- the scene then follows the user's light/dark theme. |

1200x640 is a good default. Landscape, room for a header row and a bottom rail.

### parts

Part ids are the keys. All four types share `label`, `tone`, and `state` (their *baseline*, before any step runs).

**`node`** -- the workhorse. A titled card with an optional subtitle and key/value rows.

```json
{ "type": "node", "label": "Object store", "x": 740, "y": 118, "w": 240, "h": 176,
  "subtitle": "SHA -> BYTES",
  "rows": [ { "key": "f7a9", "value": "commit  182 B" }, { "key": "e816" } ] }
```

- `label` is **uppercased automatically**. Write `"Merge gate"`, it renders `MERGE GATE`. Falls back to the id.
- `subtitle` is a small mono line under the header. Keep it short and caps-ish; it is where model names, worktrees, and units go.
- `rows` render as boxed key/value pairs. `value` is optional. Key is left-aligned, value right-aligned.
- **A row that would spill past the bottom is silently dropped.** Size the node to its rows (see Geometry).

**`edge`** -- a line between two parts, optionally carrying packets.

```json
{ "type": "edge", "from": "client", "to": "store", "text": "GET <sha>", "packets": 4 }
```

- `from`/`to` are part ids. Drawn centre-to-centre and trimmed to the box borders, so stacked and side-by-side both look right.
- **A dangling `from`/`to` renders nothing at all** -- it looks like a broken renderer, not a broken document. Check your ids.
- `packets` is how many squares travel the line while it is flowing (default 3). Set `0` for an edge that means a *relationship* rather than traffic. One trip takes 1.6s.
- `text` draws a caption at the midpoint **on an opaque background plate** roughly `max(40, len × 7.6 + 16)` px wide. It will punch a hole through anything behind it. Only put `text` on an edge whose gap is wider than the plate.

**`label`** -- free-standing text.

```json
{ "type": "label", "x": 56, "y": 48, "text": "COMMIT DAG", "align": "start", "caps": true }
```

- `align`: `start` | `middle` | `end` (the anchor, at `x`).
- `caps: true` gives the faint, tracked-out micro-caption style used for section headings.
- **There is no font-size control.** Every label is 12px. Do not try to build a large title; build hierarchy with `caps`, tone, and position instead.

**`shape`** -- a plain rect or circle, with optional centered text.

```json
{ "type": "shape", "shape": "rect", "x": 89, "y": 438, "w": 40, "h": 18, "tone": "accent" }
```

Shapes are how you show **quantity**, because text never changes (see Hard constraints). A grid of small shapes that go `hidden` one group at a time is a queue draining, a battery discharging, a work list being claimed.

**`html`** -- freeform markup, for the things the primitives above cannot express: real typography, a type scale, flow layout, a UI that has to look like a real product rather than like a diagram of it.

The markup comes from one of two places:

```json
{ "type": "html", "x": 55, "y": 108, "w": 1090, "h": 534,
  "htmlFile": "./partials/app-window.html",
  "vars": { "title": "acme-api", "branch": "main" } }
```

- **`htmlFile`** is a path to a `.html` file next to the document. Relative only; `..` is allowed, absolute is refused.
- **`html`** is markup inline. Right for a few lines, wrong for a widget.

`vars` fills `{{name}}` placeholders in whichever source won. Values are **HTML-escaped**, so a var is text and cannot change the structure of the partial it lands in. An unfilled placeholder resolves to empty, never to its own name. That is the entire template language -- no conditionals, no loops, no expressions.

Three things about `html` parts that will otherwise cost you a build:

- **`--scene-tone` inherits into the markup.** Give a border, a badge, a button `color: var(--scene-tone)` plus a `transition`, and a step's tone change animates the whole widget. This is how you avoid a second copy of the markup for a second state.
- **Script, event handlers, `<style>` and non-`https`/`data:image` urls are stripped** at the render boundary. Inline `style=` attributes are fine.
- **An opaque `html` part hides every edge underneath it.** Edges are drawn before *all* non-edge parts, so a background on a container is enough to make a nested diagram's lines vanish with no error. Keep containers transparent and set `stage.background` to supply the surface colour instead.

### stage.theme

`stage` may carry a stamped palette that every renderer reads:

```json
"stage": { "width": 1200, "height": 675, "fps": 25, "theme": {
  "bg": "#1c1c1c", "border": "#383838", "accent": "#3b82f6",
  "--nim-panel": "#2f2f2f"
} }
```

Keys naming a stage token (`bg`, `surface`, `surfaceRaised`, `border`, `borderStrong`, `text`, `textMuted`, `textFaint`, `accent`, `success`, `warning`, `error`, `purple`) override that token. Keys of the form `--some-name` are emitted as extra custom properties, which is how a project carries its own vocabulary into the stage. Anything else is dropped.

Values, not a theme *name*: no renderer then needs a theme registry, and the extension stays neutral about whose product this is. The cost is that editing a theme in the app does not reach existing documents until they are restamped.

**Write markup against token names, not literal hex.** `var(--scene-border)` rather than `#383838` means switching palettes is a one-field edit with nothing to redraw. Reserve literal colours for things that genuinely are fixed -- macOS traffic lights.

Note that `stage.background`, if set, still wins over `theme.bg`.

### sub-parts

Markup inside one `html` part can declare regions a step addresses individually:

```html
<div class="scene-subpart" data-part="chrome/session-a">…</div>
```

A step then writes `"set": { "chrome/session-a": { "tone": "success" } }`, and the stage drives it with the same `querySelector` + `setAttribute` it uses for a top-level part. Declare each one in the part's `subParts` map so the baseline resolver knows it exists:

```json
"subParts": { "session-a": { "tone": "accent" }, "session-b": {} }
```

Two things to know:

- **The class is `scene-subpart`, never a nested `scene-part`.** `.scene-part` sets `--scene-tone` to neutral unconditionally, so a nested one *resets* to grey instead of inheriting its container's tone.
- **For a sub-part, `neutral` means "inherit", not "grey".** That is what lets a whole window go accent without every region inside it snapping back.

Writing `data-part` by hand is fine for two or three regions. Prefer that over a compile step.

### The spinner utility (`scene-spin`)

The stage ships one rotating primitive for `html` parts. Give any element `class="scene-spin"` and it becomes a lit ring turning at ~0.8s -- a running or loading indicator that reads as *live* rather than a static glyph. It is the rotational counterpart to the edge packet, and the only self-driven rotation the format has.

```html
<span class="scene-spin" style="width:8px;height:8px"></span>
```

- **Colour is `currentColor`,** so whatever wraps it sets the hue -- drop it inside a blue "running" pill and the ring is blue, no extra styling.
- **It spins on its own, across every step.** You do not drive it from `set`; it is a CSS animation, not a state. To make it stop, hide the part or sub-part it lives in on the step the work finishes (put it in its own `scene-subpart` if only the spinner should disappear).
- **It freezes but stays visible** while the playhead is scrubbed and under `prefers-reduced-motion`. The standalone HTML export keeps the same CSS animation.

Reach for it wherever the real UI shows a spinner: an agent session mid-run, a build in progress, a request in flight. It is the honest way to show "this is working right now" without faking motion the format cannot do.

### Building a kit for your project

Nothing product-specific ships with this extension, and that is deliberate: the markup worth reusing is always *your* product, so anything bundled here could only ever be somebody else's app.

Instead, build a small kit once and reuse it across every animation you make:

```
docs/animations/
  partials/
    app-window.html      <- your chrome: title bar, sidebar, main pane
    list-row.html        <- one row, used eight times with different vars
    toolbar.html
  onboarding.scene.json
  sync-explainer.scene.json
```

Three rules make a kit that lasts:

1. **Go look at the real thing first.** Chrome drawn from memory is wrong in *structure*, not just styling, and structural wrongness is invisible to you and instantly obvious to anyone who uses the product. Screenshot the app and draw against it.
2. **Simplify hard, then make one thing big.** Keep only what makes it recognisable at a glance; cut every pane that is not part of the story. Then pick one hero and draw it at a size you can actually read.
3. **Decide loop-vs-part per piece.** Markup that stays put lives inside a bigger partial. Anything a *step* changes is either its own top-level part positioned over the container, or -- if the container is a compiled component -- a sub-part the component declares. A `.html` partial has no way to declare one, so with partials a list's eight resting rows are one file and the row that turns green is its own part with its own coordinates.

A partial has no defaults -- a var you leave out renders as empty, not as an error -- so document the vars each one expects at the top of the file in a comment.

### Compiling components

This BB plugin does **not** ship the Nimbalyst `.tsx` compiler. Author `html` or `htmlFile` markup directly, and declare `subParts` by hand when a step needs to address a region inside that markup.

### tones

`neutral` `accent` `data` `success` `warning` `error` `muted`

They map to theme tokens, so they follow the user's theme: accent is blue, data purple, success green, warning amber, error red, neutral/muted a faint grey. **Assign them semantically and keep the meaning fixed for the whole animation** -- if amber means "under review" in step 4 it cannot mean "slow" in step 7.

### states

The state vocabulary is defined by the stylesheet, not the schema. Any other string parses fine and renders as `idle`, so a typo fails silently.

| Type | States |
| --- | --- |
| `node` | `idle` (default), `active` (tinted fill, tone border, status dot, first row highlighted), `waiting` (dashed amber border), `offline` (dashed red border, dimmed title), `hidden` |
| `edge` | `idle` (default, dashed grey), `flowing` (line fills in, packets travel from -> to), `returning` (same, packets travel **backwards**), `active` (same as flowing), `hidden` |
| `label` | `idle` (default), `active` (takes its tone colour), `hidden` |
| `shape` | `idle` (default, 14% tone fill), `active` (65% tone fill, reads as solid), `hidden` |

`returning` is the most useful state in the set and the most under-used: a reply, a rejection, a rollback travelling back down the same wire. Reversing packets beats drawing a second edge -- two overlapping edges between one pair of nodes look like a rendering fault.

### steps

```json
{ "id": "response", "duration": 1000,
  "caption": "The objects come back down the same wire.",
  "set": { "fetch": { "state": "returning", "tone": "success" } } }
```

- `id` is a readable slug, unique. It shows in the step strip.
- `duration` is how long this step **holds** before the next begins, in ms (1..600000; the editor's drag-to-retime floor is 40ms).
- `caption` is one sentence of narration. Read end to end, the captions should form a coherent paragraph -- they are also the animation's accessibility description.
- `set` maps part id -> `{ state?, tone? }`. Omit either and it inherits.

Playback **loops by default**, and the wrap is a hard cut: the stage jumps from your last step straight to the baseline-plus-first-step. Design that cut deliberately -- it should read as a reset, not as a glitch.

## Geometry

Layout is hand-placed, so these numbers matter.

**Node internals.** Header is 34px. The subtitle baseline sits at `y+56`. Rows start at `y+72` (or `y+56` with no subtitle), each row 26px tall with a 6px gap -- 32px of pitch. A row is dropped if it would come within 6px of the bottom.

> **Node height:** `h = 32 × rows + 80` with a subtitle, `h = 32 × rows + 64` without.
> Three rows plus a subtitle -> `h = 176`. Going much taller leaves a visible dead band under the last row.

Row text is 11px mono: key at `x+28`, value right-aligned at `x + w − 28`. At `w = 228` you have room for roughly a 6-character key and a 12-character value.

**Edges.** Keep every edge between **adjacent** boxes. An edge routes as a straight centre-to-centre line trimmed to the borders, so a diagonal across a grid will run straight through the cards in between. If two boxes you want to connect are not neighbours, move them.

Leave the gap wide enough for what the edge carries: ~40px for a bare edge with packets, ~70px if it has `text`.

**Layering.** Edges draw first (behind everything), then all other parts **in alphabetical id order**. That is the only layering control there is. To draw a part on top of another, give it an id that sorts later: `queue` (the panel) then `queueTask01`..`queueTask12` (the chiclets inside it).

## Canonical form

The editor rewrites the file on save with a fixed key order. **Hand-write it in canonical order or your first save will reformat the whole file and bury the real edit in the diff.**

- Root: `version`, `stage`, `parts`, `steps`
- `stage`: `width`, `height`, `fps`, `background`
- `parts`: **sorted alphabetically by id**. Within a part: `type`, `label`, `tone`, `state`, then
  - node: `x`, `y`, `w`, `h`, `subtitle`, `rows`
  - edge: `from`, `to`, `text`, `packets`
  - label: `x`, `y`, `text`, `align`, `caps`
  - shape: `x`, `y`, `w`, `h`, `shape`, `text`
- `steps`: **document order** -- it is the animation. Within a step: `id`, `duration`, `caption`, `set`. `set` keys sorted alphabetically; each assignment `state` then `tone`.
- Two-space indent, one trailing newline.

Unknown keys are preserved and written after the known ones in sorted order, so a field this build does not model still round-trips.

## Hard constraints

Design around these; they are not bugs to work around.

- **No text changes.** No part's `label`, `text`, `subtitle`, or `rows` can differ between steps. A counter that ticks `36 -> 24 -> 12` is impossible. Show quantity with shapes going `hidden`, and write static captions that stay true for the whole run (`"CLAIMED IN ORDER"`, not `"16 REMAINING"`).
- **No movement.** `x`/`y` are fixed. Parts appear, disappear, and change colour; they do not travel. The only continuous motion in the format is edge packets and the `scene-spin` spinner (see sub-parts). Nothing else rotates, slides, or eases.
- **No font sizes.** Labels are 12px, node titles 13px, rows and subtitles 11px.
- **No z-index.** Alphabetical ids, as above.
- **No per-step easing or delay.** One transition duration (320ms) for everything.

## Making a good one

**Structure**

- **8 to 12 steps.** Fewer feels like a slideshow, more and the viewer loses the thread.
- **600-1200ms per step.** Under 400ms nobody reads the caption; over 1500ms it drags. Give the beat where something *changes meaning* the longest hold.
- **One idea per step.** If a caption needs "and", it is two steps.
- **Total 8-15 seconds.** It loops; it does not need to be a documentary.

**Layout**

- Put it on a grid. Align tops and bottoms across columns. Equal gutters. The format has no auto-layout, so sloppy coordinates read as a sloppy diagram.
- Give it a header (a title label and a caps subtitle) and a bottom rail of caps labels that light in sequence. That rail is cheap and does more for legibility than anything else: it tells the viewer where they are in a process they have not seen before.
- Group with proximity, not boxes. Two columns 70px apart with a caps heading over each beat any amount of nesting.
- Flow left to right, or top to bottom. Pick one.

**Motion**

- **Turn things off.** The single most common failure is an animation where every part is lit by the end, so the final frame is noise. Set edges back to `idle` once their traffic is done.
- **Land on a resolution.** The last step should look settled -- one tone, everything quiet - not mid-flight.
- **Animate the interesting part.** The beat worth the viewer's attention is almost never the happy path. It is the retry, the cache miss, the review that sends the work back. Use `waiting` and `returning` for it. An explainer that only shows success explains nothing.
- Do not light every part in step 1. Start quiet and let the scene fill in; that is most of the perceived quality.

**Colour**

- Two working tones plus grey carries most animations. Reach for a third only when it means a genuinely different thing.
- Let `neutral`/`muted` do real work. Contrast comes from what is *dim*.

## Workflow

1. **Sketch the steps first, in prose.** Write the captions before you place a single coordinate. If the captions do not read as a paragraph, the animation will not read either.
2. **Place the scene on a grid.** Nodes and their coordinates, then labels, then edges last -- edges are constrained by where the boxes ended up.
3. **Write the steps as deltas**, in canonical order.
4. **Write the file and validate it.** Name it in kebab-case with the `.scene.json` extension. Run `bb animation validate <path>` or `animation_validate`. Then tell the user to open the file in BB's Animation editor so they can scrub it.
5. **Iterate on geometry from what you wrote**: node height vs row count, edge gaps vs edge `text`, cumulative states that never turn off, a final frame with too much lit at once.

If the user gave you a style reference image, match its *vocabulary* -- caps micro-labels, card density, how much is dim at rest - rather than trying to reproduce it pixel for pixel. Say plainly which parts of it the format cannot express.

## Exporting

`animation_export_html` (or `bb animation export <path>`) writes a `.scene.json` out as a self-contained HTML file that plays and loops on its own, with no external references. Point it at a path; it does not need the file open in an editor.

```
animation_export_html { filePath: "docs/cache.scene.json" }
-> docs/cache.html
```

Pass `outputPath` to put it somewhere else. It refuses to export a document with parse errors, and returns any warnings alongside the result. Clicking the exported page pauses it.

**There is no GIF or MP4 export in this BB plugin.** If the destination cannot run HTML, say so and offer the standalone HTML anyway, or a screenshot of one step. Do not pretend a GIF tool exists.

The editor preview and the HTML export use the palette in `stage.theme`, or a fixed dark fallback when the document names none. They agree by construction.

### Showing it live inside BB

Open the `.scene.json` file in BB to play it in the Animation editor.

To embed a live preview in an assistant message, emit this directive on its own line (not in a code fence):

```
::scene{file="docs/cache.scene.json"}
```

`file` is workspace-relative. Optional `height` is pixels from 160 to 900. After `Write`/`Edit` creates the file, emit the directive so the user sees it play in the thread.

### Why frames cannot be stamped

Worth knowing, because it rules out the obvious shortcut: interpolation is CSS transitions and the packets are CSS animations, so writing `data-state` into a series of snapshots and stitching them gives a stepped slideshow with motionless packets. Any frame-based output has to drive a real browser through real playback. Do not build a frame stitcher.

## Common mistakes

| Symptom | Cause |
| --- | --- |
| An edge is invisible | `from`/`to` names a part that does not exist. Dangling edges render as nothing. |
| A row is missing from a node | `h` is too small. `h = 32 × rows + 80` with a subtitle. |
| A state does nothing | Typo. Unknown state strings parse fine and render as `idle`. |
| An edge label sits on top of a card | The gap is narrower than the label plate. Widen the gap or drop the `text`. |
| A part is hidden behind another | Alphabetical draw order. Rename it to sort later. |
| Something stays lit forever | Cumulative states. You never set it back to `idle`. |
| The whole file reformats on first save | It was not written in canonical order. |
| A line crosses a card | The two boxes are not adjacent. Move them, do not fight the router. |

## Worked example

A complete, canonical, three-part file. Copy it and grow it.

```json
{
  "version": 1,
  "stage": {
    "width": 1080,
    "height": 420,
    "fps": 25
  },
  "parts": {
    "caption": {
      "type": "label",
      "x": 80,
      "y": 48,
      "text": "READ THROUGH CACHE",
      "caps": true
    },
    "cache": {
      "type": "node",
      "label": "Cache",
      "x": 420,
      "y": 130,
      "w": 240,
      "h": 176,
      "subtitle": "LRU / 512 MB",
      "rows": [
        { "key": "hit", "value": "0.4 ms" },
        { "key": "miss", "value": "18 ms" },
        { "key": "keys", "value": "12.4 K" }
      ]
    },
    "client": {
      "type": "node",
      "label": "Client",
      "x": 80,
      "y": 130,
      "w": 220,
      "h": 176,
      "subtitle": "GET /user/42",
      "rows": [
        { "key": "attempt", "value": "1" },
        { "key": "budget", "value": "50 ms" },
        { "key": "result" }
      ]
    },
    "fetch": {
      "type": "edge",
      "from": "client",
      "to": "cache",
      "text": "get",
      "packets": 3
    },
    "load": {
      "type": "edge",
      "from": "cache",
      "to": "origin",
      "packets": 3
    },
    "origin": {
      "type": "node",
      "label": "Origin",
      "x": 780,
      "y": 130,
      "w": 220,
      "h": 176,
      "subtitle": "POSTGRES",
      "rows": [
        { "key": "rows", "value": "1" },
        { "key": "cost", "value": "18 ms" },
        { "key": "load", "value": "moderate" }
      ]
    }
  },
  "steps": [
    {
      "id": "ask",
      "duration": 800,
      "caption": "The client asks the cache for a key.",
      "set": {
        "client": { "state": "active", "tone": "accent" },
        "fetch": { "state": "flowing", "tone": "accent" }
      }
    },
    {
      "id": "miss",
      "duration": 900,
      "caption": "It is not there, so the client waits.",
      "set": {
        "cache": { "state": "active", "tone": "warning" },
        "client": { "state": "waiting", "tone": "warning" },
        "fetch": { "state": "idle" }
      }
    },
    {
      "id": "load",
      "duration": 1100,
      "caption": "The cache reads through to the origin.",
      "set": {
        "load": { "state": "flowing", "tone": "data" },
        "origin": { "state": "active", "tone": "data" }
      }
    },
    {
      "id": "fill",
      "duration": 900,
      "caption": "The row comes back and the entry is filled.",
      "set": {
        "cache": { "state": "active", "tone": "success" },
        "load": { "state": "returning", "tone": "success" }
      }
    },
    {
      "id": "serve",
      "duration": 1000,
      "caption": "The client gets its answer; the next read will hit.",
      "set": {
        "client": { "state": "active", "tone": "success" },
        "fetch": { "state": "returning", "tone": "success" },
        "load": { "state": "idle" },
        "origin": { "state": "idle", "tone": "neutral" }
      }
    }
  ]
}
```

Note what it does: starts quiet, holds longest on the beat that costs 18ms, uses `waiting` for the stall and `returning` for both replies, sets `fetch` and `load` back to `idle` once they are done, and ends on one tone with the origin dimmed back out.

A longer cache-aside sample ships with the plugin at `samples/demo.scene.json`.
