import type { SpeechSegment } from '../contracts/subtitle';

export type QueueTier = 'P0_URGENT' | 'P1_BACKGROUND';

export interface PrioritizedSegmentTask {
  segmentIndex: number;
  segmentId: string;
  tier: QueueTier;
  distanceVideoMs: number;
}

export interface QueuePrioritizationOptions {
  urgentWindowVideoMs?: number; // Default 30_000ms ahead of playhead
  urgentMinCount?: number;      // Ensure at least 4 upcoming segments are P0
}

/**
 * Builds a seek-aware, two-tier work queue excluding segments that are already `READY` for `activeConfigVersion`.
 * Order of execution:
 * 1. P0_URGENT: Segments at/ahead of playhead within urgentWindowVideoMs (or urgentMinCount), ordered sequentially.
 * 2. P1_BACKGROUND (Forward): Remaining segments from after P0 to the end of the video, ordered sequentially.
 * 3. P1_BACKGROUND (Backfill): Uncached segments earlier than playhead, ordered from closest/start to fill full-video cache.
 */
export function buildPreemptiveQueue(
  segments: ReadonlyArray<SpeechSegment>,
  playheadVideoMs: number,
  activeConfigVersion: string,
  options: QueuePrioritizationOptions = {},
): PrioritizedSegmentTask[] {
  const urgentWindowVideoMs = options.urgentWindowVideoMs ?? 30_000;
  const urgentMinCount = options.urgentMinCount ?? 4;

  const pending = segments.filter(
    (s) => !(s.status === 'READY' && s.configVersion === activeConfigVersion),
  );

  if (pending.length === 0) return [];

  const forwardOrCurrent: SpeechSegment[] = [];
  const earlierBackfill: SpeechSegment[] = [];

  for (const seg of pending) {
    if (seg.endMs > playheadVideoMs) {
      forwardOrCurrent.push(seg);
    } else {
      earlierBackfill.push(seg);
    }
  }

  forwardOrCurrent.sort((a, b) => a.segmentIndex - b.segmentIndex);
  earlierBackfill.sort((a, b) => a.segmentIndex - b.segmentIndex);

  const tasks: PrioritizedSegmentTask[] = [];

  forwardOrCurrent.forEach((seg, idx) => {
    const distanceVideoMs = Math.max(0, seg.startMs - playheadVideoMs);
    const isUrgent = idx < urgentMinCount || distanceVideoMs <= urgentWindowVideoMs;
    tasks.push({
      segmentIndex: seg.segmentIndex,
      segmentId: seg.segmentId,
      tier: isUrgent ? 'P0_URGENT' : 'P1_BACKGROUND',
      distanceVideoMs,
    });
  });

  for (const seg of earlierBackfill) {
    tasks.push({
      segmentIndex: seg.segmentIndex,
      segmentId: seg.segmentId,
      tier: 'P1_BACKGROUND',
      distanceVideoMs: Math.abs(playheadVideoMs - seg.startMs),
    });
  }

  return tasks;
}
