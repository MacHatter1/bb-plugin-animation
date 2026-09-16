/**
 * The step strip: the timeline, and the only direct-manipulation surface.
 *
 * Block widths are proportional to duration, so the strip is a picture of the
 * animation's pacing rather than a list of equal cells. Every gesture maps to
 * exactly one number in the document, which is what keeps it comprehensible
 * next to an agent editing the same file:
 *
 * - Drag the playhead, or click the ruler, to seek.
 * - Drag a boundary to retime the step to its left.
 * - Click a block to jump to its start.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  frameAt,
  startTimeOf,
  stepStartTimes,
  totalDuration,
} from "../core/timeline";
import type { AnimDocument } from "../core/types";

export interface StepStripProps {
  doc: AnimDocument;
  time: number;
  playing: boolean;
  loop: boolean;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onJumpToStart: () => void;
  onToggleLoop: () => void;
  /** Live preview while dragging; `commit` marks the end of the gesture. */
  onRetimeStep: (
    stepIndex: number,
    durationMs: number,
    commit: boolean
  ) => void;
  currentStepIndex: number;
  readOnly: boolean;
}

const RULER_STEP_MS = 1000;

function formatTime(ms: number): string {
  return (ms / 1000).toFixed(2);
}

interface DragState {
  kind: "playhead" | "boundary";
  stepIndex: number;
  startX: number;
  startDuration: number;
  msPerPixel: number;
}

