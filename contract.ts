import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const fileSourceSchema = z.object({
  kind: z.enum(["host", "thread-storage", "workspace"]),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  projectId: z.string().nullable(),
  experimental_hostId: z.string().optional(),
});

export type FileSource = z.infer<typeof fileSourceSchema>;

const readOk = z
  .object({
    ok: z.literal(true),
    content: z.string(),
    sha256: z.string(),
    fileName: z.string(),
    sizeBytes: z.number(),
  })
  .strict();

const fail = z
  .object({
    ok: z.literal(false),
    error: z.string(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  read_file: {
    input: z
      .object({
        path: z.string().min(1),
        source: fileSourceSchema,
      })
      .strict(),
    output: z.union([readOk, fail]),
  },
  write_file: {
    input: z
      .object({
        path: z.string().min(1),
        source: fileSourceSchema,
        content: z.string(),
        expectedSha256: z.string().nullable(),
      })
      .strict(),
    output: z.union([
      z
        .object({
          ok: z.literal(true),
          outcome: z.literal("written"),
          sha256: z.string(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(true),
          outcome: z.literal("conflict"),
          currentSha256: z.string().nullable(),
        })
        .strict(),
      fail,
    ]),
  },
  read_assets: {
    input: z
      .object({
        path: z.string().min(1),
        source: fileSourceSchema,
        refs: z.array(z.string()),
      })
      .strict(),
    output: z
      .object({
        assets: z.record(z.string(), z.string()),
        errors: z.array(z.string()),
      })
      .strict(),
  },
  export_html: {
    input: z
      .object({
        path: z.string().min(1),
        source: fileSourceSchema,
        outputPath: z.string().min(1).optional(),
      })
      .strict(),
    output: z.union([
      z
        .object({
          ok: z.literal(true),
          outputPath: z.string(),
          bytes: z.number(),
          durationMs: z.number(),
          steps: z.number(),
          parts: z.number(),
          warnings: z.array(z.string()),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          error: z.string(),
          problems: z.array(z.string()).optional(),
        })
        .strict(),
    ]),
  },
  create_file: {
    input: z
      .object({
        threadId: z.string().min(1),
        relativePath: z.string().min(1),
      })
      .strict(),
    output: z.union([
      z
        .object({
          ok: z.literal(true),
          path: z.string(),
          environmentId: z.string(),
          sha256: z.string(),
        })
        .strict(),
      fail,
    ]),
  },
});
