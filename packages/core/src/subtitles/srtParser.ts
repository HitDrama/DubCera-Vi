import type { SubtitleCue } from '../contracts/subtitle';
import { cleanSubtitleText, deduplicateRollingCues, parseTimestampToMs } from './vttParser';

export function parseSrt(srtContent: string): SubtitleCue[] {
  const normalized = srtContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  let cueCounter = 0;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const timingLineIdx = lines.findIndex((line) => line.includes('-->'));
    if (timingLineIdx === -1) continue;

    const timingLine = lines[timingLineIdx]!;
    const arrowParts = timingLine.split('-->');
    if (arrowParts.length < 2) continue;

    const startRaw = arrowParts[0]!.trim();
    const endRaw = arrowParts[1]!.trim().split(/\s+/)[0]!;

    let startMs: number;
    let endMs: number;
    try {
      startMs = parseTimestampToMs(startRaw);
      endMs = parseTimestampToMs(endRaw);
    } catch {
      continue;
    }

    if (endMs <= startMs) continue;

    const rawText = cleanSubtitleText(lines.slice(timingLineIdx + 1).join('\n'));
    if (!rawText) continue;

    cueCounter += 1;
    const explicitId = timingLineIdx > 0 ? lines[0]! : undefined;
    cues.push({
      cueId: explicitId && /^\d+$/.test(explicitId) ? `srt-${explicitId}` : `cue-${cueCounter}`,
      startMs,
      endMs,
      rawText,
    });
  }

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return deduplicateRollingCues(cues);
}
