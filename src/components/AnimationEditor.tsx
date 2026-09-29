import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
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
import { DocumentSync, isOnDisk, type SaveOutcome } from "./documentSync";
import { editorShortcut, focusKind, RetimeDrag } from "./editorInput";
import { loadEmbed, StepTicker } from "./embed";
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
  const [exportNotice, setExportNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const extrasRef = useRef<DocumentExtras>(createEmptyExtras());
  const problemsRef = useRef<Problem[]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  // The sync object is created once and reads the latest rpc, path and source
  // through this ref, so its in-flight and revision state survive re-renders.
  const ioRef = useRef({ rpc, path, source });
  ioRef.current = { rpc, path, source };
  const [, syncChanged] = useReducer((count: number) => count + 1, 0);
  const [sync] = useState(
    () =>
      new DocumentSync<AnimDocument>(
        {
          read: async () => {
            const io = ioRef.current;
            const result = await io.rpc.call("read_file", {
              path: io.path,
              source: io.source,
            });
            return result.ok
              ? { ok: true, content: result.content, sha256: result.sha256 }
              : { ok: false, error: result.error };
          },
          write: (content, expectedSha256) => {
            const io = ioRef.current;
            return io.rpc.call("write_file", {
              path: io.path,
              source: io.source,
              content,
              expectedSha256,
            });
          },
        },
        syncChanged,
        MAX_UNDO,
      ),
  );
  const [drag] = useState(() => new RetimeDrag<AnimDocument>(setStepDuration));
  const dirty = sync.dirty;
  const saving = sync.saving;
  const diskConflict = sync.conflict;

  /** Show a document now, so handlers running before the next render see it. */
  const showDoc = useCallback((next: AnimDocument) => {
    docRef.current = next;
    setDoc(next);
  }, []);

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
      showDoc(result.doc);
      setProblems(result.problems);
      void refreshAssets(result.doc);
    },
    [refreshAssets, showDoc],
  );

  // Initial load and the Reload button. `sync.reload` waits for any write in
  // flight and clears undo, so nothing from before the reload can be replayed
  // over the version just taken from disk.
  const loadFromDisk = useCallback(async () => {
    const result = await sync.reload();
    if (!result.ok) {
      setLoadError(result.error);
      setLoaded(true);
      return;
    }
    setLoadError(null);
    ingest(result.content);
    setLoaded(true);
  }, [ingest, sync]);

  useEffect(() => {
    void loadFromDisk();
  }, [loadFromDisk]);

  const hasErrors = () =>
    problemsRef.current.some((problem) => problem.level === "error");

  const save = useCallback(
    async (options?: { overwrite?: boolean }): Promise<SaveOutcome> => {
      if (hasErrors()) {
        toast.error("Fix parse errors before saving.");
        return "error";
      }
      const outcome = await sync.save(
        () => serializeDocument(docRef.current, extrasRef.current),
        options,
      );
      if (outcome === "error") {
        toast.error(sync.lastError ?? "Could not save the file.");
      } else if (outcome === "conflict") {
        toast.error(
          "The file changed on disk. Reload to take that version, or Keep mine to overwrite it.",
        );
      }
      return outcome;
    },
    [sync],
  );

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
      void sync.poll(() => !drag.active).then((fresh) => {
        if (fresh) ingest(fresh.content);
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [drag, ingest, loaded, sync]);

  const exportHtml = useCallback(async () => {
    if (hasErrors()) {
      setExportNotice({ ok: false, text: "Fix parse errors before exporting." });
      return;
    }
    // Export reads the file from disk, so it must match what is on screen.
    if (!isOnDisk(await save())) {
      setExportNotice({
        ok: false,
        text: "Not exported: the file could not be saved.",
      });
      return;
    }
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
    const previous = sync.undo(docRef.current);
    if (previous) showDoc(previous);
  }, [showDoc, sync]);

  const redo = useCallback(() => {
    const next = sync.redo(docRef.current);
    if (next) showDoc(next);
  }, [showDoc, sync]);

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
      if (!commit) {
        if (hasErrors()) return;
        showDoc(drag.preview(docRef.current, stepIndex, durationMs));
        return;
      }
      // The drag always ends here, even when the edit is refused, so the next
      // drag cannot start from this one's stale base.
      const result = drag.commit(docRef.current, stepIndex, durationMs);
      if (hasErrors() || !result.changed) {
        showDoc(result.base);
        return;
      }
      sync.edited(result.base);
      showDoc(result.doc);
    },
    [drag, showDoc, sync],
  );

  const handleRetimeCancel = useCallback(() => {
    const base = drag.cancel();
    if (base) showDoc(base);
  }, [drag, showDoc]);

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

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const command = editorShortcut(event, focusKind(event.target));
      if (!command) return;
      event.preventDefault();
      if (command === "save") void save();
      else if (command === "undo") undo();
      else if (command === "redo") redo();
      else toggle();
    },
    [redo, save, toggle, undo],
  );

  // Keys pressed in the editor chrome. Keys pressed after clicking the stage go
  // to the iframe's own document, which StageFrame forwards to the same handler.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const focused = document.activeElement;
      if (!root || !focused || !root.contains(focused)) return;
      handleKeyDown(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleKeyDown]);

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
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadFromDisk()}
              >
                Reload
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void save({ overwrite: true })}
              >
                Keep mine
              </Button>
            </>
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
              onKeyDown={handleKeyDown}
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
          onRetimeCancel={handleRetimeCancel}
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

  // Stable across renders: the loader re-reads the file whenever this changes,
  // and a streaming message re-renders constantly.
  const fileSource = useMemo<FileSource>(
    () => ({
      kind: "workspace",
      threadId: message.threadId || null,
      environmentId: null,
      projectId: message.projectId,
    }),
    [message.threadId, message.projectId],
  );

  // Off-screen embeds stop their clock and their packet animations.
  const embedRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = embedRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [file]);

  if (!file) {
    return <code>{source}</code>;
  }

  return (
    <div className="scene-embed" style={{ height }} ref={embedRef}>
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
      <InlineStage path={file} source={fileSource} visible={visible} />
    </div>
  );
}

