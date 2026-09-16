import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type FileSource } from "./contract";
import { parseDocument } from "./src/core/parse";
import { htmlFileRefs } from "./src/core/htmlParts";
import { totalDuration } from "./src/core/timeline";
import { buildStandaloneDocument } from "./src/render/standalone";
import { FALLBACK_TOKENS } from "./src/render/stageCss";
import {
  isAbsoluteHostPath,
  joinHostPath,
  readHostText,
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
        const loaded = await loadExportable(bb, resolved);
        if (!loaded.ok) return loaded;
        const destinationPath = outputPath?.trim()
          ? isAbsoluteHostPath(outputPath.trim())
            ? outputPath.trim()
            : joinHostPath(
                resolved.absolutePath.replace(/[\\/][^\\/]*$/, "") ||
                  resolved.rootPath,
                outputPath.trim(),
              )
          : siblingExportPath(resolved.absolutePath, ".html");
        const destination = {
          ...resolved,
          absolutePath: destinationPath,
        };

        const html = buildStandaloneDocument(loaded.doc, FALLBACK_TOKENS, {
          assets: new Map(Object.entries(loaded.assets)),
          title: titleFromPath(resolved.absolutePath),
        });
        const existing = await bb.sdk.files
          .read({
            hostId: destination.hostId,
            path: destination.absolutePath,
            rootPath: destination.rootPath,
          })
          .then((file) => file.sha256)
          .catch(() => null);
        const saved = await writeHostText(
          bb,
          destination,
          html,
          existing,
        );
        if (saved.outcome === "conflict") {
          return {
            ok: false as const,
            error: `Export conflicted at ${destination.absolutePath}. Retry.`,
          };
        }
        return {
          ok: true as const,
          outputPath: destination.absolutePath,
          bytes: html.length,
          durationMs: totalDuration(loaded.doc),
          steps: loaded.doc.steps.length,
          parts: Object.keys(loaded.doc.parts).length,
          warnings: loaded.warnings,
        };
      } catch (error) {
        return { ok: false as const, error: describe(error) };
      }
    },

    async create_file({ threadId, relativePath }) {
      try {
        const workspace = await resolveThreadWorkspace(bb, threadId);
        const path = ensureSceneJsonPath(relativePath.replace(/^[\\/]+/, ""));
        const resolved = {
          hostId: workspace.hostId,
          absolutePath: joinHostPath(workspace.rootPath, path),
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
    "  bb animation validate <path> [--json]",
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
        usage: "bb animation validate <path> [--json]",
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
      const [command, ...args] = outOpt.rest;
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
            const payload = {
              ok: parsed.problems.every((problem) => problem.level !== "error"),
              path: resolved.absolutePath,
              problems: parsed.problems,
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
            const lines =
              parsed.problems.length === 0
                ? `${resolved.absolutePath}: ok (${payload.steps} steps, ${payload.parts} parts)`
                : [
                    `${resolved.absolutePath}: ok with warnings`,
                    ...parsed.problems.map(
                      (problem) =>
                        `  ${problem.level} ${problem.path}: ${problem.message}`,
                    ),
                  ].join("\n");
            return reply(payload, lines);
          }
          case "export": {
            const input = args[0];
            if (!input || args.length !== 1) break;
            const resolved = await resolveInvokingHostPath(bb, input, ctx);
            const loaded = await loadExportable(bb, resolved);
            if (!loaded.ok) {
              return fail(loaded.error, loaded);
            }
            const outputPath = outOpt.value
              ? (await resolveInvokingHostPath(bb, outOpt.value, ctx))
                  .absolutePath
              : siblingExportPath(resolved.absolutePath, ".html");
            const destination = {
              ...resolved,
              absolutePath: outputPath,
            };
            const html = buildStandaloneDocument(loaded.doc, FALLBACK_TOKENS, {
              assets: new Map(Object.entries(loaded.assets)),
              title: titleFromPath(resolved.absolutePath),
            });
            const existing = await bb.sdk.files
              .read({
                hostId: destination.hostId,
                path: destination.absolutePath,
                rootPath: destination.rootPath,
              })
              .then((file) => file.sha256)
              .catch(() => null);
            const saved = await writeHostText(bb, destination, html, existing);
            if (saved.outcome === "conflict") {
              return fail(`Export conflicted at ${outputPath}.`);
            }
            const payload = {
              ok: true,
              outputPath,
              bytes: html.length,
              durationMs: totalDuration(loaded.doc),
              steps: loaded.doc.steps.length,
              parts: Object.keys(loaded.doc.parts).length,
              warnings: loaded.warnings,
            };
            return reply(
              payload,
              `Exported ${outputPath} (${html.length} bytes)`,
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
        const loaded = await loadExportable(bb, resolved);
        if (!loaded.ok) {
          return {
            content: [
              {
                type: "text",
                text: loaded.problems
                  ? `${loaded.error}\n${loaded.problems.join("\n")}`
                  : loaded.error,
              },
            ],
            isError: true,
          };
        }
        const destinationPath = outputPath
          ? (await toolSource(threadId, outputPath)).absolutePath
          : siblingExportPath(resolved.absolutePath, ".html");
        const destination = { ...resolved, absolutePath: destinationPath };
        const html = buildStandaloneDocument(loaded.doc, FALLBACK_TOKENS, {
          assets: new Map(Object.entries(loaded.assets)),
          title: titleFromPath(resolved.absolutePath),
        });
        const existing = await bb.sdk.files
          .read({
            hostId: destination.hostId,
            path: destination.absolutePath,
            rootPath: destination.rootPath,
          })
          .then((file) => file.sha256)
          .catch(() => null);
        const saved = await writeHostText(bb, destination, html, existing);
        if (saved.outcome === "conflict") {
          return {
            content: [
              {
                type: "text",
                text: `Export conflicted at ${destinationPath}.`,
              },
            ],
            isError: true,
          };
        }
        return [
          `Exported ${destinationPath}`,
          `bytes=${html.length} steps=${loaded.doc.steps.length} parts=${Object.keys(loaded.doc.parts).length} durationMs=${totalDuration(loaded.doc)}`,
          loaded.warnings.length > 0
            ? `warnings:\n${loaded.warnings.join("\n")}`
            : "warnings: none",
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
      "Parse a .scene.json animation and return errors, warnings, step count, and duration. Use before export or after editing.",
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
      })
      .strict(),
    async execute({ filePath }, { threadId }) {
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
          `parts=${Object.keys(parsed.doc.parts).length} steps=${parsed.doc.steps.length} durationMs=${totalDuration(parsed.doc)}`,
          ...errors.map(
            (problem) =>
              `error ${problem.path}: ${problem.message}`,
          ),
          ...warnings.map(
            (problem) =>
              `warning ${problem.path}: ${problem.message}`,
          ),
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
