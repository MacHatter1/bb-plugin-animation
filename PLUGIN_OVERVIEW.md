Play technical diagrams as a sequence of beats, not a keyframe dope sheet.

## What you get

- An **Animation editor** for `*.scene.json` files: stage on top, step strip below.
- Scrub the playhead, drag a step boundary to retime it, and click a part to quote it into chat.
- Motion without scripting: parts rise in when revealed, changes sweep left to right, and a step's `focus` zooms the stage to the boxes it is about.
- Captions shown as narration in the editor, the chat embed and the export.
- Design notes from `animation_validate`, each with the exact fix, so an agent that cannot see the scene can still get it right.
- A starter file from the thread panel, the command palette, or `bb animation new`.
- HTML export from the editor, `bb animation export`, or `animation_export_html`.
- An inline chat preview: `::scene{file="docs/flow.scene.json"}`, or with a height: `::scene{file="docs/flow.scene.json" height=480}`.
- A Settings page that explains how to create, open, and export scenes.

## How it works

An animation is plain JSON: named parts plus an ordered list of steps. Each step says what is true at that beat — the cache is waiting, this edge is flowing — and CSS interpolates between them. Agents edit the file with ordinary writes; the editor saves the same canonical form.

The format is compatible with Nimbalyst Animation documents. Existing `.anim.json` files, `::animation` embeds, and `anim-*` / `--anim-*` tokens still work; new files use `.scene.json`, `::scene`, and `--scene-*`. GIF and MP4 recording are not included; HTML export is the shareable output.

## For agents

The bundled skill gives an eight-step recipe, a layout grid and a worked example to copy, then covers part types, states, geometry and canonical key order. Run `bb animation validate` or `animation_validate` after every edit and apply its design notes until there are none.
