---
name: animation
description: Author step-based explainer diagrams as .scene.json files for BB's Animation plugin. Use when the user wants to animate a diagram, show how a system/protocol/algorithm behaves over time, build a motion explainer, export animation HTML, or turn a static architecture diagram into something that plays.
---

# Animation - step-based explainer diagrams

`.scene.json` files open in BB's Animation editor: a named scene plus an ordered list of steps that assign states to the scene's parts. You write plain JSON. Any agent can author or edit one with `Write` and `Edit` -- there is no binary format and no tool call required to author. Existing `.anim.json` files, `::animation` embeds, and Nimbalyst `anim-subpart` / `anim-spin` / `--anim-*` tokens still work. Write `.scene.json`, `::scene`, `scene-subpart`, `scene-spin`, and `--scene-*`.

BB surfaces:

- Open `*.scene.json` in the file preview (Animation editor).
- `bb animation new|validate|export` from a thread workspace.
- Native tools `animation_export_html` and `animation_validate`. Validate returns design notes that each name the exact fix.
- Inline chat preview: `::scene{file="docs/flow.scene.json"}`. Attributes are separated by a space, never a comma.
- Click a part on the stage to quote its current state into chat.

## When to use this

- Explaining how a system behaves **over time**: a request crossing a network, a consensus round, a cache filling, a build pipeline, a queue draining.
- Turning a static architecture diagram into something that plays.
- Showing a failure and a recovery: the retry, the rollback, the rejected review.

**Do not use it** when a static diagram says the same thing. If nothing changes between the first frame and the last, you want a Mermaid block or a still drawing, not an animation.

## The recipe

Follow these eight steps in order. They produce a good animation without any design judgement, and the validator in step 8 catches what you cannot see.

1. **Write the story as 6 to 10 captions.** One sentence each, 10 words or fewer (12 is the limit). Read together, they explain the thing to someone who has never seen it. Captions are shown under the stage as narration, so they are the script. **If the user asked for a length, write one caption per 2.5 seconds**: 12 captions for 30 seconds.
2. **Pick 3 to 6 boxes.** One `node` per actor in the story. More than 6 means the story is two animations. Give each box one or two rows of **fixed facts**: a name, a limit, a setting. Never a status such as `pending`, `verified` or `done`: text cannot change between steps, so a status is wrong for most of the run. Show change with states, not with text.
3. **Place them on the grid** in the table below. Do not invent coordinates.
4. **Hide what arrives later.** Every part the first caption does not need gets `"state": "hidden"`. Reveal it with `"state": "idle"` or `"active"` in the step whose caption introduces it. Hidden parts rise into place when shown. Edges need no hiding: an edge appears in the step that first lights it, and stays afterwards as a trace of the conversation.
5. **Write one step per caption.** Light the one or two parts the caption is about, and **set an edge `"flowing"` whenever something passes between two boxes**: the moving packets are what make it an animation. When an edge flows into a box, set that box `"active"` in the same step, so the arrival shows. Any two boxes can be joined, not only neighbours. Switch off what the previous step lit: set its edges back to `"idle"`. **Every step must change something the viewer can see**; a step that only changes the caption is dead air, so merge it into its neighbour. Take `duration` from the table below.
6. **Add `focus`** to steps that are about one or two boxes: `"focus": ["queue", "worker"]`. The stage zooms to them. If the step lights an edge, name the boxes at both ends of it. Leave `focus` off the first step, any step that reveals parts, and the last step.
7. **End calm.** In the last step every edge is `"idle"`, the box that holds the result stays `"active"`, and there is no `focus`.
8. **Validate, fix, repeat.** Run `animation_validate` (or `bb animation validate <path>`). If the user asked for a length, pass it as `targetSeconds` (`--seconds` on the CLI). Apply every design note exactly as written, then validate again. **Never delete an edge or a box to clear a note**: that deletes part of the story. Stop when it says `design notes: none`. Then put the `::scene` line it gives you in your reply.

**Layout grid** for a `1200` by `560` stage, one row of boxes:

