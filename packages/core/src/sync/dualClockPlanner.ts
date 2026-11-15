import type { DualClockScheduleInput, SegmentSchedulePlan } from '../contracts/playback';

export function quantizeSpeechRate05(rate: number): number {
  // Round up to nearest 0.05 step so speech finishes slightly before or right on deadline
  return Math.ceil((rate - 1e-9) * 20) / 20;
}

export function clampNumber(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function countVietnameseSyllables(text?: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed
    .split(/\s+/)
    .filter((token) => /[A-Za-z0-9À-ỹ]/.test(token)).length;
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
 * Baseline voice speed is strictly locked at >= 1.0x (never slowed down below 1.0x so neural TTS
 * clarity and timbre remain 100% crisp), while continuous adjacent segments bridge seamlessly via
 * `allowEarlyLeadInClockMs` + `minBreathGapClockMs`.
 */
export function planSegmentDualClock(input: DualClockScheduleInput): SegmentSchedulePlan {
  const safeVideoRate = Math.max(0.25, input.videoRate);
  const minBreathGapClockMs = input.minBreathGapClockMs ?? 60;
  const maxSilenceBorrowVideoMs = input.maxSilenceBorrowVideoMs ?? 2500;
  const defaultMaxRate = safeVideoRate > 1.05 ? 1.35 : 1.30;
  const maxEffectiveSpeechRate = input.maxEffectiveSpeechRate ?? defaultMaxRate;
  const minBaselineRate = Math.max(1.0, input.minEffectiveSpeechRate ?? 1.0);

  const targetStartClockMs = mapVideoTimeToAudioClock(
    input.segmentStartVideoMs,
    input.currentVideoTimeMs,
    input.nowClockMs,
    safeVideoRate,
  );

  const allowEarlyLeadInClockMs = Math.max(0, input.allowEarlyLeadInClockMs ?? 0);
  const earliestTimelineStartClockMs = targetStartClockMs - allowEarlyLeadInClockMs;

  // Never schedule in the past relative to nowClockMs, and never overlap previous audio
  const earliestNonOverlappingClockMs =
    input.prevAudioEndClockMs > 0
      ? input.prevAudioEndClockMs + minBreathGapClockMs
      : input.nowClockMs;

  const actualStartClockMs = Math.max(
    input.nowClockMs,
    earliestTimelineStartClockMs,
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

  const quantizedRate = quantizeSpeechRate05(Math.max(minBaselineRate, neededRate));
  const effectiveSpeechRate = Number(
    clampNumber(quantizedRate, minBaselineRate, maxEffectiveSpeechRate).toFixed(2),
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
