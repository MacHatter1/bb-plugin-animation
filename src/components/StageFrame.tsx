/**
 * The stage: an iframe that holds the rendered scene.
 *
 * Two rules govern this component and they explain most of its shape.
 *
 * 1. **The scene is written once per document change, not per frame.** Rewriting
 *    it to animate would restart every CSS transition, which is the whole
 *    mechanism. So the document is written on mount and on structural edits, and
 *    time changes only push attributes.
 * 2. **Nothing here is React state.** The frame's contents are imperative; making
 *    them declarative would mean React reconciling a document it does not own.
 */

import { useCallback, useEffect, useRef } from "react";
import type { AnimDocument, ResolvedPartState } from "../core/types";
import {
  applySelection,
  applyStates,
  partIdFromEvent,
  setStageAnimationsPaused,
  writeStageDocument,
} from "../render/stageDocument";
import type { ThemeTokens } from "../render/stageCss";
import type { HtmlAssets } from "../core/htmlParts";

export interface StageFrameProps {
  doc: AnimDocument;
  /** Bumped by the editor whenever the scene's structure changes. */
  sceneVersion: number;
  states: Map<string, ResolvedPartState>;
  /** True when the state change came from a seek rather than playback. */
  immediate: boolean;
  playing: boolean;
  selectedPartId: string | null;
  tokens: ThemeTokens;
  /** Markup for the document's `htmlFile` refs. */
  assets?: HtmlAssets;
  onSelectPart: (partId: string | null) => void;
}

export function StageFrame({
  doc,
  sceneVersion,
  states,
  immediate,
  playing,
  selectedPartId,
  tokens,
  assets,
  onSelectPart,
}: StageFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const onSelectRef = useRef(onSelectPart);
  onSelectRef.current = onSelectPart;

  const writeScene = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    writeStageDocument(frame, doc, tokens, assets);

    const frameDoc = frame.contentDocument;
    if (!frameDoc) return;

    // Re-attached on every write because `document.open()` discards listeners.
    frameDoc.addEventListener("click", (event) => {
      onSelectRef.current(partIdFromEvent(event));
    });

    applyStates(frameDoc, states, { immediate: true });
    setStageAnimationsPaused(frameDoc, !playing);
    applySelection(frameDoc, selectedPartId);
    // `states`/`selectedPartId` are intentionally not dependencies: this runs on
    // structural change, and reads whatever the current values are at that
    // moment. The effects below own the per-change updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, tokens, assets, playing]);

  useEffect(() => {
    writeScene();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneVersion, tokens]);

  useEffect(() => {
    const frameDoc = frameRef.current?.contentDocument;
    if (!frameDoc) return;
    applyStates(frameDoc, states, { immediate });
    setStageAnimationsPaused(frameDoc, !playing);
  }, [states, immediate, playing]);

  useEffect(() => {
    const frameDoc = frameRef.current?.contentDocument;
    if (!frameDoc) return;
    applySelection(frameDoc, selectedPartId);
  }, [selectedPartId]);

  return (
    <iframe
      ref={frameRef}
      className="scene-stage-frame"
      title="Animation stage"
      sandbox="allow-same-origin"
      style={{ aspectRatio: `${doc.stage.width} / ${doc.stage.height}` }}
    />
  );
}
