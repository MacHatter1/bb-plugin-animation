# Changelog

All notable changes to Animation are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- README logo, changelog and `.gitattributes`, following the house layout for
  BB plugin repos.

### Fixed

- Workspace and thread-storage paths that climb out with `..` are refused.
  **New animation** checks its path too, and POSIX paths now compare case
  sensitively.
- The editor no longer loses an edit made while a save is in flight, and two
  overlapping saves no longer conflict with each other.
- A change on disk is no longer loaded mid-drag, or over an edit made while
  the read was in flight, so it can no longer be silently reverted.
- Undo after **Reload** no longer restores the version from before the reload.
- After a conflict, **Keep mine** overwrites the version on disk. Before, the
  only way out was **Reload**, which discarded your changes.
- **Export HTML** stops if the save before it fails, instead of exporting the
  stale file and reporting success.
- Theme values, vars and sub-parts the parser cannot use are kept on save,
  where they were written, instead of being deleted. A `stage` that is not an
  object now blocks saving.
- The HTML sanitiser checks inline styles after character references decode,
  and refuses CSS escapes and `image-set()`-style functions that fetch. Theme
  colours refuse those functions too.
- A `{{constructor}}` placeholder no longer crashes the renderer.
- Export only overwrites an earlier Animation export. It refuses any other file
  at the output path, including the scene itself. The editor, CLI and agent
  tool now share one export path.
- `htmlFile` paths using `..` resolve within the workspace for host files, and
  within the directory the CLI ran in outside a workspace.
- Chat embeds no longer re-read the file on every render. They show parse
  errors and failed reads instead of a blank stage or endless loading, and
  update once per step (paused off-screen) instead of on every frame.
- Keyboard shortcuts keep working after you click the stage or a transport
  button.
- A cancelled touch or pen drag no longer saves a new step time.
- The editor fits narrow panels. Before, its widest row stretched the layout
  and pushed **Reload**, **Keep mine** and **Export HTML** off-screen.

### Changed

- The README now covers install, surfaces, CLI, agent tools, safety and
  development in the house layout.
- `package.json` has a top-level `description`, and the licence names
  MacHatter1 alongside the Nimbalyst notice.

## 0.1.0 - 2026-09-16

### Added

- Animation editor for `*.scene.json` files: stage on top, step strip below,
  with play, scrub, drag-to-retime, undo and redo.
- `.anim.json` documents from Nimbalyst Animation open in the same editor.
- Click a part on the stage to quote its current state into chat.
- HTML export to one self-contained page that loops, from the editor,
  `bb animation export`, or the `animation_export_html` agent tool.
- `bb animation new`, `validate` and `export`, each with `--json`.
- `animation_validate` agent tool and a bundled `animation` skill.
- Inline chat preview with `::scene{file="…"}` (`::animation` still works).
- New animation panel in a thread's Actions, a command palette action and a
  composer **Embed scene** item.
- A Using Animation page under BB Settings.
