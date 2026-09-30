import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolveSiblingPath } from "./core/htmlParts";
import type { FileSource } from "../contract";

export interface ResolvedFile {
  hostId: string;
  absolutePath: string;
  rootPath: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathSeparator(sample: string): "/" | "\\" {
  return sample.includes("\\") && !sample.includes("/") ? "\\" : "/";
}

function isWindowsPath(path: string): boolean {
  return path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Resolve `.` and `..` segments without touching the filesystem.
 *
 * Returns null when `..` climbs above the start of the path: there is no
 * sensible answer, and a containment check must never read one as "inside".
 */
export function normalizeHostPath(path: string): string | null {
  const sep = pathSeparator(path);
  const drive = /^([A-Za-z]:)[\\/]/.exec(path);
  let prefix = "";
  let rest = path;
  if (drive) {
    prefix = `${drive[1]}${sep}`;
    rest = path.slice(drive[0].length);
  } else if (path.startsWith("\\\\")) {
    prefix = "\\\\";
    rest = path.slice(2);
  } else if (path.startsWith("/")) {
    prefix = "/";
    rest = path.slice(1);
  }
  const segments: string[] = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join(sep)}`;
}

export function joinHostPath(root: string, relative: string): string {
  const sep = pathSeparator(root);
  const cleaned = relative.replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep);
  const base = root.replace(/[\\/]+$/, "");
  const joined = cleaned === "" ? base : `${base}${sep}${cleaned}`;
  // Left as written when `..` escapes the filesystem root, so the caller's
  // containment check sees it and refuses.
  return normalizeHostPath(joined) ?? joined;
}

export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || isWindowsPath(path);
}

/**
 * True when `target` is `root` or sits beneath it, after resolving `..`.
 *
 * Windows paths compare case-insensitively. POSIX paths do not, because
 * `/Work` and `/work` are different directories there.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const nRoot = normalizeHostPath(root);
  const nTarget = normalizeHostPath(target);
  if (nRoot === null || nTarget === null) return false;
  const fold = (value: string) =>
    isWindowsPath(root)
      ? value.replace(/\\/g, "/").toLowerCase()
      : value.replace(/\\/g, "/");
  const base = fold(nRoot).replace(/\/+$/, "");
  const candidate = fold(nTarget);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * `target` relative to `root`, with `/` separators, or null when it is the
 * root itself or sits outside it.
 */
export function relativeToRoot(root: string, target: string): string | null {
  if (!isInsideRoot(root, target)) return null;
  const base = (normalizeHostPath(root) ?? root).replace(/[\\/]+$/, "");
  const rest = (normalizeHostPath(target) ?? target)
    .slice(base.length)
    .replace(/^[\\/]+/, "");
  return rest === "" ? null : rest.replace(/\\/g, "/");
}

function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}

export async function resolveFileSource(
  bb: BbPluginApi,
  source: FileSource,
  path: string,
): Promise<ResolvedFile> {
  if (source.kind === "host") {
    if (!isAbsoluteHostPath(path)) {
      throw new Error("Host files must be absolute paths.");
    }
    const hostId = source.experimental_hostId;
    if (!hostId) {
      throw new Error("This host file has no machine id.");
    }
    const absolutePath = normalizeHostPath(path) ?? path;
    // A host file inside the thread's workspace gets the workspace as its root,
    // so `htmlFile: "../partials/x.html"` works the same as it does there.
    const workspace = source.threadId
      ? await resolveThreadWorkspace(bb, source.threadId).catch(() => null)
      : null;
    const rootPath =
      workspace &&
      workspace.hostId === hostId &&
      isInsideRoot(workspace.rootPath, absolutePath)
        ? workspace.rootPath
        : parentDirectory(absolutePath);
    return { hostId, absolutePath, rootPath };
  }

  if (source.kind === "workspace") {
    let environmentId = source.environmentId;
    if (!environmentId && source.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: source.threadId });
      environmentId = thread.environmentId;
    }
    if (!environmentId) {
      throw new Error("This workspace file has no environment.");
    }
    const env = await bb.sdk.environments.get({
      environmentId,
    });
    if (!env.path) {
      throw new Error("The environment has no workspace path.");
    }
    const absolutePath = isAbsoluteHostPath(path)
      ? (normalizeHostPath(path) ?? path)
      : joinHostPath(env.path, path);
    if (!isInsideRoot(env.path, absolutePath)) {
      throw new Error("Path escapes the workspace.");
    }
    return {
      hostId: source.experimental_hostId ?? env.hostId,
      absolutePath,
      rootPath: env.path,
    };
  }

  if (!source.threadId) {
    throw new Error("This thread-storage file has no thread.");
  }
  const location = await bb.sdk.threads.storageLocation({
    threadId: source.threadId,
  });
  const absolutePath = isAbsoluteHostPath(path)
    ? (normalizeHostPath(path) ?? path)
    : joinHostPath(location.storageRootPath, path);
  if (!isInsideRoot(location.storageRootPath, absolutePath)) {
    throw new Error("Path escapes thread storage.");
  }
  return {
    hostId: location.hostId,
    absolutePath,
    rootPath: location.storageRootPath,
  };
}

export async function readHostText(
  bb: BbPluginApi,
  resolved: ResolvedFile,
): Promise<{ content: string; sha256: string; sizeBytes: number }> {
  const file = await bb.sdk.files.read({
    hostId: resolved.hostId,
    path: resolved.absolutePath,
    rootPath: resolved.rootPath,
  });
  if (file.contentEncoding === "base64") {
    throw new Error("Refusing to open a binary file as an animation.");
  }
  return {
    content: file.content,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  };
}

export async function writeHostText(
  bb: BbPluginApi,
  resolved: ResolvedFile,
  content: string,
  expectedSha256: string | null,
): Promise<
  | { outcome: "written"; sha256: string }
  | { outcome: "conflict"; currentSha256: string | null }
> {
  const saved = await bb.sdk.files.write({
    hostId: resolved.hostId,
    path: resolved.absolutePath,
    rootPath: resolved.rootPath,
    content,
    expectedSha256,
    createParents: true,
  });
  if (saved.outcome === "conflict") {
    return { outcome: "conflict", currentSha256: saved.currentSha256 };
  }
  return { outcome: "written", sha256: saved.sha256 };
}

export async function readSiblingAssets(
  bb: BbPluginApi,
  resolved: ResolvedFile,
  refs: string[],
): Promise<{ assets: Record<string, string>; errors: string[] }> {
  const assets: Record<string, string> = {};
  const errors: string[] = [];
  await Promise.all(
    refs.map(async (ref) => {
      const sibling = resolveSiblingPath(resolved.absolutePath, ref);
      if (sibling === null) {
        errors.push(
          `htmlFile ${JSON.stringify(ref)} must be a path relative to the document.`,
        );
        return;
      }
      if (!isInsideRoot(resolved.rootPath, sibling)) {
        errors.push(
          `htmlFile ${JSON.stringify(ref)} escapes the document root (${resolved.rootPath}).`,
        );
        return;
      }
      try {
        const file = await bb.sdk.files.read({
          hostId: resolved.hostId,
          path: sibling,
          rootPath: resolved.rootPath,
        });
        if (file.contentEncoding === "base64") {
          errors.push(`htmlFile ${JSON.stringify(ref)} is not text.`);
          return;
        }
        assets[ref] = file.content;
      } catch (error) {
        errors.push(
          `Could not read htmlFile ${JSON.stringify(ref)}: ${describe(error)}`,
        );
      }
    }),
  );
  return { assets, errors };
}

export async function resolveThreadWorkspace(
  bb: BbPluginApi,
  threadId: string,
): Promise<{ hostId: string; rootPath: string; environmentId: string }> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) {
    throw new Error("This thread has no workspace environment.");
  }
  const env = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (!env.path) {
    throw new Error("The environment has no workspace path.");
  }
  return {
    hostId: env.hostId,
    rootPath: env.path,
    environmentId: env.id,
  };
}

export async function resolveInvokingHostPath(
  bb: BbPluginApi,
  rawPath: string,
  ctx: { cwd?: string; threadId?: string },
): Promise<ResolvedFile> {
  const trimmed = rawPath.trim();
  if (trimmed === "") {
    throw new Error("A path is required.");
  }

  let hostId: string | undefined;
  let rootPath: string | undefined;
  if (ctx.threadId) {
    try {
      const workspace = await resolveThreadWorkspace(bb, ctx.threadId);
      hostId = workspace.hostId;
      rootPath = workspace.rootPath;
    } catch {
      hostId = undefined;
      rootPath = undefined;
    }
  }

  const cwd = ctx.cwd?.trim() || rootPath;
  const absolutePath = isAbsoluteHostPath(trimmed)
    ? trimmed
    : cwd
      ? joinHostPath(cwd, trimmed)
      : trimmed;
  if (!isAbsoluteHostPath(absolutePath)) {
    throw new Error(
      "Could not resolve a host path. Run this from a thread with a workspace, or pass an absolute path.",
    );
  }

  const normalized = normalizeHostPath(absolutePath) ?? absolutePath;
  // The workspace is the natural boundary for `htmlFile` lookups. Outside one,
  // the directory the command ran in is, so shared partials above the scene
  // still resolve.
  const invokedFrom = ctx.cwd?.trim();
  const resolvedRoot =
    rootPath && isInsideRoot(rootPath, normalized)
      ? rootPath
      : invokedFrom && isInsideRoot(invokedFrom, normalized)
        ? invokedFrom
        : parentDirectory(normalized);

  return {
    hostId: hostId ?? (await primaryHostId(bb)),
    absolutePath: normalized,
    rootPath: resolvedRoot,
  };
}

async function primaryHostId(bb: BbPluginApi): Promise<string> {
  const hosts = await bb.sdk.hosts.list();
  const first = hosts[0];
  if (!first) {
    throw new Error("No connected machine is available.");
  }
  return first.id;
}