function InlineStage({
  path,
  source,
  visible,
}: {
  path: string;
  source: FileSource;
  visible: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [doc, setDoc] = useState<AnimDocument | null>(null);
  const [assets, setAssets] = useState<HtmlAssets>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState({ index: 0, wrapped: true });
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    let cancelled = false;
    void loadEmbed(path, {
      readFile: () => rpc.call("read_file", { path, source }),
      readAssets: (refs) => rpc.call("read_assets", { path, source, refs }),
    }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setStep({ index: 0, wrapped: true });
      setDoc(result.doc);
      setAssets(result.assets);
    });
    return () => {
      cancelled = true;
    };
  }, [path, rpc, source]);

  // One timer per step rather than a frame loop: the stage only changes at a
  // step boundary. It resumes from the current step when scrolled back in.
  useEffect(() => {
    if (!doc || !visible) return;
    const ticker = new StepTicker(
      doc.steps.map((item) => item.duration),
      (index, wrapped) => setStep({ index, wrapped }),
      stepRef.current.index,
    );
    ticker.start();
    return () => ticker.stop();
  }, [doc, visible]);

  const states = useMemo(
    () => (doc ? resolveAtStep(doc, doc.steps.length > 0 ? step.index : -1) : null),
    [doc, step.index],
  );

  if (error) {
    return <p className="scene-embed-error">{error}</p>;
  }
  if (!doc || !states) {
    return <p className="scene-embed-error">Loading animation…</p>;
  }

  return (
    <StageFrame
      doc={doc}
      sceneVersion={1}
      states={states}
      immediate={step.wrapped}
      playing={visible}
      selectedPartId={null}
      tokens={FALLBACK_TOKENS}
      assets={assets}
      onSelectPart={() => undefined}
    />
  );
}
