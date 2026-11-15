import type { DriftPredictionResult, SyncMode } from '../contracts/playback';
import type { SpeechSegment } from '../contracts/subtitle';
import { mapVideoTimeToAudioClock, planSegmentDualClock } from './dualClockPlanner';

export interface DriftPredictionInput {
  nowClockMs: number;
  currentVideoTimeMs: number;
  userVideoRate: number;
  prevAudioEndClockMs: number;
  upcomingSegments: SpeechSegment[]; // Slice of next 3-5 segments starting from current/next
  syncMode: SyncMode;
  maxEffectiveSpeechRate?: number;
}

/**
 * Simulates a 3-5 segment lookahead window to detect cumulative drift BEFORE audio falls seconds behind.
 */
export function predictLookaheadDrift(input: DriftPredictionInput): DriftPredictionResult {
  const windowSegments = input.upcomingSegments
    .filter((s) => typeof s.audioDurationMs === 'number' && s.audioDurationMs > 0)
    .slice(0, 5);

  if (windowSegments.length === 0) {
    return {
      predictedCumulativeDriftClockMs: 0,
      recommendedAction: 'NONE',
      recommendedVideoRateMultiplier: 1.0,
    };
  }

  let simulatedPrevEndClock = input.prevAudioEndClockMs;
  let maxDriftClockMs = 0;

  for (const seg of windowSegments) {
    const plan = planSegmentDualClock({
      nowClockMs: input.nowClockMs,
      currentVideoTimeMs: input.currentVideoTimeMs,
      videoRate: input.userVideoRate,
      prevAudioEndClockMs: simulatedPrevEndClock,
      segmentStartVideoMs: seg.startMs,
      segmentEndVideoMs: seg.endMs,
      nextSegmentStartVideoMs: seg.nextSegmentStartMs,
      audioDurationMs: seg.audioDurationMs!,
      maxEffectiveSpeechRate: input.maxEffectiveSpeechRate,
    });

    simulatedPrevEndClock = plan.expectedEndClockMs;

    const hardBoundaryVideoMs = seg.nextSegmentStartMs ?? seg.endMs + 1000;
    const hardBoundaryClockMs = mapVideoTimeToAudioClock(
      hardBoundaryVideoMs,
      input.currentVideoTimeMs,
      input.nowClockMs,
      input.userVideoRate,
    );

    const driftAtBoundary = Math.max(0, plan.expectedEndClockMs - hardBoundaryClockMs);
    if (driftAtBoundary > maxDriftClockMs) {
      maxDriftClockMs = driftAtBoundary;
    }
  }

  if (maxDriftClockMs <= 300) {
    return {
      predictedCumulativeDriftClockMs: maxDriftClockMs,
      recommendedAction: 'NONE',
      recommendedVideoRateMultiplier: 1.0,
    };
  }

  if (maxDriftClockMs <= 800) {
    return {
      predictedCumulativeDriftClockMs: maxDriftClockMs,
      recommendedAction: 'SPEED_UP_LIGHT',
      recommendedVideoRateMultiplier: 1.0,
    };
  }

  if (input.syncMode === 'STRICT_VIDEO_SPEED') {
    return {
      predictedCumulativeDriftClockMs: maxDriftClockMs,
      recommendedAction: 'WARN_DRIFT_ONLY',
      recommendedVideoRateMultiplier: 1.0,
    };
  }

  if (maxDriftClockMs <= 1500) {
    return {
      predictedCumulativeDriftClockMs: maxDriftClockMs,
      recommendedAction: 'BORROW_AND_SLOW_VIDEO',
      recommendedVideoRateMultiplier: 0.88,
    };
  }

  return {
    predictedCumulativeDriftClockMs: maxDriftClockMs,
    recommendedAction: 'HOLD_VIDEO_AT_BOUNDARY',
    recommendedVideoRateMultiplier: 0.85,
  };
}
