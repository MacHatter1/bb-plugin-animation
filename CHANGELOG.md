# Changelog

All notable changes to Animation are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- README logo, changelog and `.gitattributes`, following the house layout for
  BB plugin repos.

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