export function StepStrip({
  doc,
  time,
  playing,
  loop,
  onSeek,
  onTogglePlay,
  onStep,
  onJumpToStart,
  onToggleLoop,
  onRetimeStep,
  currentStepIndex,
  readOnly,
}: StepStripProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const total = totalDuration(doc);
  const starts = stepStartTimes(doc);
  const pct = (ms: number) => (total > 0 ? (ms / total) * 100 : 0);

  const msPerPixel = useCallback(() => {
    const width = trackRef.current?.clientWidth ?? 0;
    return width > 0 && total > 0 ? total / width : 0;
  }, [total]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || total <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      onSeek(Math.max(0, Math.min(total, ratio * total)));
    },
    [onSeek, total]
  );

  // Pointer move/up live on the window so a drag survives the cursor leaving
  // the strip -- otherwise a fast drag silently stops retiming partway.
  useEffect(() => {
    if (!drag) return;

    const handleMove = (event: PointerEvent) => {
      if (drag.kind === "playhead") {
        seekFromClientX(event.clientX);
        return;
      }
      const scale = drag.msPerPixel;
      if (scale === 0) return;
      const deltaMs = (event.clientX - drag.startX) * scale;
      onRetimeStep(drag.stepIndex, drag.startDuration + deltaMs, false);
    };

    const handleUp = (event: PointerEvent) => {
      if (drag.kind === "boundary") {
        const scale = drag.msPerPixel;
        const deltaMs = scale === 0 ? 0 : (event.clientX - drag.startX) * scale;
        onRetimeStep(drag.stepIndex, drag.startDuration + deltaMs, true);
      }
      setDrag(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [drag, msPerPixel, onRetimeStep, seekFromClientX]);

  const ticks: number[] = [];
  for (let t = 0; t <= total; t += RULER_STEP_MS) ticks.push(t);

  const currentStep =
    currentStepIndex >= 0 ? doc.steps[currentStepIndex] : undefined;

  return (
    <div className="scene-timeline">
      <div className="scene-transport">
        <div className="scene-transport-buttons">
          <button
            type="button"
            className="scene-tbtn"
            onClick={onJumpToStart}
            title="Jump to start"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4.2 3.4v9.2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path d="M12.6 3.9 6.6 8l6 4.1z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="scene-tbtn"
            onClick={() => onStep(-1)}
            title="Previous step"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M10.2 4.4 6.2 8l4 3.6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
          <button
            type="button"
            className="scene-tbtn scene-tbtn-play"
            onClick={onTogglePlay}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="4.6"
                  y="3.6"
                  width="2.6"
                  height="8.8"
                  rx="0.8"
                  fill="currentColor"
                />
                <rect
                  x="8.8"
                  y="3.6"
                  width="2.6"
                  height="8.8"
                  rx="0.8"
                  fill="currentColor"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5.2 3.4 12 8l-6.8 4.6z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="scene-tbtn"
            onClick={() => onStep(1)}
            title="Next step"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M5.8 4.4 9.8 8l-4 3.6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
          <button
            type="button"
            className={loop ? "scene-tbtn scene-tbtn-on" : "scene-tbtn"}
            onClick={onToggleLoop}
            title="Loop"
            aria-pressed={loop}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 7.2V6.4a2 2 0 0 1 2-2h6.4M13 8.8v.8a2 2 0 0 1-2 2H4.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="m9.8 2.6 1.8 1.8-1.8 1.8M6.2 9.8 4.4 11.6l1.8 1.8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
        </div>

        <div className="scene-time-readout">
          {formatTime(time)}
          <span className="scene-time-total"> / {formatTime(total)}s</span>
        </div>
        <div className="scene-transport-meta">
          <span>{doc.stage.fps} fps</span>
          <span className="scene-sep">|</span>
          <span>frame {frameAt(doc, time)}</span>
        </div>

        <div className="scene-transport-spacer" />

        {currentStep ? (
          <span className="scene-current-step">
            step {currentStepIndex + 1} of {doc.steps.length} &middot;{" "}
            {currentStep.id}
          </span>
        ) : (
          <span className="scene-current-step scene-current-step-empty">
            no steps
          </span>
        )}
      </div>

      <div className="scene-track" ref={trackRef}>
        <div
          className="scene-ruler"
          onPointerDown={(event) => {
            seekFromClientX(event.clientX);
            setDrag({
              kind: "playhead",
              stepIndex: -1,
              startX: event.clientX,
              startDuration: 0,
              msPerPixel: msPerPixel(),
            });
          }}
        >
          {ticks.map((t) => (
            <div className="scene-tick" key={t} style={{ left: `${pct(t)}%` }}>
              <i />
              <span>{Math.round(t / 1000)}s</span>
            </div>
          ))}
        </div>

        <div className="scene-steps-row">
          {doc.steps.map((step, index) => (
            <div
              key={step.id}
              className={
                index === currentStepIndex
                  ? "scene-step scene-step-active"
                  : "scene-step"
              }
              style={{ width: `${pct(step.duration)}%` }}
              onClick={() => onSeek(startTimeOf(doc, index))}
              title={step.caption ?? step.id}
            >
              <span className="scene-step-name">{step.id}</span>
              <span className="scene-step-dur">{step.duration}ms</span>
              {step.set ? (
                <span className="scene-step-tones">
                  {Object.entries(step.set)
                    .slice(0, 4)
                    .map(([partId, assignment]) => (
                      <span
                        key={partId}
                        className={`scene-tone-dot scene-tone-${
                          assignment.tone ?? "neutral"
                        }`}
                      />
                    ))}
                </span>
              ) : null}
            </div>
          ))}

          {/* Boundaries sit above the blocks so the grab target is not clipped. */}
          {doc.steps.map((step, index) =>
            index < doc.steps.length ? (
              <div
                key={`boundary-${step.id}`}
                className={
                  drag?.kind === "boundary" && drag.stepIndex === index
                    ? "scene-boundary scene-boundary-active"
                    : readOnly
                    ? "scene-boundary scene-boundary-readonly"
                    : "scene-boundary"
                }
                style={{ left: `${pct(starts[index] + step.duration)}%` }}
                title={
                  readOnly
                    ? `"${step.id}" is read-only`
                    : `Drag to retime "${step.id}"`
                }
                aria-disabled={readOnly}
                onPointerDown={(event) => {
                  if (readOnly) return;
                  event.stopPropagation();
                  setDrag({
                    kind: "boundary",
                    stepIndex: index,
                    startX: event.clientX,
                    startDuration: step.duration,
                    msPerPixel: msPerPixel(),
                  });
                }}
              >
                <div className="scene-grip" />
                {drag?.kind === "boundary" && drag.stepIndex === index ? (
                  <div className="scene-boundary-tip">{step.duration}ms</div>
                ) : null}
              </div>
            ) : null
          )}
        </div>

        <div
          className="scene-playhead"
          style={{ left: `${pct(time)}%` }}
          onPointerDown={(event) => {
            event.stopPropagation();
            setDrag({
              kind: "playhead",
              stepIndex: -1,
              startX: event.clientX,
              startDuration: 0,
              msPerPixel: msPerPixel(),
            });
          }}
        />
      </div>
    </div>
  );
}
