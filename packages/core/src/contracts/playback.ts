export type PlaybackIntent = 'PLAY' | 'PAUSE';

export type SyncMode = 'LEARNING_HOLD_VIDEO' | 'STRICT_VIDEO_SPEED';

export type SubtitleDisplayMode = 'VI_ONLY' | 'BILINGUAL' | 'OFF';

export type HardwareProfilePreference = 'AUTO' | 'GPU_TURBO' | 'CPU_ECO' | 'CLOUD_HYBRID';

export interface PlaybackState {
  intent: PlaybackIntent;
  isBuffering: boolean;
  sessionId: number;
  userActionRevision: number;
  autoplayBlocked: boolean;
  activeSegmentIndex: number | null;
}

export interface DualClockScheduleInput {
  nowClockMs: number;           // audioClockMs axis (performance.now / AudioContext)
  currentVideoTimeMs: number;   // videoTimeMs axis (video.currentTime * 1000)
  videoRate: number;            // video.playbackRate (e.g. 1.0, 1.25, 1.5)
  prevAudioEndClockMs: number;  // audioClockMs axis when previous segment finished
  segmentStartVideoMs: number;
  segmentEndVideoMs: number;
  nextSegmentStartVideoMs: number | null;
  audioDurationMs: number;      // Real 1.0x PCM duration
  maxEffectiveSpeechRate?: number;
  minBreathGapClockMs?: number;
  maxSilenceBorrowVideoMs?: number;
}

export interface SegmentSchedulePlan {
  targetStartClockMs: number;
  actualStartClockMs: number;
  usableEndClockMs: number;
  availableClockWindowMs: number;
  neededRate: number;
  effectiveSpeechRate: number;
  actualAudioDurationClockMs: number;
  expectedEndClockMs: number;
  overflowClockMs: number;      // > 0 when even at maxEffectiveSpeechRate audio exceeds usableEndClockMs
}

export type DriftInterventionAction =
  | 'NONE'
  | 'SPEED_UP_LIGHT'
  | 'BORROW_AND_SLOW_VIDEO'
  | 'HOLD_VIDEO_AT_BOUNDARY'
  | 'WARN_DRIFT_ONLY';

export interface DriftPredictionResult {
  predictedCumulativeDriftClockMs: number;
  recommendedAction: DriftInterventionAction;
  recommendedVideoRateMultiplier: number; // 1.0 normal, e.g. 0.88 when slowing video slightly
}
