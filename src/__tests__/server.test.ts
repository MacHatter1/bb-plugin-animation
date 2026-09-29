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
        storageLocation: async () => ({
          hostId: "host_1",
          storageRootPath: "/storage/thr_1",
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

const WORKSPACE = {
  kind: "workspace" as const,
  threadId: "thr_1",
  environmentId: null,
  projectId: "proj_1",
};

async function loadPlugin(files: Record<string, string> = {}) {
  const store = fileStore(files);
  const { bb, harness } = createFakePluginHost({
    pluginId: "animation",
    sdk: store.sdk,
  });
  await plugin(bb);
  return { store, behavior: harness.behavior };
}

const SHARED_PARTIAL_SCENE = JSON.stringify({
  parts: {
    card: {
      type: "html",
      x: 0,
      y: 0,
      w: 200,
      h: 80,
      htmlFile: "../partials/card.html",
    },
  },
  steps: [{ id: "a", duration: 500 }],
});

describe("file boundaries", () => {
  it("refuses workspace paths that climb out with ..", async () => {
    const { behavior } = await loadPlugin({ "/etc/passwd": "root:x:0:0" });
    for (const path of [
      "../etc/passwd",
      "docs/../../etc/passwd",
      "/work/../etc/passwd",
    ]) {
      const result = (await behavior.callRpc("read_file", {
        path,
        source: WORKSPACE,
      })) as { ok: boolean; error?: string };
      expect(result).toEqual({ ok: false, error: "Path escapes the workspace." });
    }
  });

  it("refuses thread-storage paths that climb out with ..", async () => {
    const { behavior } = await loadPlugin({ "/storage/secret": "x" });
    const result = (await behavior.callRpc("read_file", {
      path: "../secret",
      source: { ...WORKSPACE, kind: "thread-storage" },
    })) as { ok: boolean; error?: string };
    expect(result).toEqual({ ok: false, error: "Path escapes thread storage." });
  });

  it("does not treat a differently cased sibling as inside a POSIX root", async () => {
    const { behavior } = await loadPlugin({ "/Work/x.scene.json": "{}" });
    const result = (await behavior.callRpc("read_file", {
      path: "/Work/x.scene.json",
      source: WORKSPACE,
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it("creates new files inside the workspace only", async () => {
    const { store, behavior } = await loadPlugin();
    const escaped = (await behavior.callRpc("create_file", {
      threadId: "thr_1",
      relativePath: "../../outside/x",
    })) as { ok: boolean };
    expect(escaped).toEqual({ ok: false, error: "Path escapes the workspace." });
    expect([...store.files.keys()]).toEqual([]);

    const inside = (await behavior.callRpc("create_file", {
      threadId: "thr_1",
      relativePath: "docs/../intro",
    })) as { ok: boolean; path?: string };
    expect(inside).toMatchObject({ ok: true, path: "intro.scene.json" });
    expect(store.files.has("/work/intro.scene.json")).toBe(true);
  });

  it("resolves shared partials above the scene from the directory the CLI ran in", async () => {
    const { store, behavior } = await loadPlugin({
      "/proj/anims/a.scene.json": SHARED_PARTIAL_SCENE,
      "/proj/partials/card.html": "<p>shared card</p>",
    });
    const exported = await behavior.runCli(
      ["export", "anims/a.scene.json", "--json"],
      { cwd: "/proj" },
    );
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout).warnings).toEqual([]);
    expect(store.files.get("/proj/anims/a.html")?.content).toContain("shared card");
  });

  it("still refuses partials above the directory the CLI ran in", async () => {
    const { behavior } = await loadPlugin({
      "/proj/anims/a.scene.json": SHARED_PARTIAL_SCENE,
      "/proj/partials/card.html": "<p>shared card</p>",
    });
    const exported = await behavior.runCli(
      ["export", "a.scene.json", "--json"],
      { cwd: "/proj/anims" },
    );
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout).warnings.join("\n")).toMatch(
      /escapes the document root \(\/proj\/anims\)/,
    );
  });

  it("gives a host file inside the thread's workspace the workspace as its root", async () => {
    const { behavior } = await loadPlugin({
      "/work/anims/a.scene.json": SHARED_PARTIAL_SCENE,
      "/work/partials/card.html": "<p>shared card</p>",
      "/elsewhere/anims/a.scene.json": SHARED_PARTIAL_SCENE,
      "/elsewhere/partials/card.html": "<p>outside</p>",
    });
    const host = {
      ...WORKSPACE,
      kind: "host" as const,
      experimental_hostId: "host_1",
    };
    const inside = (await behavior.callRpc("read_assets", {
      path: "/work/anims/a.scene.json",
      source: host,
      refs: ["../partials/card.html"],
    })) as { assets: Record<string, string>; errors: string[] };
    expect(inside.assets["../partials/card.html"]).toBe("<p>shared card</p>");

    const outside = (await behavior.callRpc("read_assets", {
      path: "/elsewhere/anims/a.scene.json",
      source: host,
      refs: ["../partials/card.html"],
    })) as { assets: Record<string, string>; errors: string[] };
    expect(outside.assets).toEqual({});
    expect(outside.errors[0]).toMatch(/escapes the document root/);
  });
});

describe("export destinations", () => {
  it("leaves a file it did not write alone", async () => {
    const { store, behavior } = await loadPlugin({
      "/work/index.scene.json": DEFAULT_ANIMATION_JSON,
      "/work/index.html": "<html>my landing page</html>",
    });
    const exported = await behavior.runCli(["export", "index.scene.json"], {
      cwd: "/work",
      threadId: "thr_1",
    });
    expect(exported.exitCode).toBe(1);
    expect(exported.stderr).toMatch(/is not an Animation export/);
    expect(store.files.get("/work/index.html")?.content).toBe(
      "<html>my landing page</html>",
    );
  });

  it("refuses to write over the scene itself", async () => {
    const { store, behavior } = await loadPlugin({
      "/work/flow.scene.json": DEFAULT_ANIMATION_JSON,
    });
    const viaCli = await behavior.runCli(
      ["export", "flow.scene.json", "--out", "flow.scene.json"],
      { cwd: "/work", threadId: "thr_1" },
    );
    expect(viaCli.exitCode).toBe(1);
    const viaTool = await behavior.callAgentTool(
      "animation_export_html",
      { filePath: "flow.scene.json", outputPath: "./flow.scene.json" },
      { threadId: "thr_1" },
    );
    expect(typeof viaTool === "object" && viaTool.isError).toBe(true);
    expect(store.files.get("/work/flow.scene.json")?.content).toBe(
      DEFAULT_ANIMATION_JSON,
    );
  });

  it("replaces its own earlier export, including one from 0.1.0", async () => {
    const legacy =
      '<!DOCTYPE html>\n<html lang="en">\n<body>\n' +
      '<div data-scene-stage style="width:100%;height:100%"></div>\n' +
      "<script>\nvar TIMELINE = [];\n</script>\n</body>\n</html>\n";
    const { store, behavior } = await loadPlugin({
      "/work/flow.scene.json": DEFAULT_ANIMATION_JSON,
      "/work/flow.html": legacy,
    });
    const ctx = { cwd: "/work", threadId: "thr_1" };
    expect((await behavior.runCli(["export", "flow.scene.json"], ctx)).exitCode).toBe(0);
    expect(store.files.get("/work/flow.html")?.content).toContain(
      '<meta name="generator" content="bb-plugin-animation">',
    );
    expect((await behavior.runCli(["export", "flow.scene.json"], ctx)).exitCode).toBe(0);
  });

  it("resolves an editor export path the same way as the scene path", async () => {
    const { store, behavior } = await loadPlugin({
      "/work/docs/flow.scene.json": DEFAULT_ANIMATION_JSON,
    });
    const result = (await behavior.callRpc("export_html", {
      path: "docs/flow.scene.json",
      source: WORKSPACE,
      outputPath: "site/flow.html",
    })) as { ok: boolean; outputPath?: string };
    expect(result).toMatchObject({ ok: true, outputPath: "/work/site/flow.html" });
    expect(store.files.has("/work/site/flow.html")).toBe(true);

    const escaped = (await behavior.callRpc("export_html", {
      path: "docs/flow.scene.json",
      source: WORKSPACE,
      outputPath: "../outside.html",
    })) as { ok: boolean; error?: string };
    expect(escaped).toEqual({ ok: false, error: "Path escapes the workspace." });
  });
});

