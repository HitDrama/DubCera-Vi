import type { PlaybackState } from '../contracts/playback';
import type { SpeechSegment } from '../contracts/subtitle';

export interface BufferingSnapshot {
  capturedSessionId: number;
  capturedUserRevision: number;
}

export function createInitialPlaybackState(): PlaybackState {
  return {
    intent: 'PAUSE',
    isBuffering: false,
    sessionId: 1,
    userActionRevision: 0,
    autoplayBlocked: false,
    activeSegmentIndex: null,
  };
}

export function recordUserPlayIntent(state: PlaybackState): PlaybackState {
  return {
    ...state,
    intent: 'PLAY',
    userActionRevision: state.userActionRevision + 1,
    autoplayBlocked: false,
  };
}

export function recordUserPauseIntent(state: PlaybackState): PlaybackState {
  return {
    ...state,
    intent: 'PAUSE',
    isBuffering: false,
    userActionRevision: state.userActionRevision + 1,
  };
}

/**
 * When external player state becomes ambiguous during buffering (e.g. external control interaction),
 * fail safe to PAUSE so we never resume playback against user expectations (Invariant I8).
 */
export function recordAmbiguousExternalPause(state: PlaybackState): PlaybackState {
  return recordUserPauseIntent(state);
}

export function recordSeekInitiated(state: PlaybackState): PlaybackState {
  return {
    ...state,
    sessionId: state.sessionId + 1,
    activeSegmentIndex: null,
  };
}

export function enterDubBuffering(state: PlaybackState): {
  nextState: PlaybackState;
  snapshot: BufferingSnapshot;
} {
  const nextState: PlaybackState = {
    ...state,
    isBuffering: true,
  };
  return {
    nextState,
    snapshot: {
      capturedSessionId: nextState.sessionId,
      capturedUserRevision: nextState.userActionRevision,
    },
  };
}

export function canAutoResumeFromBuffer(
  state: PlaybackState,
  snapshot: BufferingSnapshot,
  requiredWindowReady: boolean,
): boolean {
  return (
    requiredWindowReady &&
    state.sessionId === snapshot.capturedSessionId &&
    state.userActionRevision === snapshot.capturedUserRevision &&
    state.intent === 'PLAY' &&
    !state.autoplayBlocked
  );
}

export function exitDubBuffering(state: PlaybackState): PlaybackState {
  return {
    ...state,
    isBuffering: false,
  };
}

export function markAutoplayRejected(state: PlaybackState): PlaybackState {
  return {
    ...state,
    isBuffering: false,
    autoplayBlocked: true,
  };
}

export interface SeekSnapResolution {
  segmentIndex: number;
  /**
   * When the user explicitly seeks into the middle of a cue/segment (`seekVideoMs > seg.startMs + snapThresholdMs`),
   * returns `seg.startMs` so the video rewinds cleanly to the start of that sentence and plays the full sentence
   * at calm natural speed (1.0x) instead of panic-speeding through a truncated leftover window.
   */
  snapVideoTimeMs: number | null;
}

/**
 * Mid-Segment Seek Resolution (MVP Default — Invariant I1):
 * - Any seek landing inside [seg.startMs, seg.endMs) replays `seg` from the start so 0 words are dropped.
 * - A seek at or past `seg.endMs` moves to the next segment whose `endMs > seekVideoMs`.
 */
export function resolveSegmentIndexAtVideoTime(
  segments: ReadonlyArray<Pick<SpeechSegment, 'segmentIndex' | 'startMs' | 'endMs'>>,
  seekVideoMs: number,
): number {
  const clampedMs = Math.max(0, seekVideoMs);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (clampedMs >= seg.startMs && clampedMs < seg.endMs) {
      return i;
    }
    if (clampedMs < seg.startMs) {
      return i;
    }
  }
  return -1;
}

/**
 * Resolves both the target SpeechSegment index AND whether `video.currentTime` should snap back
 * to `seg.startMs` so mid-cue timeline clicks read the entire sentence calmly in lockstep.
 */
export function resolveSeekTargetWithSnap(
  segments: ReadonlyArray<Pick<SpeechSegment, 'segmentIndex' | 'startMs' | 'endMs'>>,
  seekVideoMs: number,
  snapThresholdMs = 250,
): SeekSnapResolution {
  const idx = resolveSegmentIndexAtVideoTime(segments, seekVideoMs);
  if (idx === -1) {
    return { segmentIndex: -1, snapVideoTimeMs: null };
  }

  const seg = segments[idx]!;
  const clampedMs = Math.max(0, seekVideoMs);

  // Inside active cue/sentence beyond snapThresholdMs -> rewind video cleanly to sentence start!
  if (clampedMs > seg.startMs + snapThresholdMs && clampedMs < seg.endMs) {
    return {
      segmentIndex: idx,
      snapVideoTimeMs: seg.startMs,
    };
  }

  return {
    segmentIndex: idx,
    snapVideoTimeMs: null,
  };
}

/**
 * Computes the minimum required initial buffer indices (default 2 segments, or up to 3 if very short < 2s)
 * before releasing the Buffer Gate after a seek or initial play.
 */
export function getRequiredBufferIndices(
  segments: ReadonlyArray<Pick<SpeechSegment, 'startMs' | 'endMs'>>,
  startIndex: number,
  minSegments = 2,
  minCombinedSpanMs = 6000,
  maxCap = 3,
): number[] {
  if (startIndex < 0 || startIndex >= segments.length) return [];

  const indices: number[] = [];
  let combinedSpanMs = 0;

  for (let i = startIndex; i < segments.length && indices.length < maxCap; i++) {
    const seg = segments[i]!;
    indices.push(i);
    combinedSpanMs += Math.max(500, seg.endMs - seg.startMs);
    if (indices.length >= minSegments && combinedSpanMs >= minCombinedSpanMs) {
      break;
    }
  }

  return indices;
}
