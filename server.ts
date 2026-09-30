import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type FileSource } from "./contract";
import { parseDocument } from "./src/core/parse";
import { lintDocument, type Advice } from "./src/core/lint";
import { htmlFileRefs } from "./src/core/htmlParts";
import { totalDuration } from "./src/core/timeline";
import {
  buildStandaloneDocument,
  isAnimationExport,
} from "./src/render/standalone";
import { FALLBACK_TOKENS } from "./src/render/stageCss";
import {
  isInsideRoot,
  joinHostPath,
  normalizeHostPath,
  readHostText,
  relativeToRoot,
  readSiblingAssets,
  resolveFileSource,
  resolveInvokingHostPath,
  resolveThreadWorkspace,
  writeHostText,
  type ResolvedFile,
} from "./src/hostFiles";
import {
  DEFAULT_ANIMATION_JSON,
  ensureSceneJsonPath,
  fileNameFromPath,
  sceneDirective,
  siblingExportPath,
  titleFromPath,
} from "./src/template";

export { rpcContract };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonFlag(argv: string[]): boolean {
  return argv.includes("--json");
}

function withoutJson(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--json");
}

function takeOption(argv: string[], name: string): { value?: string; rest: string[] } {
  const index = argv.indexOf(name);
  if (index === -1) return { rest: argv };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    return { rest: argv.filter((_, i) => i !== index) };
  }
  return {
    value,
    rest: argv.filter((_, i) => i !== index && i !== index + 1),
  };
}

async function loadExportable(
  bb: BbPluginApi,
  resolved: ResolvedFile,
): Promise<
  | {
      ok: true;
      content: string;
      sha256: string;
      warnings: string[];
      assets: Record<string, string>;
      doc: ReturnType<typeof parseDocument>["doc"];
    }
  | { ok: false; error: string; problems?: string[] }
> {
  let content: string;
  let sha256: string;
  try {
    const file = await readHostText(bb, resolved);
    content = file.content;
    sha256 = file.sha256;
  } catch (error) {
    return {
      ok: false,
      error: `Could not read ${resolved.absolutePath}: ${describe(error)}`,
    };
  }

  const parsed = parseDocument(content);
  const text = (problem: { path: string; message: string }) =>
    problem.path ? `${problem.path}: ${problem.message}` : problem.message;
  const errors = parsed.problems.filter((problem) => problem.level === "error");
  if (errors.length > 0) {
    return {
      ok: false,
      error: `${resolved.absolutePath} has ${errors.length} parse error(s) and was not exported.`,
      problems: errors.map(text),
    };
  }
  if (parsed.doc.steps.length === 0) {
    return {
      ok: false,
      error: `${resolved.absolutePath} has no steps, so there is nothing to animate.`,
    };
  }

  const assets = await readSiblingAssets(bb, resolved, htmlFileRefs(parsed.doc));
  return {
    ok: true,
    content,
    sha256,
    doc: parsed.doc,
    assets: assets.assets,
    warnings: [
      ...parsed.problems
        .filter((problem) => problem.level === "warning")
        .map(text),
      ...assets.errors,
    ],
  };
}

type ExportOutcome =
  | {
      ok: true;
      outputPath: string;
      bytes: number;
      durationMs: number;
      steps: number;
      parts: number;
      warnings: string[];
    }
  | { ok: false; error: string; problems?: string[] };

function sameHostPath(a: string, b: string): boolean {
  return isInsideRoot(a, b) && isInsideRoot(b, a);
}

/**
 * The one export path. The editor, the CLI and the agent tool differ only in
 * how they turn the user's paths into `source` and `destination`, and each
 * resolves the output path the same way it resolved the input path.
 *
 * Export replaces an earlier export at the destination and nothing else: the
 * scene itself, or any other file already there, is refused rather than
 * overwritten.
 */