| What | Where |
| --- | --- |
| Title `label` with `"size": "title"` | `x: 60, y: 56` |
| Tagline `label` with `caps: true` | `x: 60, y: 84` |
| 2 nodes | `y: 190`, `w: 220`, at `x: 250`, `730`. Edge `text` up to 31 characters |
| 3 nodes | `y: 190`, `w: 220`, at `x: 60`, `490`, `920`. Edge `text` up to 24 characters |
| 4 nodes | `y: 190`, `w: 195`, at `x: 60`, `355`, `650`, `945`. Edge `text` up to 10 characters |
| Node height | `144` for a subtitle and 2 rows. In general `32 × rows + 80` with a subtitle, `32 × rows + 64` without |
| Progress rail, 5 caps labels | `y: 470`, at `x: 60`, `290`, `520`, `750`, `980` |
| Edges | Between any two boxes. Give every edge a short `text` saying what is sent. Neighbours get a straight line, so the text must fit the gap (limits above). An edge that skips a box arcs over the row, and its `text` can be longer |

For 5 to 8 boxes use a `1200` by `700` stage with two rows: nodes at `y: 150` and `y: 370`, rail at `y: 620`. Each row uses the `x` positions above for the number of boxes in it.

**Step duration** from the caption's word count (`400 + 260 × words`, rounded up):

| Words | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `duration` | 1500 | 1700 | 2000 | 2300 | 2500 | 2800 | 3000 |

The worked example at the end of this file follows this recipe exactly. Copy it and change the story.

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
| `background` | Optional override. Omit it and the stage uses `stage.theme.bg`, or the fixed dark fallback palette when there is no theme -- usually what you want. |

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

- `from`/`to` are part ids, and the route is worked out for you. Neighbours get a straight line between their facing sides. An edge that would cross another box arcs round it: over the row going forwards, under it coming back. Two edges between the same pair, such as a request and its reply, run in parallel lanes.
- **A dangling `from`/`to` renders nothing at all** -- it looks like a broken renderer, not a broken document. Check your ids.
- An edge is hidden while either of its ends is `hidden`, and comes back in its own state when both are shown. You do not hide edges yourself.
- An edge that a step lights is not drawn until that step, so the lines appear as the story uses them. To show an edge from the start, give the part `"state": "idle"`. An edge that no step ever lights is a fixed relationship and is always drawn.
- `packets` is how many squares travel the line while it is flowing (default 3). Set `0` for an edge that means a *relationship* rather than traffic. One trip takes 1.6s.
- `text` draws a caption at the midpoint **on an opaque background plate** roughly `max(40, len × 7.6 + 16)` px wide. It will punch a hole through anything behind it. Only put `text` on an edge whose gap is wider than the plate.

**`label`** -- free-standing text.

```json
{ "type": "label", "x": 56, "y": 48, "text": "COMMIT DAG", "align": "start", "caps": true }
```

- `align`: `start` | `middle` | `end` (the anchor, at `x`).
- `caps: true` gives the faint, tracked-out micro-caption style used for section headings.
- `"size": "title"` draws the label as the scene's heading: 24px, bold. Use it once, for the title. Every other label is 12px, so build the rest of the hierarchy with `caps`, tone, and position.

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

