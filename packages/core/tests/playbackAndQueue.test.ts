import { describe, expect, it } from 'vitest';
import {
  buildPreemptiveQueue,
  canAutoResumeFromBuffer,
  createInitialPlaybackState,
  enterDubBuffering,
  markAutoplayRejected,
  recordSeekInitiated,
  recordUserPauseIntent,
  recordUserPlayIntent,
  resolveSeekTargetWithSnap,
  resolveSegmentIndexAtVideoTime,
  type SpeechSegment,
} from '../src/index';

function makeDummySegments(count: number, readyIndices: number[] = []): SpeechSegment[] {
  const readySet = new Set(readyIndices);
  return Array.from({ length: count }, (_, idx) => ({
    segmentIndex: idx,
    segmentId: `seg-${idx}`,
    sourceCueIds: [`cue-${idx}`],
    startMs: idx * 10_000,
    endMs: idx * 10_000 + 8_000,
    nextSegmentStartMs: idx + 1 < count ? (idx + 1) * 10_000 : null,
    sourceText: `Sentence ${idx}`,
    configVersion: 'cfg-1',
    status: readySet.has(idx) ? 'READY' : 'UNPROCESSED',
  }));
}

describe('PlaybackIntentMachine & Two-Tier Preemptive Queue (Invariants I1, I6, I8)', () => {
  it('blocks auto-resume if user clicks Pause while system is buffering (Invariant I8)', () => {
    let state = createInitialPlaybackState();
    state = recordUserPlayIntent(state);

    const { nextState, snapshot } = enterDubBuffering(state);
    state = nextState;
    expect(canAutoResumeFromBuffer(state, snapshot, true)).toBe(true);

    // User clicks Pause during buffering!
    state = recordUserPauseIntent(state);
    expect(canAutoResumeFromBuffer(state, snapshot, true)).toBe(false);
  });

  it('blocks stale buffering completion when a newer seek increments sessionId (Invariant I6)', () => {
    let state = recordUserPlayIntent(createInitialPlaybackState());
    const { nextState, snapshot } = enterDubBuffering(state);
    state = nextState;

    // User scrubs to a new timestamp before first seek finished buffering
    state = recordSeekInitiated(state);
    expect(canAutoResumeFromBuffer(state, snapshot, true)).toBe(false);
  });

  it('blocks auto-resume cleanly when browser rejects video.play() Promise', () => {
    let state = recordUserPlayIntent(createInitialPlaybackState());
    const { nextState, snapshot } = enterDubBuffering(state);
    state = markAutoplayRejected(nextState);
    expect(canAutoResumeFromBuffer(state, snapshot, true)).toBe(false);
  });

  it('always plays full segment from start on any mid-segment seek (even at 90% elapsed — Invariant I1)', () => {
    const segments = makeDummySegments(5);
    // Segment 2 spans [20_000 .. 28_000)
    expect(resolveSegmentIndexAtVideoTime(segments, 20_000)).toBe(2);
    expect(resolveSegmentIndexAtVideoTime(segments, 24_500)).toBe(2); // 56%
    expect(resolveSegmentIndexAtVideoTime(segments, 27_600)).toBe(2); // 95% -> still replays Segment 2 completely!
    expect(resolveSegmentIndexAtVideoTime(segments, 28_000)).toBe(3); // Past Segment 2 end -> moves to Segment 3
  });

  it('computes cue-start snap timestamp when user seeks into the middle of a segment', () => {
    const segments = makeDummySegments(5);
    // Mid-segment seek at 24_500ms inside Segment 2 [20_000 .. 28_000) -> snaps back to 20_000ms!
    expect(resolveSeekTargetWithSnap(segments, 24_500)).toEqual({
      segmentIndex: 2,
      snapVideoTimeMs: 20_000,
    });

    // Seek right at segment start (20_100ms, within 250ms threshold) -> no snap needed
    expect(resolveSeekTargetWithSnap(segments, 20_100)).toEqual({
      segmentIndex: 2,
      snapVideoTimeMs: null,
    });

    // Seek inside silent gap [18_000 .. 20_000) before Segment 2 -> targets Segment 2 without snapping backward
    expect(resolveSeekTargetWithSnap(segments, 19_000)).toEqual({
      segmentIndex: 2,
      snapVideoTimeMs: null,
    });
  });

  it('preempts queue to P0_URGENT at seek target and skips already-READY cached segments', () => {
    // 10 segments (0s .. 100s); segments 0, 1, and 5 are already READY in cache
    const segments = makeDummySegments(10, [0, 1, 5]);

    // User jumps to 42_000ms (inside Segment 4)
    const queue = buildPreemptiveQueue(segments, 42_000, 'cfg-1', {
      urgentWindowVideoMs: 30_000,
      urgentMinCount: 3,
    });

    // Segment 5 is READY so it must be skipped!
    // First tasks must be 4, 6, 7 (P0_URGENT), then 8, 9 (forward P1), then 2, 3 (earlier backfill P1)
    expect(queue.map((t) => t.segmentIndex)).toEqual([4, 6, 7, 8, 9, 2, 3]);
    expect(queue[0]?.tier).toBe('P0_URGENT');
    expect(queue[1]?.tier).toBe('P0_URGENT');
    expect(queue[2]?.tier).toBe('P0_URGENT');
    expect(queue[queue.length - 1]?.tier).toBe('P1_BACKGROUND');
  });
});
