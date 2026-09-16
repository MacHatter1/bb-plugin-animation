import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { DEFAULT_ANIMATION_JSON } from "../template";
import { parseDocument } from "../core/parse";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type Stored = { content: string; sha256: string };

function fileStore(initial: Record<string, string> = {}) {
  const files = new Map<string, Stored>();
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, { content, sha256: sha256(content) });
  }
  return {
    files,
    sdk: {
      files: {
        read: async ({ path }: { path: string }) => {
          const file = files.get(path);
          if (!file) throw new Error(`not found: ${path}`);
          return {
            path,
            content: file.content,
            contentEncoding: "utf8" as const,
            sha256: file.sha256,
            sizeBytes: Buffer.byteLength(file.content),
          };
        },
        write: async ({
          path,
          content,
          expectedSha256,
        }: {
          path: string;
          content: string;
          expectedSha256?: string | null;
        }) => {
          const current = files.get(path);
          if (expectedSha256 === null && current) {
            return { outcome: "conflict" as const, currentSha256: current.sha256 };
          }
          if (
            typeof expectedSha256 === "string" &&
            current &&
            current.sha256 !== expectedSha256
          ) {
            return { outcome: "conflict" as const, currentSha256: current.sha256 };
          }
          const next = { content, sha256: sha256(content) };
          files.set(path, next);
          return {
            outcome: "written" as const,
            sha256: next.sha256,
            sizeBytes: Buffer.byteLength(content),
          };
        },
      },
      environments: {
        get: async () => ({
          id: "env_1",
          hostId: "host_1",
          path: "/work",
          projectId: "proj_1",
          status: "ready",
        }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            environmentId: "env_1",
            projectId: "proj_1",
          }),
      },
      hosts: {
        list: async () => [{ id: "host_1" }],
      },
    },
  };
}

describe("animation plugin server", () => {
  it("creates, validates, and exports an animation over CLI", async () => {
    const store = fileStore();
    const { bb, harness } = createFakePluginHost({
      pluginId: "animation",
      sdk: store.sdk,
    });
    await plugin(bb);

    const created = await harness.behavior.runCli(["new", "docs/cache.scene.json"], {
      cwd: "/work",
      threadId: "thr_1",
    });
    expect(created.exitCode).toBe(0);
    expect(store.files.has("/work/docs/cache.scene.json")).toBe(true);

    const validated = await harness.behavior.runCli(
      ["validate", "docs/cache.scene.json", "--json"],
      { cwd: "/work", threadId: "thr_1" },
    );
    expect(validated.exitCode).toBe(0);
    const payload = JSON.parse(validated.stdout) as { ok: boolean; steps: number };
    expect(payload.ok).toBe(true);
    expect(payload.steps).toBe(2);

    const exported = await harness.behavior.runCli(
      ["export", "docs/cache.scene.json"],
      { cwd: "/work", threadId: "thr_1" },
    );
    expect(exported.exitCode).toBe(0);
    const html = store.files.get("/work/docs/cache.html");
    expect(html?.content).toContain("<!DOCTYPE html>");
    expect(html?.content).toContain("scene-part");
  });

  it("exports through the agent tool", async () => {
    const store = fileStore({
      "/work/flow.scene.json": DEFAULT_ANIMATION_JSON,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "animation",
      sdk: store.sdk,
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool(
      "animation_export_html",
      { filePath: "flow.scene.json" },
      { threadId: "thr_1" },
    );
    expect(typeof result === "string" || result.isError !== true).toBe(true);
    expect(store.files.get("/work/flow.html")?.content).toContain("FIRST PART");
  });

  it("refuses to export a document with parse errors", async () => {
    const store = fileStore({
      "/work/bad.scene.json": "{",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "animation",
      sdk: store.sdk,
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool(
      "animation_validate",
      { filePath: "/work/bad.scene.json" },
      { threadId: "thr_1" },
    );
    expect(typeof result === "object" && result.isError).toBe(true);
  });

  it("rewrites bb animation new onto .scene.json", async () => {
    const store = fileStore();
    const { bb, harness } = createFakePluginHost({
      pluginId: "animation",
      sdk: store.sdk,
    });
    await plugin(bb);

    const created = await harness.behavior.runCli(["new", "docs/cache.anim.json"], {
      cwd: "/work",
      threadId: "thr_1",
    });
    expect(created.exitCode).toBe(0);
    expect(store.files.has("/work/docs/cache.scene.json")).toBe(true);
    expect(store.files.has("/work/docs/cache.anim.json")).toBe(false);
  });

  it("validates and exports an existing .anim.json file", async () => {
    const store = fileStore({
      "/work/legacy.anim.json": DEFAULT_ANIMATION_JSON,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "animation",
      sdk: store.sdk,
    });
    await plugin(bb);

    const validated = await harness.behavior.runCli(
      ["validate", "legacy.anim.json", "--json"],
      { cwd: "/work", threadId: "thr_1" },
    );
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout).ok).toBe(true);

    const exported = await harness.behavior.runCli(
      ["export", "legacy.anim.json"],
      { cwd: "/work", threadId: "thr_1" },
    );
    expect(exported.exitCode).toBe(0);
    expect(store.files.get("/work/legacy.html")?.content).toContain("<!DOCTYPE html>");
  });

  it("round-trips the starter document", () => {
    const parsed = parseDocument(DEFAULT_ANIMATION_JSON);
    expect(parsed.problems.filter((problem) => problem.level === "error")).toEqual(
      [],
    );
    expect(parsed.doc.steps).toHaveLength(2);
  });
});

