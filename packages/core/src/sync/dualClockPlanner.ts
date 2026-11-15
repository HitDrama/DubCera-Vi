import type { DualClockScheduleInput, SegmentSchedulePlan } from '../contracts/playback';

export function quantizeSpeechRate05(rate: number): number {
  // Round up to nearest 0.05 step so speech finishes slightly before or right on deadline
  return Math.ceil((rate - 1e-9) * 20) / 20;
}

export function clampNumber(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function mapVideoTimeToAudioClock(
  targetVideoMs: number,
  currentVideoTimeMs: number,
  nowClockMs: number,
  videoRate: number,
): number {
  const safeVideoRate = Math.max(0.25, videoRate);
  return nowClockMs + (targetVideoMs - currentVideoTimeMs) / safeVideoRate;
}

/**
 * Computes an exact, single-voice playback schedule for one SpeechSegment
 * while strictly separating `videoTimeMs` (subtitle timeline) from `audioClockMs` (real playback clock).
 *
 * Invariants enforced:
 * - I2: Never trims audioDurationMs.
 * - I3: actualStartClockMs >= prevAudioEndClockMs + minBreathGapClockMs.
 * - I4: effectiveSpeechRate <= maxEffectiveSpeechRate and NEVER multiplied by videoRate twice.
 */
export function planSegmentDualClock(input: DualClockScheduleInput): SegmentSchedulePlan {
  const safeVideoRate = Math.max(0.25, input.videoRate);
  const minBreathGapClockMs = input.minBreathGapClockMs ?? 60;
  const maxSilenceBorrowVideoMs = input.maxSilenceBorrowVideoMs ?? 2500;
  const defaultMaxRate = safeVideoRate > 1.05 ? 1.35 : 1.30;
  const maxEffectiveSpeechRate = input.maxEffectiveSpeechRate ?? defaultMaxRate;

  const targetStartClockMs = mapVideoTimeToAudioClock(
    input.segmentStartVideoMs,
    input.currentVideoTimeMs,
    input.nowClockMs,
    safeVideoRate,
  );

  // Never schedule in the past relative to nowClockMs, and never overlap previous audio
  const earliestNonOverlappingClockMs =
    input.prevAudioEndClockMs > 0
      ? input.prevAudioEndClockMs + minBreathGapClockMs
      : input.nowClockMs;

  const actualStartClockMs = Math.max(
    input.nowClockMs,
    targetStartClockMs,
    earliestNonOverlappingClockMs,
  );

  const hardDeadlineVideoMs =
    input.nextSegmentStartVideoMs !== null
      ? input.nextSegmentStartVideoMs
      : input.segmentEndVideoMs + maxSilenceBorrowVideoMs;

  const usableEndVideoMs = Math.max(
    input.segmentEndVideoMs,
    Math.min(hardDeadlineVideoMs, input.segmentEndVideoMs + maxSilenceBorrowVideoMs),
  );

  const usableEndClockMs = mapVideoTimeToAudioClock(
    usableEndVideoMs,
    input.currentVideoTimeMs,
    input.nowClockMs,
    safeVideoRate,
  );

  const availableClockWindowMs = Math.max(250, usableEndClockMs - actualStartClockMs);
  const neededRate = input.audioDurationMs / availableClockWindowMs;

  const quantizedRate = quantizeSpeechRate05(Math.max(1.0, neededRate));
  const effectiveSpeechRate = Number(
    clampNumber(quantizedRate, 1.0, maxEffectiveSpeechRate).toFixed(2),
  );

  const actualAudioDurationClockMs = input.audioDurationMs / effectiveSpeechRate;
  const expectedEndClockMs = actualStartClockMs + actualAudioDurationClockMs;
  const overflowClockMs = Math.max(0, expectedEndClockMs - usableEndClockMs);

  return {
    targetStartClockMs,
    actualStartClockMs,
    usableEndClockMs,
    availableClockWindowMs,
    neededRate,
    effectiveSpeechRate,
    actualAudioDurationClockMs,
    expectedEndClockMs,
    overflowClockMs,
  };
}
