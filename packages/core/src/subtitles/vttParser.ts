import type { SubtitleCue } from '../contracts/subtitle';

const NON_SPEECH_PATTERN = /^(\[.*?(music|applause|laughter|silence|âm nhạc|vỗ tay).*?\]|\(.*?(music|applause|laughter|silence).*?\)|♪+.*♪*)$/i;
const SPRITE_OR_METADATA_CUE_PATTERN = /(?:#xywh=\d+,\d+,\d+,\d+|^[\w./-]+\.(?:jpe?g|png|webp|gif|avif)(?:[#?]\S*)?$)/i;

export function parseTimestampToMs(raw: string): number {
  const cleaned = raw.trim().replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid subtitle timestamp: "${raw}"`);
  }

  let hours = 0;
  let minutes = 0;
  let secondsFloat = 0;

  if (parts.length === 3) {
    hours = Number(parts[0]);
    minutes = Number(parts[1]);
    secondsFloat = Number(parts[2]);
  } else {
    minutes = Number(parts[0]);
    secondsFloat = Number(parts[1]);
  }

  if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(secondsFloat)) {
    throw new Error(`Malformed numeric timestamp: "${raw}"`);
  }

  return Math.round((hours * 3600 + minutes * 60 + secondsFloat) * 1000);
}

export function cleanSubtitleText(raw: string): string {
  const decoded = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');

  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !NON_SPEECH_PATTERN.test(line) &&
        !SPRITE_OR_METADATA_CUE_PATTERN.test(line),
    );

  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Deduplicate overlapping prefix text commonly emitted by YouTube rolling auto-captions:
 * e.g. Cue 1: "welcome to unity" -> Cue 2: "welcome to unity shader graph" => Cue 2 becomes "shader graph"
 */
export function deduplicateRollingCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) return cues;
  const result: SubtitleCue[] = [];

  for (const cue of cues) {
    const prev = result[result.length - 1];
    if (!prev) {
      result.push({ ...cue });
      continue;
    }

    const prevLower = prev.rawText.toLowerCase();
    const currLower = cue.rawText.toLowerCase();

    if (currLower === prevLower && cue.startMs - prev.endMs <= 500) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }

    if (currLower.startsWith(prevLower + ' ') && cue.startMs <= prev.endMs + 300) {
      const remainder = cue.rawText.slice(prev.rawText.length).trim();
      if (remainder.length > 0) {
        result.push({
          ...cue,
          startMs: Math.max(cue.startMs, prev.endMs),
          rawText: remainder,
        });
      }
      continue;
    }

    result.push({ ...cue });
  }

  return result;
}

function tryParseTimingLine(line: string): { startMs: number; endMs: number } | null {
  if (!line.includes('-->')) return null;
  const arrowParts = line.split('-->');
  if (arrowParts.length < 2) return null;

  const startRaw = arrowParts[0]!.trim();
  const endRaw = arrowParts[1]!.trim().split(/\s+/)[0]!;
  if (!startRaw || !endRaw) return null;

  try {
    const startMs = parseTimestampToMs(startRaw);
    const endMs = parseTimestampToMs(endRaw);
    if (endMs <= startMs) return null;
    return { startMs, endMs };
  } catch {
    return null;
  }
}

export function parseVtt(vttContent: string): SubtitleCue[] {
  const normalized = vttContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const rawLines = normalized.split('\n');
  const cues: SubtitleCue[] = [];
  let cueCounter = 0;

  let skippingMetadataBlock = false;
  let pendingId: string | undefined;
  let activeCue: {
    explicitId?: string;
    startMs: number;
    endMs: number;
    textLines: string[];
  } | null = null;

  const flushActiveCue = (): void => {
    if (!activeCue) return;
    const rawText = cleanSubtitleText(activeCue.textLines.join('\n'));
    if (rawText) {
      cueCounter += 1;
      const validExplicitId =
        activeCue.explicitId && !activeCue.explicitId.includes(' ')
          ? activeCue.explicitId
          : undefined;
      cues.push({
        cueId: validExplicitId ?? `cue-${cueCounter}`,
        startMs: activeCue.startMs,
        endMs: activeCue.endMs,
        rawText,
      });
    }
    activeCue = null;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i]!.trim();

    if (!trimmed) {
      flushActiveCue();
      skippingMetadataBlock = false;
      pendingId = undefined;
      continue;
    }

    if (skippingMetadataBlock) {
      continue;
    }

    const upper = trimmed.toUpperCase();
    if (!activeCue) {
      if (upper.startsWith('WEBVTT') || upper.startsWith('X-TIMESTAMP-MAP')) {
        pendingId = undefined;
        continue;
      }
      if (upper.startsWith('NOTE') || upper.startsWith('STYLE') || upper.startsWith('REGION')) {
        skippingMetadataBlock = true;
        pendingId = undefined;
        continue;
      }
    }

    const timing = tryParseTimingLine(trimmed);
    if (timing) {
      flushActiveCue();
      activeCue = {
        explicitId: pendingId,
        startMs: timing.startMs,
        endMs: timing.endMs,
        textLines: [],
      };
      pendingId = undefined;
      continue;
    }

    // Handle compact single-newline VTT where a numeric cue index precedes the next `-->` line without a blank line
    const nextTrimmed = i + 1 < rawLines.length ? rawLines[i + 1]!.trim() : '';
    const isStandaloneCueIndex =
      (!activeCue || (activeCue.textLines.length > 0 && /^\d+$/.test(trimmed))) &&
      Boolean(nextTrimmed && tryParseTimingLine(nextTrimmed));
    if (isStandaloneCueIndex) {
      flushActiveCue();
      pendingId = trimmed;
      continue;
    }

    if (activeCue) {
      activeCue.textLines.push(trimmed);
    } else {
      pendingId = trimmed;
    }
  }

  flushActiveCue();

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return deduplicateRollingCues(cues);
}