- **`htmlFile`** is a path to a `.html` file next to the document. Relative only, and absolute is refused. `..` is allowed as long as the file stays inside the workspace (outside a workspace: the directory the CLI ran in, or the scene's own folder).
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

They map to stage tokens (from `stage.theme`, or the fixed dark fallback): accent is blue, data purple, success green, warning amber, error red, neutral/muted a faint grey. **Assign them semantically and keep the meaning fixed for the whole animation** -- if amber means "under review" in step 4 it cannot mean "slow" in step 7.

### states

The state vocabulary is defined by the stylesheet, not the schema. Any other string parses fine and renders as `idle`, so a typo fails silently.

| Type | States |
| --- | --- |
| `node` | `idle` (default), `active` (tinted fill, tone border, status dot, first row highlighted), `waiting` (dashed amber border), `offline` (dashed red border, dimmed title), `hidden` |
| `edge` | `idle` (default, dashed grey), `flowing` (line fills in, packets travel from -> to), `returning` (same, packets travel **backwards**), `active` (same as flowing), `hidden` |
| `label` | `idle` (default), `active` (takes its tone colour), `hidden` |
| `shape` | `idle` (default, 14% tone fill), `active` (65% tone fill, reads as solid), `hidden` |

`returning` is the most useful state in the set and the most under-used: a reply, a rejection, a rollback travelling back down the same wire. Use it when the reply is the same conversation. When the reply is its own message with its own name, draw a second edge the other way; the two run in separate lanes.

### steps

```json
{ "id": "response", "duration": 2500,
  "caption": "The objects come back down the same wire.",
  "focus": ["client", "store"],
  "set": { "fetch": { "state": "returning", "tone": "success" } } }
```

- `id` is a readable slug, unique. It shows in the step strip.
- `duration` is how long this step **holds** before the next begins, in ms (1..600000; the editor's drag-to-retime floor is 40ms). It has to be long enough to read the caption: `400 + 260 × words`.
- `caption` is one sentence of narration, shown under the stage in the editor, the chat embed and the export. Read end to end, the captions should form a coherent paragraph -- they are also the animation's accessibility description.
- `focus` is a part id, or a list of them, that the stage zooms to for this step. It frames those parts with some air, up to 2.4×, and glides there from the previous framing. **Focus is not cumulative**: it applies to its own step only, and a step without it shows the whole stage. Naming an edge frames both its ends. When a focused step lights an edge, include the boxes at both ends, or the traffic appears to come from nowhere.
- `set` maps part id -> `{ state?, tone? }`. Omit either and it inherits.

Playback **loops by default**, and the wrap is a hard cut: the stage jumps from your last step straight to the baseline-plus-first-step. Design that cut deliberately -- it should read as a reset, not as a glitch.

## Geometry

Layout is hand-placed, so these numbers matter.

**Node internals.** Header is 34px. The subtitle baseline sits at `y+56`. Rows start at `y+72` (or `y+56` with no subtitle), each row 26px tall with a 6px gap -- 32px of pitch. A row is dropped if it would come within 6px of the bottom.

> **Node height:** `h = 32 × rows + 80` with a subtitle, `h = 32 × rows + 64` without.
> Three rows plus a subtitle -> `h = 176`. Going much taller leaves a visible dead band under the last row.

Row text is 11px mono: key at `x+28`, value right-aligned at `x + w − 28`. At `w = 228` you have room for roughly a 6-character key and a 12-character value.

**Edges.** Join whichever boxes the story needs. Neighbours are joined by a straight line. An edge between boxes that are not neighbours arcs round the ones in between, over the row when it runs left to right and under it when it runs right to left, so leave about 140 of clear space above and below a row of boxes. The recipe's grid does.

Leave the gap wide enough for what the edge carries: ~40px for a bare edge with packets, ~70px if it has `text`.

**Layering.** Edges draw first (behind everything), then all other parts **in alphabetical id order**. That is the only layering control there is. To draw a part on top of another, give it an id that sorts later: `queue` (the panel) then `queueTask01`..`queueTask12` (the chiclets inside it).

## Canonical form

The editor rewrites the file on save with a fixed key order. **Hand-write it in canonical order or your first save will reformat the whole file and bury the real edit in the diff.**

- Root: `version`, `stage`, `parts`, `steps`
- `stage`: `width`, `height`, `fps`, `background`
- `parts`: **sorted alphabetically by id**. Within a part: `type`, `label`, `tone`, `state`, then
  - node: `x`, `y`, `w`, `h`, `subtitle`, `rows`
  - edge: `from`, `to`, `text`, `packets`
  - label: `x`, `y`, `text`, `align`, `caps`, `size`
  - shape: `x`, `y`, `w`, `h`, `shape`, `text`
- `steps`: **document order** -- it is the animation. Within a step: `id`, `duration`, `caption`, `focus`, `set`. `set` keys sorted alphabetically; each assignment `state` then `tone`.
- Two-space indent, one trailing newline.

Unknown keys are preserved and written after the known ones in sorted order, so a field this build does not model still round-trips.

## Hard constraints

Design around these; they are not bugs to work around.

- **No text changes.** No part's `label`, `text`, `subtitle`, or `rows` can differ between steps. A counter that ticks `36 -> 24 -> 12` is impossible. Show quantity with shapes going `hidden`, and write static captions that stay true for the whole run (`"CLAIMED IN ORDER"`, not `"16 REMAINING"`).
- **Parts do not travel.** `x`/`y` are fixed, so nothing moves from one place to another. The motion you get is built in, and you do not script it: a part rises into place when it stops being `hidden`, parts changed by the same step start a beat apart from left to right, a lit node glows, packets run along a flowing edge, and the camera glides to each step's `focus`.
- **No font sizes**, apart from one heading: a label with `"size": "title"` is 24px. Other labels are 12px, node titles 13px, rows and subtitles 11px.
- **No z-index.** Alphabetical ids, as above.
- **No per-step easing or delay.** Timings are fixed: 320ms for a colour change, 460ms for a part to arrive, 720ms for a camera move.

## Making a good one

**Structure**

- **6 to 10 steps.** Fewer feels like a slideshow, more and the viewer loses the thread. A 30-second piece is about 12.
- **2 to 3 seconds per step.** The caption sets it: `400 + 260 × words` milliseconds. A step held for one second is never read, which is the most common reason an animation is hard to follow.
- **Captions of 10 words or fewer.** Short captions are what keep the whole thing brisk. To go faster, cut words, not durations.
- **One idea per step.** If a caption needs "and", it is two steps.
- **Total 15 to 30 seconds.** It loops; it does not need to be a documentary.

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
- **Reveal, do not just recolour.** A scene where every box is on screen from the first frame is a wiring diagram. Start the later parts `hidden` and bring each in when the story reaches it.
- **Move the camera.** `focus` on the one or two boxes a step is about makes them big enough to read, and the glide between framings is the strongest motion the format has. Alternate: whole stage to establish, focus for the detail, whole stage to finish.

**Colour**

- Two working tones plus grey carries most animations. Reach for a third only when it means a genuinely different thing.
- Let `neutral`/`muted` do real work. Contrast comes from what is *dim*.

## Workflow

1. **Sketch the steps first, in prose.** Write the captions before you place a single coordinate. If the captions do not read as a paragraph, the animation will not read either.
2. **Place the scene on a grid.** Nodes and their coordinates, then labels, then edges last -- edges are constrained by where the boxes ended up.
3. **Write the steps as deltas**, in canonical order.
4. **Write the file and validate it.** Name it in kebab-case with the `.scene.json` extension. Run `bb animation validate <path>` or `animation_validate`.
5. **Apply the design notes, then validate again.** You cannot see the result, so the validator looks for you: rows that do not fit, boxes that overlap, text too wide for its box, an edge through a card, a state that is a typo, captions shown too briefly, nothing revealed over time, an ending that is still busy. Each note gives the exact value to set. Keep going until it reports `design notes: none`.
6. **Show it.** Put the `::scene` line from the validator in your reply, and tell the user they can open the file in BB's Animation editor to scrub it.

If the user gave you a style reference image, match its *vocabulary* -- caps micro-labels, card density, how much is dim at rest - rather than trying to reproduce it pixel for pixel. Say plainly which parts of it the format cannot express.

## Exporting

`animation_export_html` (or `bb animation export <path>`) writes a `.scene.json` out as a self-contained HTML file that plays and loops on its own, with no external references. Point it at a path; it does not need the file open in an editor.

```
animation_export_html { filePath: "docs/cache.scene.json" }
-> docs/cache.html
```

Pass `outputPath` to put it somewhere else; a relative path resolves the same way as `filePath`. It refuses to export a document with parse errors, and returns any warnings alongside the result. It only overwrites an earlier Animation export: if another file already sits at the output path, including the scene itself, it stops with an error, so pick a different `outputPath` rather than deleting the user's file. The exported page shows each step's caption under the stage and a progress line along the bottom. Clicking it pauses it.

**There is no GIF or MP4 export in this BB plugin.** If the destination cannot run HTML, say so and offer the standalone HTML anyway, or a screenshot of one step. Do not pretend a GIF tool exists.

The editor preview and the HTML export use the palette in `stage.theme`, or a fixed dark fallback when the document names none. They agree by construction.

### Showing it live inside BB

Open the `.scene.json` file in BB to play it in the Animation editor.

To embed a live preview in an assistant message, emit this directive on its own line (not in a code fence):

```
::scene{file="docs/cache.scene.json"}
```

`file` is workspace-relative. Optional `height` is pixels from 160 to 900, and goes after a **space**:

```
::scene{file="docs/cache.scene.json" height=480}
```

**Never put a comma between the attributes.** With a comma, BB does not read the line as a directive and shows it as plain text instead of the animation. `animation_validate` returns the exact line for a file, so copy that rather than composing it.

After `Write`/`Edit` creates the file, emit the directive so the user sees it play in the thread.

### Why frames cannot be stamped

Worth knowing, because it rules out the obvious shortcut: interpolation is CSS transitions and the packets are CSS animations, so writing `data-state` into a series of snapshots and stitching them gives a stepped slideshow with motionless packets. Any frame-based output has to drive a real browser through real playback. Do not build a frame stitcher.

## Common mistakes

The validator reports every row marked ✓ below as a design note with the fix worked out. Run it rather than checking these by hand.

| Symptom | Cause |
| --- | --- |
| Nobody can follow it ✓ | Captions are held for about a second. Use `400 + 260 × words`. |
| It looks like a static diagram ✓ | Every part is visible from the start and the camera never moves. Hide later parts and add `focus`. |
| An edge is invisible ✓ | `from`/`to` names a part that does not exist. Dangling edges render as nothing. |
| A row is missing from a node ✓ | `h` is too small. `h = 32 × rows + 80` with a subtitle. |
| A state does nothing ✓ | Typo. Unknown state strings parse fine and render as `idle`. |
| An edge label sits on top of a card ✓ | The gap is narrower than the label plate. Widen the gap or drop the `text`. |
| A part is hidden behind another | Alphabetical draw order. Rename it to sort later. |
| Something stays lit forever ✓ | Cumulative states. You never set it back to `idle`. |
| The whole file reformats on first save | It was not written in canonical order. |
| A line crosses a card ✓ | Rare: edges arc round boxes on their own. It only happens when there is no clear space above or below the row. |
| A box says something untrue ✓ | A row holds a status such as `verified`. Rows never change, so use fixed facts. |
| It ends on nothing ✓ | The last step switched every box off. Keep the result lit. |
| Traffic arrives and nothing happens ✓ | An edge flows into a box that stays grey. Set the box `"active"` in the same step. |
| The picture stands still ✓ | A step changes nothing, or only changes things outside the zoomed frame. Light something in frame or merge the step. |
| It is the wrong length ✓ | Pass `targetSeconds` to the validator and add or merge steps. |

## Worked example

A complete, canonical file that follows the recipe: a job queue that retries a failed job. It validates with `design notes: none`. Copy it, keep the grid, and change the story.

```json
{
  "version": 1,
  "stage": {
    "width": 1200,
    "height": 560,
    "fps": 25
  },
  "parts": {
    "claim": {
      "type": "edge",
      "from": "queue",
      "to": "worker",
      "text": "claim",
      "packets": 3
    },
    "enqueue": {
      "type": "edge",
      "from": "producer",
      "to": "queue",
      "text": "push",
      "packets": 3
    },
    "producer": {
      "type": "node",
      "label": "Producer",
      "x": 60,
      "y": 190,
      "w": 195,
      "h": 144,
      "subtitle": "ORDERS API",
      "rows": [
        {
          "key": "job",
          "value": "resize #4182"
        },
        {
          "key": "queue",
          "value": "thumbnails"
        }
      ]
    },
    "queue": {
      "type": "node",
      "label": "Queue",
      "x": 355,
      "y": 190,
      "w": 195,
      "h": 144,
      "subtitle": "FIFO / AT LEAST ONCE",
      "rows": [
        {
          "key": "visibility",
          "value": "30 s"
        },
        {
          "key": "max tries",
          "value": "3"
        }
      ]
    },
    "railClaim": {
      "type": "label",
      "x": 290,
      "y": 470,
      "text": "02 CLAIM",
      "caps": true
    },
    "railDone": {
      "type": "label",
      "x": 980,
      "y": 470,
      "text": "05 DONE",
      "caps": true
    },
    "railEnqueue": {
      "type": "label",
      "x": 60,
      "y": 470,
      "text": "01 ENQUEUE",
      "caps": true
    },
    "railFail": {
      "type": "label",
      "x": 520,
      "y": 470,
      "text": "03 FAIL",
      "caps": true
    },
    "railRetry": {
      "type": "label",
      "x": 750,
      "y": 470,
      "text": "04 RETRY",
      "caps": true
    },
    "store": {
      "type": "node",
      "label": "Store",
      "state": "hidden",
      "x": 945,
      "y": 190,
      "w": 195,
      "h": 144,
      "subtitle": "OBJECT STORAGE",
      "rows": [
        {
          "key": "bucket",
          "value": "thumbs"
        },
        {
          "key": "writes",
          "value": "idempotent"
        }
      ]
    },
    "tagline": {
      "type": "label",
      "x": 60,
      "y": 84,
      "text": "A FAILED JOB IS RETRIED, NEVER LOST",
      "caps": true
    },
    "title": {
      "type": "label",
      "x": 60,
      "y": 56,
      "text": "Job queue with retry",
      "size": "title"
    },
    "worker": {
      "type": "node",
      "label": "Worker",
      "state": "hidden",
      "x": 650,
      "y": 190,
      "w": 195,
      "h": 144,
      "subtitle": "CONSUMER",
      "rows": [
        {
          "key": "concurrency",
          "value": "1"
        },
        {
          "key": "timeout",
          "value": "30 s"
        }
      ]
    },
    "write": {
      "type": "edge",
      "from": "worker",
      "to": "store",
      "text": "write",
      "packets": 3
    }
  },
  "steps": [
    {
      "id": "job",
      "duration": 2500,
      "caption": "A producer has a job to hand off.",
      "set": {
        "producer": {
          "state": "active",
          "tone": "accent"
        },
        "railEnqueue": {
          "state": "active",
          "tone": "accent"
        }
      }
    },
    {
      "id": "enqueue",
      "duration": 2300,
      "caption": "It pushes the job onto the queue.",
      "focus": [
        "producer",
        "queue"
      ],
      "set": {
        "enqueue": {
          "state": "flowing",
          "tone": "accent"
        },
        "queue": {
          "state": "active",
          "tone": "accent"
        }
      }
    },
    {
      "id": "worker",
      "duration": 2800,
      "caption": "A worker comes online with a store behind it.",
      "set": {
        "enqueue": {
          "state": "idle"
        },
        "producer": {
          "state": "idle"
        },
        "store": {
          "state": "idle"
        },
        "worker": {
          "state": "idle"
        }
      }
    },
    {
      "id": "claim",
      "duration": 1700,
      "caption": "The worker claims the job.",
      "focus": [
        "queue",
        "worker"
      ],
      "set": {
        "claim": {
          "state": "flowing",
          "tone": "accent"
        },
        "railClaim": {
          "state": "active",
          "tone": "accent"
        },
        "railEnqueue": {
          "state": "idle",
          "tone": "neutral"
        },
        "worker": {
          "state": "active",
          "tone": "accent"
        }
      }
    },
    {
      "id": "fail",
      "duration": 2800,
      "caption": "The write fails, so the job is never acknowledged.",
      "focus": [
        "worker",
        "store"
      ],
      "set": {
        "claim": {
          "state": "idle"
        },
        "railClaim": {
          "state": "idle",
          "tone": "neutral"
        },
        "railFail": {
          "state": "active",
          "tone": "error"
        },
        "store": {
          "state": "offline"
        },
        "worker": {
          "state": "waiting"
        },
        "write": {
          "state": "flowing",
          "tone": "error"
        }
      }
    },
    {
      "id": "retry",
      "duration": 2000,
      "caption": "The job returns to the queue.",
      "focus": [
        "queue",
        "worker"
      ],
      "set": {
        "claim": {
          "state": "returning",
          "tone": "warning"
        },
        "queue": {
          "state": "waiting",
          "tone": "warning"
        },
        "railFail": {
          "state": "idle",
          "tone": "neutral"
        },
        "railRetry": {
          "state": "active",
          "tone": "warning"
        },
        "worker": {
          "state": "idle"
        },
        "write": {
          "state": "idle"
        }
      }
    },
    {
      "id": "again",
      "duration": 2800,
      "caption": "The worker claims it again and the write lands.",
      "focus": [
        "queue",
        "worker",
        "store"
      ],
      "set": {
        "claim": {
          "state": "flowing",
          "tone": "accent"
        },
        "queue": {
          "state": "idle",
          "tone": "neutral"
        },
        "store": {
          "state": "active",
          "tone": "success"
        },
        "worker": {
          "state": "active",
          "tone": "accent"
        },
        "write": {
          "state": "flowing",
          "tone": "success"
        }
      }
    },
    {
      "id": "done",
      "duration": 2300,
      "caption": "Every job is processed at least once.",
      "set": {
        "claim": {
          "state": "idle"
        },
        "railDone": {
          "state": "active",
          "tone": "success"
        },
        "railRetry": {
          "state": "idle",
          "tone": "neutral"
        },
        "worker": {
          "state": "idle"
        },
        "write": {
          "state": "idle"
        }
      }
    }
  ]
}
```

What it does, step by step:

- **Starts with two boxes.** `worker` and `store` begin `hidden`, and rise in at the `worker` step, a beat apart from left to right. Their edges appear with them.
- **Narrates every step** in 9 words or fewer, with each `duration` taken from the word count.
- **Zooms to the beat.** `enqueue`, `claim`, `fail`, `retry` and `again` each `focus` on the boxes involved. `job`, `worker` and `done` show the whole stage, so the viewer sees where they are before and after.
- **Shows the failure**, which is the point of the story: `offline` for the store, `waiting` for the worker, then `returning` to send the job back down the same edge.
- **Switches things off.** Each step sets the previous step's edge back to `idle`, and the rail label moves along.
- **Ends calm**: every edge idle, one node lit, whole stage.

The same file ships with the plugin at `samples/retry.scene.json`. A shorter three-box scene is at `samples/demo.scene.json`.
