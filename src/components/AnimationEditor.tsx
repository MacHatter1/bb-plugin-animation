import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { rpcContract, FileSource } from "../../contract";
import {
  parseDocument,
  createEmptyDocument,
  createEmptyExtras,
  type DocumentExtras,
  type Problem,
} from "../core/parse";
import { serializeDocument } from "../core/serialize";
import { buildContextItems } from "../core/selectionContext";
import { setStepDuration } from "../core/edits";
import { htmlFileRefs, type HtmlAssets } from "../core/htmlParts";
import {
  positionAt,
  resolveAtStep,
  snapToStepBoundary,
  startTimeOf,
  totalDuration,
} from "../core/timeline";
import type { AnimDocument } from "../core/types";
import { FALLBACK_TOKENS } from "../render/stageCss";
import { fileNameFromPath, isAnimationDocumentPath } from "../template";
import { StageFrame } from "./StageFrame";
import { StepStrip } from "./StepStrip";
import { usePlayback } from "./usePlayback";

function sceneSignature(doc: AnimDocument): string {
  return JSON.stringify({ stage: doc.stage, parts: doc.parts });
}

const MAX_UNDO = 60;
const AUTOSAVE_MS = 800;
const POLL_MS = 2500;

export function AnimationEditor({
  path,
  source,
}: {
  path: string;
  source: FileSource;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const fileName = fileNameFromPath(path);

  const [doc, setDoc] = useState<AnimDocument>(createEmptyDocument);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [immediate, setImmediate] = useState(true);
  const [loop, setLoopState] = useState(true);
  const [assets, setAssets] = useState<HtmlAssets>(() => new Map());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportNotice, setExportNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [diskConflict, setDiskConflict] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const extrasRef = useRef<DocumentExtras>(createEmptyExtras());
  const problemsRef = useRef<Problem[]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const sha256Ref = useRef<string | null>(null);
  const lastSavedTextRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const undoRef = useRef<AnimDocument[]>([]);
  const redoRef = useRef<AnimDocument[]>([]);
  const dragBaseRef = useRef<AnimDocument | null>(null);

  const total = totalDuration(doc);
  const playback = usePlayback({
    duration: total,
    loop,
    onTimeChange: (_time, wasImmediate) => setImmediate(wasImmediate),
  });
  const { seek, toggle } = playback;

  const refreshAssets = useCallback(
    async (next: AnimDocument) => {
      const refs = htmlFileRefs(next);
      if (refs.length === 0) {
        setAssets(new Map());
        return;
      }
      const result = await rpc.call("read_assets", { path, source, refs });
      setAssets(new Map(Object.entries(result.assets)));
      if (result.errors.length > 0) {
        const extra: Problem[] = result.errors.map((message) => ({
          level: "warning",
          path: "parts",
          message,
        }));
        problemsRef.current = [...problemsRef.current, ...extra];
        setProblems((previous) => [...previous, ...extra]);
      }
    },
    [path, rpc, source],
  );

  const ingest = useCallback(
    (text: string) => {
      const result = parseDocument(text);
      extrasRef.current = result.extras;
      problemsRef.current = result.problems;
      setDoc(result.doc);
      setProblems(result.problems);
      void refreshAssets(result.doc);
    },
    [refreshAssets],
  );

  const loadFromDisk = useCallback(async () => {
    const result = await rpc.call("read_file", { path, source });
    if (!result.ok) {
      setLoadError(result.error);
      setLoaded(true);
      return;
    }
    sha256Ref.current = result.sha256;
    lastSavedTextRef.current = result.content;
    setLoadError(null);
    setDiskConflict(false);
    ingest(result.content);
    setDirty(false);
    setLoaded(true);
  }, [ingest, path, rpc, source]);

  useEffect(() => {
    void loadFromDisk();
  }, [loadFromDisk]);

  const save = useCallback(async () => {
    if (problemsRef.current.some((problem) => problem.level === "error")) {
      toast.error("Fix parse errors before saving.");
      return;
    }
    const text = serializeDocument(docRef.current, extrasRef.current);
    setSaving(true);
    try {
      const result = await rpc.call("write_file", {
        path,
        source,
        content: text,
        expectedSha256: sha256Ref.current,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.outcome === "conflict") {
        setDiskConflict(true);
        toast.error("The file changed on disk. Reload or save again after reviewing.");
        return;
      }
      sha256Ref.current = result.sha256;
      lastSavedTextRef.current = text;
      setDirty(false);
      setDiskConflict(false);
    } finally {
      setSaving(false);
    }
  }, [path, rpc, source]);

  useEffect(() => {
    if (!dirty || diskConflict) return;
    const timer = window.setTimeout(() => {
      void save();
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, diskConflict, doc, save]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(() => {
      if (dirtyRef.current) return;
      void rpc.call("read_file", { path, source }).then((result) => {
        if (!result.ok) return;
        if (result.content === lastSavedTextRef.current) return;
        if (result.sha256 === sha256Ref.current) return;
        sha256Ref.current = result.sha256;
        lastSavedTextRef.current = result.content;
        undoRef.current = [];
        redoRef.current = [];
        ingest(result.content);
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [ingest, loaded, path, rpc, source]);

  const exportHtml = useCallback(async () => {
    if (problemsRef.current.some((problem) => problem.level === "error")) {
      setExportNotice({ ok: false, text: "Fix parse errors before exporting." });
      return;
    }
    if (dirtyRef.current) await save();
    const result = await rpc.call("export_html", { path, source });
    if (!result.ok) {
      setExportNotice({ ok: false, text: result.error });
      return;
    }
    setExportNotice({
      ok: true,
      text: `Exported ${fileNameFromPath(result.outputPath)}`,
    });
  }, [path, rpc, save, source]);

  useEffect(() => {
    if (!exportNotice) return;
    const timer = window.setTimeout(() => setExportNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [exportNotice]);

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(docRef.current);
    setDoc(previous);
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(docRef.current);
    setDoc(next);
    setDirty(true);
  }, []);

  const position = useMemo(
    () => positionAt(doc, playback.time),
    [doc, playback.time],
  );
  const states = useMemo(
    () => resolveAtStep(doc, position.stepIndex),
    [doc, position.stepIndex],
  );
  const signature = useMemo(() => sceneSignature(doc), [doc]);
  const sceneVersion = useRef(0);
  const lastSignature = useRef(signature);
  const lastAssets = useRef(assets);
  if (lastSignature.current !== signature || lastAssets.current !== assets) {
    lastSignature.current = signature;
    lastAssets.current = assets;
    sceneVersion.current += 1;
  }

  const seekSettled = useCallback(
    (ms: number) => seek(snapToStepBoundary(docRef.current, ms)),
    [seek],
  );

  const handleRetime = useCallback(
    (stepIndex: number, durationMs: number, commit: boolean) => {
      if (problemsRef.current.some((problem) => problem.level === "error")) {
        return;
      }
      if (!dragBaseRef.current) dragBaseRef.current = docRef.current;
      const base = dragBaseRef.current;
      const next = setStepDuration(base, stepIndex, durationMs);
      if (commit) {
        dragBaseRef.current = null;
        if (next === base) return;
        undoRef.current = [...undoRef.current.slice(-(MAX_UNDO - 1)), base];
        redoRef.current = [];
        setDoc(next);
        setDirty(true);
        return;
      }
      setDoc(next);
    },
    [],
  );

  const handleStep = useCallback(
    (delta: number) => {
      if (doc.steps.length === 0) return;
      const target = Math.max(
        0,
        Math.min(doc.steps.length - 1, position.stepIndex + delta),
      );
      seekSettled(startTimeOf(doc, target));
    },
    [doc, position.stepIndex, seekSettled],
  );

  const quoteSelection = useCallback(
    (partId: string | null) => {
      setSelectedPartId(partId);
      if (!partId) return;
      const items = buildContextItems(docRef.current, partId, playback.time);
      const description = items
        .map((item) => item.description)
        .filter(Boolean)
        .join("\n");
      if (description) composer.addQuote(description);
    },
    [composer, playback.time],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const focused = document.activeElement;
      if (!root || !focused || !root.contains(focused)) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, button, [contenteditable="true"]',
        )
      ) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, save, toggle, undo]);

  const errors = problems.filter((problem) => problem.level === "error");
  const warnings = problems.filter((problem) => problem.level === "warning");
  const currentStep =
    position.stepIndex >= 0 ? doc.steps[position.stepIndex] : undefined;

  if (!loaded) {
    return (
      <div className="scene-opener">
        <div className="scene-editor scene-editor-loading">Loading animation…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="scene-opener">
        <div className="scene-editor scene-editor-loading" role="alert">
          {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="scene-opener">
      <div className="scene-editor" ref={rootRef} tabIndex={0}>
        <div className="scene-toolbar">
          <span className="scene-filename">{fileName}</span>
          <span className="scene-save-state">
            {saving
              ? "Saving…"
              : diskConflict
                ? "Conflict"
                : dirty
                  ? "Unsaved"
                  : "Saved"}
          </span>
          <div className="scene-toolbar-spacer" />
          {exportNotice ? (
            <span
              className={
                exportNotice.ok
                  ? "scene-badge scene-badge-success"
                  : "scene-badge scene-badge-error"
              }
            >
              {exportNotice.text}
            </span>
          ) : null}
          {errors.length > 0 ? (
            <span
              className="scene-badge scene-badge-error"
              title={errors.map((item) => `${item.path}: ${item.message}`).join("\n")}
            >
              {errors.length} error{errors.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {warnings.length > 0 ? (
            <span
              className="scene-badge scene-badge-warning"
              title={warnings
                .map((item) => `${item.path}: ${item.message}`)
                .join("\n")}
            >
              {warnings.length} warning{warnings.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {diskConflict ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadFromDisk()}
            >
              Reload
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void exportHtml()}
          >
            Export HTML
          </Button>
        </div>

        <div className="scene-stage-wrap">
          <div className="scene-stage-holder">
            <StageFrame
              doc={doc}
              sceneVersion={sceneVersion.current}
              states={states}
              immediate={immediate}
              playing={playback.playing}
              selectedPartId={selectedPartId}
              tokens={FALLBACK_TOKENS}
              assets={assets}
              onSelectPart={quoteSelection}
            />
          </div>
          {currentStep?.caption ? (
            <p className="scene-caption">{currentStep.caption}</p>
          ) : null}
        </div>

        <StepStrip
          doc={doc}
          time={playback.time}
          playing={playback.playing}
          loop={loop}
          currentStepIndex={position.stepIndex}
          onSeek={seekSettled}
          onTogglePlay={playback.toggle}
          onStep={handleStep}
          onJumpToStart={() => seekSettled(0)}
          onToggleLoop={() => {
            setLoopState((value) => {
              playback.setLoop(!value);
              return !value;
            });
          }}
          onRetimeStep={handleRetime}
          readOnly={errors.length > 0}
        />
      </div>
    </div>
  );
}

export function AnimationOpener({
  path,
  source,
  Original,
}: {
  path: string;
  source: FileSource;
  Original: ComponentType;
}) {
  if (!isAnimationDocumentPath(path)) {
    return <Original />;
  }
  return (
    <AnimationEditor
      path={path}
      source={source}
    />
  );
}

export function AnimationDirective({
  attributes,
  source,
  message,
  openWorkspaceFile,
}: {
  attributes: Readonly<Record<string, string>>;
  source: string;
  message: { threadId: string; projectId: string | null };
  openWorkspaceFile: ((path: string) => boolean) | null;
}) {
  const file = attributes.file?.trim();
  const heightRaw = Number(attributes.height ?? "");
  const height =
    Number.isFinite(heightRaw) && heightRaw >= 160 && heightRaw <= 900
      ? heightRaw
      : 280;

  if (!file) {
    return <code>{source}</code>;
  }

  const fileSource: FileSource = message.threadId
    ? {
        kind: "workspace",
        threadId: message.threadId,
        environmentId: null,
        projectId: message.projectId,
      }
    : {
        kind: "workspace",
        threadId: null,
        environmentId: null,
        projectId: message.projectId,
      };

  return (
    <div className="scene-embed" style={{ height }}>
      <div className={cn("scene-embed-bar")}>
        <span className="scene-filename">{file}</span>
        {openWorkspaceFile ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openWorkspaceFile(file)}
          >
            Open
          </Button>
        ) : null}
      </div>
      <InlineStage path={file} source={fileSource} />
    </div>
  );
}

function InlineStage({ path, source }: { path: string; source: FileSource }) {
  const rpc = useRpc<typeof rpcContract>();
  const [doc, setDoc] = useState<AnimDocument | null>(null);
  const [assets, setAssets] = useState<HtmlAssets>(() => new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("read_file", { path, source }).then(async (result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const parsed = parseDocument(result.content);
      const refs = htmlFileRefs(parsed.doc);
      let nextAssets: HtmlAssets = new Map();
      if (refs.length > 0) {
        const loaded = await rpc.call("read_assets", { path, source, refs });
        nextAssets = new Map(Object.entries(loaded.assets));
      }
      if (cancelled) return;
      setDoc(parsed.doc);
      setAssets(nextAssets);
    });
    return () => {
      cancelled = true;
    };
  }, [path, rpc, source]);

  const playback = usePlayback({
    duration: doc ? totalDuration(doc) : 0,
    loop: true,
  });

  useEffect(() => {
    if (doc && !playback.playing) playback.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  if (error) {
    return <p className="scene-embed-error">{error}</p>;
  }
  if (!doc) {
    return <p className="scene-embed-error">Loading animation…</p>;
  }

  const position = positionAt(doc, playback.time);
  const states = resolveAtStep(doc, position.stepIndex);

  return (
    <StageFrame
      doc={doc}
      sceneVersion={1}
      states={states}
      immediate={false}
      playing={playback.playing}
      selectedPartId={null}
      tokens={FALLBACK_TOKENS}
      assets={assets}
      onSelectPart={() => undefined}
    />
  );
}
