import type { DisplayChunk } from '../contracts/subtitle';

export interface DisplayChunkerOptions {
  maxWordsPerChunk?: number; // Default 16 words (~1-2 concise subtitle lines)
  minWordsPerChunk?: number; // Avoid orphan 1-2 word trailing chunks
}

const VIETNAMESE_BREAK_CONNECTORS = new Set([
  'nhưng',
  'hoặc',
  'vì',
  'nên',
  'để',
  'khi',
  'nếu',
  'mà',
  'rồi',
  'sau',
  'trước',
  'bằng',
  'trong',
  'với',
]);

function computeChunkAcousticWeight(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let weight = words.length;
  for (const ch of text) {
    if (ch === ',' || ch === ';' || ch === ':') weight += 0.6;
    else if (ch === '.' || ch === '?' || ch === '!' || ch === '—') weight += 0.9;
  }
  return Math.max(1, weight);
}

/**
 * Splits a full `SpeechSegment.translatedText` into compact 1-2 line `DisplayChunk[]`
 * so long sentences (40-60 words) never cover Unity Inspector / code editors.
 */
export function splitIntoDisplayChunks(
  segmentId: string,
  translatedText: string,
  sourceText?: string,
  options: DisplayChunkerOptions = {},
): DisplayChunk[] {
  const cleaned = translatedText.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const maxWords = options.maxWordsPerChunk ?? 16;
  const minWords = options.minWordsPerChunk ?? 4;
  const words = cleaned.split(' ');

  if (words.length <= maxWords) {
    return [
      {
        chunkId: `${segmentId}-c0`,
        text: cleaned,
        sourceExcerpt: sourceText,
        weightRatio: 1.0,
      },
    ];
  }

  const rawTextChunks: string[] = [];
  let cursor = 0;

  while (cursor < words.length) {
    const remaining = words.length - cursor;
    if (remaining <= maxWords) {
      rawTextChunks.push(words.slice(cursor).join(' '));
      break;
    }

    let bestEnd = Math.min(words.length, cursor + maxWords);
    const searchStart = Math.max(cursor + minWords, cursor + Math.floor(maxWords * 0.55));

    // 1. Prefer punctuation breaks (, ; : . ? !) within [searchStart .. bestEnd]
    let foundPunctBreak = -1;
    for (let i = bestEnd - 1; i >= searchStart - 1; i--) {
      const token = words[i]!;
      if (/[,;:.?!—–]$/.test(token)) {
        foundPunctBreak = i + 1;
        break;
      }
    }

    if (foundPunctBreak !== -1) {
      bestEnd = foundPunctBreak;
    } else {
      // 2. Otherwise prefer breaking right before a Vietnamese clause connector
      for (let i = bestEnd; i >= searchStart; i--) {
        const cleanNext = words[i]?.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '') ?? '';
        if (VIETNAMESE_BREAK_CONNECTORS.has(cleanNext)) {
          bestEnd = i;
          break;
        }
      }
    }

    // Prevent leaving a tiny orphan tail (e.g. 2 words left at the very end)
    if (words.length - bestEnd > 0 && words.length - bestEnd < minWords) {
      bestEnd = words.length - minWords;
    }

    rawTextChunks.push(words.slice(cursor, bestEnd).join(' '));
    cursor = bestEnd;
  }

  // Also slice sourceText proportionally if bilingual mode needs source excerpts
  const sourceWords = sourceText ? sourceText.trim().split(/\s+/).filter(Boolean) : [];
  const weights = rawTextChunks.map(computeChunkAcousticWeight);
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  let sourceCursor = 0;
  let accumulatedRatio = 0;

  return rawTextChunks.map((chunkText, idx) => {
    const isLast = idx === rawTextChunks.length - 1;
    const rawRatio = weights[idx]! / totalWeight;
    const weightRatio = isLast
      ? Math.max(0.01, Number((1.0 - accumulatedRatio).toFixed(6)))
      : Number(rawRatio.toFixed(6));
    accumulatedRatio += weightRatio;

    let sourceExcerpt: string | undefined;
    if (sourceWords.length > 0) {
      if (isLast) {
        sourceExcerpt = sourceWords.slice(sourceCursor).join(' ');
      } else {
        const count = Math.max(1, Math.round(sourceWords.length * weightRatio));
        sourceExcerpt = sourceWords.slice(sourceCursor, sourceCursor + count).join(' ');
        sourceCursor += count;
      }
    }

    return {
      chunkId: `${segmentId}-c${idx}`,
      text: chunkText,
      sourceExcerpt,
      weightRatio,
    };
  });
}

/**
 * Given elapsed progress [0..1] inside a playing SpeechSegment, returns the active DisplayChunk.
 */
export function selectActiveDisplayChunk(
  chunks: DisplayChunk[],
  progressRatio: number,
): DisplayChunk | null {
  if (chunks.length === 0) return null;
  const clamped = Math.max(0, Math.min(0.999999, progressRatio));
  let cumulative = 0;
  for (const chunk of chunks) {
    cumulative += chunk.weightRatio;
    if (clamped < cumulative) return chunk;
  }
  return chunks[chunks.length - 1] ?? null;
}
