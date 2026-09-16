/**
 * The playback scheduler.
 *
 * Deliberately tiny: it owns a time value and advances it with rAF. Everything
 * visual is a pure function of that time (see `core/timeline.ts`), so this hook
 * never touches the scene -- it just says what time it is, and the stage
 * re-resolves. That separation is why scrubbing, playing, and stepping all
 * produce identical output for identical times.
 *
 * Time is held in a ref as well as state because the rAF loop needs to read the
 * latest value without re-subscribing every frame, and because `onVisibilityChange`
 * has to be able to pause without a stale closure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PlaybackOptions {
  /** Total run time in milliseconds. */
  duration: number;
  loop: boolean;
  /** Called whenever time changes, with whether the change was a seek. */
  onTimeChange?: (time: number, immediate: boolean) => void;
}

export interface Playback {
  time: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Jump to a time. Suppresses transitions, so it reads as a scrub. */
  seek: (time: number) => void;
  setLoop: (loop: boolean) => void;
}

export function usePlayback({ duration, loop, onTimeChange }: PlaybackOptions): Playback {
  const [time, setTimeState] = useState(0);
  const [playing, setPlaying] = useState(false);

  const timeRef = useRef(0);
  const loopRef = useRef(loop);
  const durationRef = useRef(duration);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const onTimeChangeRef = useRef(onTimeChange);

  loopRef.current = loop;
  durationRef.current = duration;
  onTimeChangeRef.current = onTimeChange;

  const commit = useCallback((next: number, immediate: boolean) => {
    timeRef.current = next;
    setTimeState(next);
    onTimeChangeRef.current?.(next, immediate);
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTickRef.current = null;
  }, []);

  const pause = useCallback(() => {
    stopLoop();
    setPlaying(false);
  }, [stopLoop]);

  const seek = useCallback(
    (next: number) => {
      const total = durationRef.current;
      const clamped = Math.max(0, Math.min(total, Math.round(next)));
      commit(clamped, true);
    },
    [commit],
  );

  const play = useCallback(() => {
    if (durationRef.current <= 0) return;
    // Restarting from the end is the common case after watching it once.
    if (timeRef.current >= durationRef.current) commit(0, true);
    setPlaying(true);
  }, [commit]);

  const toggle = useCallback(() => {
    setPlaying((current) => {
      if (current) {
        stopLoop();
        return false;
      }
      if (durationRef.current <= 0) return false;
      if (timeRef.current >= durationRef.current) commit(0, true);
      return true;
    });
  }, [commit, stopLoop]);

  const setLoop = useCallback((next: boolean) => {
    loopRef.current = next;
  }, []);

  useEffect(() => {
    if (!playing) {
      stopLoop();
      return;
    }

    const tick = (now: number) => {
      const last = lastTickRef.current;
      lastTickRef.current = now;
      // The first frame has no previous timestamp; advancing by `now` would
      // jump to the document's end instantly.
      const delta = last === null ? 0 : now - last;

      const total = durationRef.current;
      let next = timeRef.current + delta;

      if (next >= total) {
        if (loopRef.current && total > 0) {
          next = total > 0 ? next % total : 0;
          commit(Math.round(next), true);
        } else {
          commit(total, false);
          setPlaying(false);
          return;
        }
      } else {
        commit(Math.round(next), false);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return stopLoop;
  }, [playing, commit, stopLoop]);

  // A document edit can shorten the animation out from under the playhead.
  useEffect(() => {
    if (timeRef.current > duration) seek(duration);
  }, [duration, seek]);

  useEffect(() => stopLoop, [stopLoop]);

  return { time, playing, play, pause, toggle, seek, setLoop };
}
