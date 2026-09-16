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

export function joinHostPath(root: string, relative: string): string {
  const sep = pathSeparator(root);
  const cleaned = relative.replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep);
  const base = root.replace(/[\\/]+$/, "");
  return cleaned === "" ? base : `${base}${sep}${cleaned}`;
}

export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

export function isInsideRoot(root: string, target: string): boolean {
  const sep = pathSeparator(root);
  const normalize = (value: string) =>
    value.replace(/[\\/]+$/, "").replace(/[\\/]/g, sep).toLowerCase();
  const nRoot = normalize(root);
  const nTarget = normalize(target);
  return nTarget === nRoot || nTarget.startsWith(`${nRoot}${sep}`);
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
    const rootPath = path.replace(/[\\/][^\\/]*$/, "") || path;
    return { hostId, absolutePath: path, rootPath };
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
      ? path
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
    ? path
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
          `htmlFile ${JSON.stringify(ref)} escapes the document root.`,
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

  const resolvedRoot = rootPath && isInsideRoot(rootPath, absolutePath)
    ? rootPath
    : absolutePath.replace(/[\\/][^\\/]*$/, "") || absolutePath;

  return {
    hostId: hostId ?? (await primaryHostId(bb)),
    absolutePath,
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