async function exportToHtml(
  bb: BbPluginApi,
  source: ResolvedFile,
  destination: ResolvedFile,
): Promise<ExportOutcome> {
  if (sameHostPath(source.absolutePath, destination.absolutePath)) {
    return {
      ok: false,
      error: `${destination.absolutePath} is the scene itself. Choose a different output path.`,
    };
  }
  const loaded = await loadExportable(bb, source);
  if (!loaded.ok) return loaded;

  const existing = await bb.sdk.files
    .read({
      hostId: destination.hostId,
      path: destination.absolutePath,
      rootPath: destination.rootPath,
    })
    .catch(() => null);
  if (
    existing &&
    (existing.contentEncoding === "base64" ||
      !isAnimationExport(existing.content))
  ) {
    return {
      ok: false,
      error: `${destination.absolutePath} already exists and is not an Animation export, so it was left alone. Choose another output path, or delete that file first.`,
    };
  }

  const html = buildStandaloneDocument(loaded.doc, FALLBACK_TOKENS, {
    assets: new Map(Object.entries(loaded.assets)),
    title: titleFromPath(source.absolutePath),
  });
  const saved = await writeHostText(
    bb,
    destination,
    html,
    existing?.sha256 ?? null,
  );
  if (saved.outcome === "conflict") {
    return {
      ok: false,
      error: `Export conflicted at ${destination.absolutePath}. Retry.`,
    };
  }
  return {
    ok: true,
    outputPath: destination.absolutePath,
    bytes: html.length,
    durationMs: totalDuration(loaded.doc),
    steps: loaded.doc.steps.length,
    parts: Object.keys(loaded.doc.parts).length,
    warnings: loaded.warnings,
  };
}

function defaultExportDestination(resolved: ResolvedFile): ResolvedFile {
  return {
    ...resolved,
    absolutePath: siblingExportPath(resolved.absolutePath, ".html"),
  };
}

/**
 * Design notes as lines of text. The heading tells an agent what to do with
 * them, because a list of notes with no instruction tends to be reported to
 * the user rather than acted on.
 */
