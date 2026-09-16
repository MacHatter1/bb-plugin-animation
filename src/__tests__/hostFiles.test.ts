import { describe, expect, it } from "vitest";
import {
  isAbsoluteHostPath,
  isInsideRoot,
  joinHostPath,
} from "../hostFiles";
import {
  ensureSceneJsonPath,
  isAnimationDocumentPath,
  isSceneJsonPath,
  siblingExportPath,
  titleFromPath,
} from "../template";

describe("host path helpers", () => {
  it("joins posix roots", () => {
    expect(joinHostPath("/work", "docs/a.scene.json")).toBe(
      "/work/docs/a.scene.json",
    );
  });

  it("rejects paths that escape the root", () => {
    expect(isInsideRoot("/work", "/work/docs/a.scene.json")).toBe(true);
    expect(isInsideRoot("/work", "/tmp/a.scene.json")).toBe(false);
  });

  it("detects absolute paths", () => {
    expect(isAbsoluteHostPath("/tmp/a.scene.json")).toBe(true);
    expect(isAbsoluteHostPath("docs/a.scene.json")).toBe(false);
    expect(isAbsoluteHostPath("C:\\anim\\a.scene.json")).toBe(true);
  });

  it("recognizes scene documents and the anim.json read alias", () => {
    expect(isSceneJsonPath("cache.scene.json")).toBe(true);
    expect(isSceneJsonPath("cache.anim.json")).toBe(false);
    expect(isAnimationDocumentPath("cache.scene.json")).toBe(true);
    expect(isAnimationDocumentPath("cache.anim.json")).toBe(true);
    expect(isAnimationDocumentPath("cache.json")).toBe(false);
  });

  it("rewrites create paths to .scene.json", () => {
    expect(ensureSceneJsonPath("cache")).toBe("cache.scene.json");
    expect(ensureSceneJsonPath("cache.json")).toBe("cache.scene.json");
    expect(ensureSceneJsonPath("cache.anim.json")).toBe("cache.scene.json");
    expect(ensureSceneJsonPath("cache.scene.json")).toBe("cache.scene.json");
  });

  it("strips either document suffix for export names", () => {
    expect(siblingExportPath("docs/flow.scene.json", ".html")).toBe(
      "docs/flow.html",
    );
    expect(siblingExportPath("docs/flow.anim.json", ".html")).toBe(
      "docs/flow.html",
    );
    expect(titleFromPath("docs/flow.scene.json")).toBe("flow");
  });
});
