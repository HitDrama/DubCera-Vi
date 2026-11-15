import { describe, expect, it } from 'vitest';
import {
  planSegmentDualClock,
  predictLookaheadDrift,
  type SpeechSegment,
} from '../src/index';

describe('DualClockSpeedPlanner & 3-5 Segment Drift Predictor (Invariants I2, I3, I4)', () => {
  it('enforces sequential non-overlapping playback (Invariant I3) when previous audio ran late', () => {
    const plan = planSegmentDualClock({
      nowClockMs: 5000,
      currentVideoTimeMs: 5000,
      videoRate: 1.0,
      prevAudioEndClockMs: 5400, // Previous audio still finishing at 5400ms
      segmentStartVideoMs: 4800, // Subtitle cue already passed 200ms ago
      segmentEndVideoMs: 8000,
      nextSegmentStartVideoMs: 8500,
      audioDurationMs: 2800,
    });

    // Must wait until 5400 + 60ms breath gap = 5460ms
    expect(plan.actualStartClockMs).toBe(5460);
    expect(plan.effectiveSpeechRate).toBeGreaterThanOrEqual(1.0);
    expect(plan.effectiveSpeechRate).toBeLessThanOrEqual(1.3);
  });

  it('maps videoRate=1.5x accurately onto audioClockMs without double-multiplying speech rate (Invariant I4)', () => {
    // Example from Architecture Review:
    // videoRate = 1.5x, 1.0x Vietnamese WAV = 5000ms, video window = 4000ms (no extra silence gap before next cue)
    // Real wall-clock window = 4000 / 1.5 = 2666.67ms -> neededRate = 5000 / 2666.67 = 1.875x
    // Planner MUST clamp effectiveSpeechRate to maxEffectiveSpeechRate (1.35x) and report overflowClockMs > 0
    const plan = planSegmentDualClock({
      nowClockMs: 10_000,
      currentVideoTimeMs: 20_000,
      videoRate: 1.5,
      prevAudioEndClockMs: 0,
      segmentStartVideoMs: 20_000,
      segmentEndVideoMs: 24_000,
      nextSegmentStartVideoMs: 24_000,
      audioDurationMs: 5000,
      maxEffectiveSpeechRate: 1.35,
    });

    expect(plan.availableClockWindowMs).toBeCloseTo(2666.67, 1);
    expect(plan.neededRate).toBeCloseTo(1.875, 3);
    expect(plan.effectiveSpeechRate).toBe(1.35);
    expect(plan.overflowClockMs).toBeGreaterThan(1000);
  });

  it('predicts cumulative overflow across 4 consecutive dense segments and intervenes proactively', () => {
    const denseSegments: SpeechSegment[] = [0, 1, 2, 3].map((i) => ({
      segmentIndex: i,
      segmentId: `seg-${i}`,
      sourceCueIds: [`c-${i}`],
      startMs: i * 3000,
      endMs: (i + 1) * 3000,
      nextSegmentStartMs: (i + 1) * 3000,
      sourceText: 'Dense technical sentence',
      translatedText: 'Câu kỹ thuật tiếng Việt dài hơn thời lượng gốc đáng kể',
      audioDurationMs: 4500, // 4.5s speech inside a tight 3.0s slot repeatedly
      configVersion: 'v1',
      status: 'READY',
    }));

    const learningResult = predictLookaheadDrift({
      nowClockMs: 1000,
      currentVideoTimeMs: 0,
      userVideoRate: 1.0,
      prevAudioEndClockMs: 0,
      upcomingSegments: denseSegments,
      syncMode: 'LEARNING_HOLD_VIDEO',
    });

    expect(learningResult.predictedCumulativeDriftClockMs).toBeGreaterThan(1500);
    expect(learningResult.recommendedAction).toBe('HOLD_VIDEO_AT_BOUNDARY');
    expect(learningResult.recommendedVideoRateMultiplier).toBeLessThan(1.0);

    const strictResult = predictLookaheadDrift({
      nowClockMs: 1000,
      currentVideoTimeMs: 0,
      userVideoRate: 1.0,
      prevAudioEndClockMs: 0,
      upcomingSegments: denseSegments,
      syncMode: 'STRICT_VIDEO_SPEED',
    });

    expect(strictResult.recommendedAction).toBe('WARN_DRIFT_ONLY');
    expect(strictResult.recommendedVideoRateMultiplier).toBe(1.0);
  });

  it('keeps baseline speech crisp at 1.00x (never < 1.0x) while bridging continuous segments seamlessly', () => {
    // 3.0s WAV inside a 4.0s continuous cue stays at crystal-clear 1.00x (never distorted at 0.8x)
    const continuousPlan = planSegmentDualClock({
      nowClockMs: 0,
      currentVideoTimeMs: 0,
      videoRate: 1.0,
      prevAudioEndClockMs: 0,
      segmentStartVideoMs: 0,
      segmentEndVideoMs: 4000,
      nextSegmentStartVideoMs: 4050,
      audioDurationMs: 3000,
      minEffectiveSpeechRate: 1.0,
      maxEffectiveSpeechRate: 1.2,
      flowProfile: 'CONTINUOUS_FLOW',
      syllableCount: 15,
    });

    expect(continuousPlan.effectiveSpeechRate).toBe(1.0);
    expect(continuousPlan.actualAudioDurationClockMs).toBe(3000);

    // Next continuous segment bridges cleanly via allowEarlyLeadInClockMs without slowing voice below 1.0x
    const bridgedNextPlan = planSegmentDualClock({
      nowClockMs: 3750,
      currentVideoTimeMs: 3750,
      videoRate: 1.0,
      prevAudioEndClockMs: 3750,
      segmentStartVideoMs: 4050,
      segmentEndVideoMs: 8000,
      nextSegmentStartVideoMs: 8100,
      audioDurationMs: 3200,
      minEffectiveSpeechRate: 1.0,
      maxEffectiveSpeechRate: 1.2,
      flowProfile: 'CONTINUOUS_FLOW',
      syllableCount: 16,
      allowEarlyLeadInClockMs: 420,
      minBreathGapClockMs: 160,
    });

    expect(bridgedNextPlan.actualStartClockMs).toBe(3910);
    expect(bridgedNextPlan.effectiveSpeechRate).toBe(1.0);
  });
});
