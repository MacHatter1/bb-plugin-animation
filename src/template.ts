export const DEFAULT_ANIMATION_JSON = `{
  "version": 1,
  "stage": {
    "width": 1080,
    "height": 470,
    "fps": 25
  },
  "parts": {
    "box": {
      "type": "node",
      "label": "First part",
      "x": 420,
      "y": 180,
      "w": 240,
      "h": 110
    }
  },
  "steps": [
    {
      "id": "start",
      "duration": 800,
      "caption": "The scene begins.",
      "set": {
        "box": {
          "state": "idle"
        }
      }
    },
    {
      "id": "highlight",
      "duration": 1000,
      "caption": "The part becomes active.",
      "set": {
        "box": {
          "state": "active",
          "tone": "accent"
        }
      }
    }
  ]
}
`;

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function lowerPosixPath(path: string): string {
  return posixPath(path).toLowerCase();
}

/** Canonical on-disk suffix for new files. */
export const SCENE_JSON_SUFFIX = ".scene.json";

const DOCUMENT_SUFFIX_RE = /\.(?:scene|anim)\.json$/i;
const STRIP_DOCUMENT_SUFFIX_RE = /(\.(?:scene|anim))?\.json$/i;

/** True for `.scene.json` and the `.anim.json` read alias. */
export function isAnimationDocumentPath(path: string): boolean {
  return DOCUMENT_SUFFIX_RE.test(lowerPosixPath(path));
}

export function isSceneJsonPath(path: string): boolean {
  return lowerPosixPath(path).endsWith(SCENE_JSON_SUFFIX);
}

export function fileNameFromPath(path: string): string {
  const normalized = posixPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function siblingExportPath(filePath: string, extension: string): string {
  return filePath.replace(STRIP_DOCUMENT_SUFFIX_RE, "") + extension;
}

export function titleFromPath(filePath: string): string {
  return fileNameFromPath(filePath).replace(STRIP_DOCUMENT_SUFFIX_RE, "");
}

/** Rewrite a create-path to the canonical `.scene.json` suffix. */
export function ensureSceneJsonPath(path: string): string {
  const trimmed = path.trim();
  if (isSceneJsonPath(trimmed)) return trimmed;
  if (isAnimationDocumentPath(trimmed)) {
    return trimmed.replace(/\.anim\.json$/i, SCENE_JSON_SUFFIX);
  }
  if (trimmed.toLowerCase().endsWith(".json")) {
    return trimmed.replace(/\.json$/i, SCENE_JSON_SUFFIX);
  }
  return `${trimmed}${SCENE_JSON_SUFFIX}`;
}
