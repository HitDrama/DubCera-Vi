import type { SpeechSegment } from '../contracts/subtitle';

export type QueueTier = 'P0_URGENT' | 'P1_BACKGROUND';

export interface PrioritizedSegmentTask {
  segmentIndex: number;
  segmentId: string;
  tier: QueueTier;
  distanceVideoMs: number;
}

export interface QueuePrioritizationOptions {
  urgentWindowVideoMs?: number;   // Default 30_000ms ahead of playhead
  urgentMinCount?: number;        // Ensure at least 4 upcoming segments are P0
  maxLookaheadVideoMs?: number;   // Optional sliding lookahead cap (e.g. 45_000ms) so 3h videos never run unboundedly
  maxLookaheadCount?: number;     // Optional max forward segment count cap (e.g. 6-12 segments)
  includeBackfill?: boolean;      // Whether to queue earlier segments behind playhead (default true)
}

/**
 * Builds a seek-aware, two-tier work queue excluding segments that are already `READY` for `activeConfigVersion`.
 * Supports optional sliding lookahead caps so long 3-hour lectures only process segments near the active playhead.
 */
export function buildPreemptiveQueue(
  segments: ReadonlyArray<SpeechSegment>,
  playheadVideoMs: number,
  activeConfigVersion: string,
  options: QueuePrioritizationOptions = {},
): PrioritizedSegmentTask[] {
  const urgentWindowVideoMs = options.urgentWindowVideoMs ?? 30_000;
  const urgentMinCount = options.urgentMinCount ?? 4;
  const maxLookaheadVideoMs = options.maxLookaheadVideoMs;
  const maxLookaheadCount = options.maxLookaheadCount;
  const includeBackfill = options.includeBackfill ?? true;

  const pending = segments.filter(
    (s) => !(s.status === 'READY' && s.configVersion === activeConfigVersion),
  );

  if (pending.length === 0) return [];

  const forwardOrCurrent: SpeechSegment[] = [];
  const earlierBackfill: SpeechSegment[] = [];

  for (const seg of pending) {
    if (seg.endMs > playheadVideoMs) {
      forwardOrCurrent.push(seg);
    } else if (includeBackfill) {
      earlierBackfill.push(seg);
    }
  }

  forwardOrCurrent.sort((a, b) => a.segmentIndex - b.segmentIndex);
  earlierBackfill.sort((a, b) => a.segmentIndex - b.segmentIndex);

  const tasks: PrioritizedSegmentTask[] = [];

  for (let idx = 0; idx < forwardOrCurrent.length; idx++) {
    const seg = forwardOrCurrent[idx]!;
    const distanceVideoMs = Math.max(0, seg.startMs - playheadVideoMs);

    if (maxLookaheadCount !== undefined && tasks.length >= maxLookaheadCount) {
      break;
    }
    if (
      maxLookaheadVideoMs !== undefined &&
      tasks.length >= Math.min(2, urgentMinCount) &&
      distanceVideoMs > maxLookaheadVideoMs
    ) {
      break;
    }

    const isUrgent = idx < urgentMinCount || distanceVideoMs <= urgentWindowVideoMs;
    tasks.push({
      segmentIndex: seg.segmentIndex,
      segmentId: seg.segmentId,
      tier: isUrgent ? 'P0_URGENT' : 'P1_BACKGROUND',
      distanceVideoMs,
    });
  }

  if (includeBackfill) {
    for (const seg of earlierBackfill) {
      tasks.push({
        segmentIndex: seg.segmentIndex,
        segmentId: seg.segmentId,
        tier: 'P1_BACKGROUND',
        distanceVideoMs: Math.abs(playheadVideoMs - seg.startMs),
      });
    }
  }

  return tasks;
}