function adviceLines(advice: Advice[]): string[] {
  if (advice.length === 0) return ["design notes: none"];
  return [
    `design notes (${advice.length}). Apply each fix, then validate again until there are none:`,
    ...advice.map((note) => `  [${note.rule}] ${note.path}: ${note.message}`),
  ];
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    async read_file({ path, source }) {
      try {
        const resolved = await resolveFileSource(bb, source, path);
        const file = await readHostText(bb, resolved);
        return {
          ok: true as const,
          content: file.content,
          sha256: file.sha256,
          fileName: fileNameFromPath(path),
          sizeBytes: file.sizeBytes,
        };
      } catch (error) {
        return { ok: false as const, error: describe(error) };
      }
    },

    async write_file({ path, source, content, expectedSha256 }) {
      try {
        const resolved = await resolveFileSource(bb, source, path);
        const saved = await writeHostText(
          bb,
          resolved,
          content,
          expectedSha256,
        );
        if (saved.outcome === "conflict") {
          return {
            ok: true as const,
            outcome: "conflict" as const,
            currentSha256: saved.currentSha256,
          };
        }
        return {
          ok: true as const,
          outcome: "written" as const,
          sha256: saved.sha256,
        };
      } catch (error) {
        return { ok: false as const, error: describe(error) };
      }
    },

    async read_assets({ path, source, refs }) {
      try {
        const resolved = await resolveFileSource(bb, source, path);
        return await readSiblingAssets(bb, resolved, refs);
      } catch (error) {
        return { assets: {}, errors: [describe(error)] };
      }
    },

    async export_html({ path, source, outputPath }) {
      try {
        const resolved = await resolveFileSource(bb, source, path);
        const destination = outputPath?.trim()
          ? await resolveFileSource(bb, source, outputPath.trim())
          : defaultExportDestination(resolved);
        return await exportToHtml(bb, resolved, destination);
      } catch (error) {
        return { ok: false as const, error: describe(error) };
      }
    },

    async create_file({ threadId, relativePath }) {
      try {
        const workspace = await resolveThreadWorkspace(bb, threadId);
        const path = normalizeHostPath(
          ensureSceneJsonPath(relativePath.replace(/^[\\/]+/, "")),
        );
        const absolutePath =
          path === null ? null : joinHostPath(workspace.rootPath, path);
        if (
          path === null ||
          absolutePath === null ||
          !isInsideRoot(workspace.rootPath, absolutePath)
        ) {
          return { ok: false as const, error: "Path escapes the workspace." };
        }
        const resolved = {
          hostId: workspace.hostId,
          absolutePath,
          rootPath: workspace.rootPath,
        };
        const saved = await writeHostText(
          bb,
          resolved,
          DEFAULT_ANIMATION_JSON,
          null,
        );
        if (saved.outcome === "conflict") {
          return {
            ok: false as const,
            error: `${path} already exists.`,
          };
        }
        return {
          ok: true as const,
          path,
          environmentId: workspace.environmentId,
          sha256: saved.sha256,
        };
      } catch (error) {
        return { ok: false as const, error: describe(error) };
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb animation new <path> [--json]",
    "  bb animation validate <path> [--seconds <n>] [--json]",
    "  bb animation export <path> [--out <html-path>] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "animation",
    summary: "Author and export step-based .scene.json explainer diagrams",
    commands: [
      {
        name: "new",
        summary: "Create a starter .scene.json file",
        usage: "bb animation new <path> [--json]",
      },
      {
        name: "validate",
        summary: "Parse an animation and report problems",
        usage: "bb animation validate <path> [--seconds <n>] [--json]",
      },
      {
        name: "export",
        summary: "Export an animation to standalone HTML",
        usage: "bb animation export <path> [--out <html-path>] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = jsonFlag(argv);
      const raw = withoutJson(argv);
      const outOpt = takeOption(raw, "--out");
      const secondsOpt = takeOption(outOpt.rest, "--seconds");
      const targetSeconds = Number(secondsOpt.value);
      const [command, ...args] = secondsOpt.rest;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`,
      });
      const fail = (error: string, extra?: unknown) => ({
        exitCode: 1,
        stderr: json
          ? `${JSON.stringify({ ok: false, error, ...(extra ?? {}) }, null, 2)}\n`
          : `${error}\n`,
      });

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: `${usage}\n` };
          case "new": {
            const input = args[0];
            if (!input || args.length !== 1) break;
            const path = ensureSceneJsonPath(input);
            const resolved = await resolveInvokingHostPath(bb, path, ctx);
            const saved = await writeHostText(
              bb,
              resolved,
              DEFAULT_ANIMATION_JSON,
              null,
            );
            if (saved.outcome === "conflict") {
              return fail(`${resolved.absolutePath} already exists.`);
            }
            return reply(
              { ok: true, path: resolved.absolutePath, sha256: saved.sha256 },
              `Created ${resolved.absolutePath}`,
            );
          }
          case "validate": {
            const input = args[0];
            if (!input || args.length !== 1) break;
            const resolved = await resolveInvokingHostPath(bb, input, ctx);
            const file = await readHostText(bb, resolved);
            const parsed = parseDocument(file.content);
            const valid = parsed.problems.every(
              (problem) => problem.level !== "error",
            );
            // A document with errors is only approximated, so notes about how
            // it looks would be notes about the approximation.
            const advice = valid
              ? lintDocument(parsed.doc, {
                  targetSeconds:
                    Number.isFinite(targetSeconds) && targetSeconds > 0
                      ? targetSeconds
                      : undefined,
                })
              : [];
            const payload = {
              ok: valid,
              path: resolved.absolutePath,
              problems: parsed.problems,
              advice,
              steps: parsed.doc.steps.length,
              parts: Object.keys(parsed.doc.parts).length,
              durationMs: totalDuration(parsed.doc),
            };
            if (!payload.ok) {
              return fail(
                parsed.problems
                  .filter((problem) => problem.level === "error")
                  .map((problem) =>
                    problem.path
                      ? `${problem.path}: ${problem.message}`
                      : problem.message,
                  )
                  .join("\n"),
                payload,
              );
            }
            const lines = [
              ...(parsed.problems.length === 0
                ? [
                    `${resolved.absolutePath}: ok (${payload.steps} steps, ${payload.parts} parts)`,
                  ]
                : [
                    `${resolved.absolutePath}: ok with warnings`,
                    ...parsed.problems.map(
                      (problem) =>
                        `  ${problem.level} ${problem.path}: ${problem.message}`,
                    ),
                  ]),
              ...adviceLines(advice),
            ].join("\n");
            return reply(payload, lines);
          }
          case "export": {
            const input = args[0];
            if (!input || args.length !== 1) break;
            const resolved = await resolveInvokingHostPath(bb, input, ctx);
            const destination = outOpt.value
              ? await resolveInvokingHostPath(bb, outOpt.value, ctx)
              : defaultExportDestination(resolved);
            const result = await exportToHtml(bb, resolved, destination);
            if (!result.ok) {
              return fail(result.error, result);
            }
            return reply(
              result,
              `Exported ${result.outputPath} (${result.bytes} bytes)`,
            );
          }
        }
      } catch (error) {
        return fail(describe(error));
      }
      return { exitCode: 1, stderr: `${usage}\n` };
    },
  });

  const toolSource = async (
    threadId: string | undefined,
    filePath: string,
  ): Promise<ResolvedFile> =>
    resolveInvokingHostPath(bb, filePath, { threadId });

  /**
   * The exact line that plays a scene in chat, for the agent to copy. Agents
   * that compose the directive themselves tend to separate the attributes
   * with a comma, which BB then shows as plain text.
   */
  const embedHint = async (
    threadId: string | undefined,
    absolutePath: string,
  ): Promise<string[]> => {
    if (!threadId) return [];
    const workspace = await resolveThreadWorkspace(bb, threadId).catch(
      () => null,
    );
    const file = workspace
      ? relativeToRoot(workspace.rootPath, absolutePath)
      : null;
    if (!file || file.includes('"')) return [];
    return [
      `To play it in chat, put this on a line of its own: ${sceneDirective(file)}`,
      `An optional height (160 to 900) follows a space, never a comma: ${sceneDirective(file, 480)}`,
    ];
  };

  bb.agents.registerTool({
    name: "animation_export_html",
    description:
      "Export a .scene.json animation as a self-contained HTML file that plays and loops on its own. Prefer this over guessing an exporter. GIF and MP4 export are not available in this plugin.",
    instructions:
      "When the user wants a shareable animation page, call animation_export_html instead of hand-writing HTML. Point it at the .scene.json path.",
    presentation: {
      label: {
        pending: "Exporting animation HTML",
        completed: "Exported animation HTML",
      },
    },
    parameters: z
      .object({
        filePath: z
          .string()
          .min(1)
          .describe("Workspace-relative or absolute path to the .scene.json file."),
        outputPath: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Where to write the .html file. Defaults to the input path with the extension replaced.",
          ),
      })
      .strict(),
    async execute({ filePath, outputPath }, { threadId }) {
      try {
        const resolved = await toolSource(threadId, filePath);
        const destination = outputPath
          ? await toolSource(threadId, outputPath)
          : defaultExportDestination(resolved);
        const result = await exportToHtml(bb, resolved, destination);
        if (!result.ok) {
          return {
            content: [
              {
                type: "text",
                text: result.problems
                  ? `${result.error}\n${result.problems.join("\n")}`
                  : result.error,
              },
            ],
            isError: true,
          };
        }
        return [
          `Exported ${result.outputPath}`,
          `bytes=${result.bytes} steps=${result.steps} parts=${result.parts} durationMs=${result.durationMs}`,
          result.warnings.length > 0
            ? `warnings:\n${result.warnings.join("\n")}`
            : "warnings: none",
          ...(await embedHint(threadId, resolved.absolutePath)),
        ].join("\n");
      } catch (error) {
        return {
          content: [{ type: "text", text: describe(error) }],
          isError: true,
        };
      }
    },
  });

  bb.agents.registerTool({
    name: "animation_validate",
    description:
      "Check a .scene.json animation. Returns errors, warnings, and design notes that each name the exact fix: clipped rows, overlapping boxes, captions too fast to read, nothing revealed over time. Run it after every edit and apply the notes until there are none.",
    instructions:
      'To play a scene inline in a reply, put ::scene{file="docs/flow.scene.json"} on a line of its own, using the workspace-relative path. Separate attributes with a space, never a comma: ::scene{file="docs/flow.scene.json" height=480}. animation_validate returns the exact line for a given file.',
    presentation: {
      label: {
        pending: "Validating animation",
        completed: "Validated animation",
      },
    },
    parameters: z
      .object({
        filePath: z
          .string()
          .min(1)
          .describe("Workspace-relative or absolute path to the .scene.json file."),
        targetSeconds: z
          .number()
          .positive()
          .max(600)
          .optional()
          .describe(
            "The length the user asked for, in seconds. Pass it whenever they named one, and a note says if the scene is too short or too long. Omit it otherwise.",
          ),
      })
      .strict(),
    async execute({ filePath, targetSeconds }, { threadId }) {
      try {
        const resolved = await toolSource(threadId, filePath);
        const file = await readHostText(bb, resolved);
        const parsed = parseDocument(file.content);
        const errors = parsed.problems.filter(
          (problem) => problem.level === "error",
        );
        const warnings = parsed.problems.filter(
          (problem) => problem.level === "warning",
        );
        const lines = [
          `${resolved.absolutePath}: ${errors.length === 0 ? "ok" : "errors"}`,
          `parts=${Object.keys(parsed.doc.parts).length} steps=${parsed.doc.steps.length} durationMs=${totalDuration(parsed.doc)} (${(totalDuration(parsed.doc) / 1000).toFixed(1)} seconds)`,
          ...errors.map(
            (problem) =>
              `error ${problem.path}: ${problem.message}`,
          ),
          ...warnings.map(
            (problem) =>
              `warning ${problem.path}: ${problem.message}`,
          ),
          ...(errors.length === 0
            ? [
                ...adviceLines(lintDocument(parsed.doc, { targetSeconds })),
                ...(await embedHint(threadId, resolved.absolutePath)),
              ]
            : []),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: errors.length > 0,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: describe(error) }],
          isError: true,
        };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

export type { FileSource };
