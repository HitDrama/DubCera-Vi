import { sha256Hex } from '../cache/cacheKey';
import type { SpeechSegment, SubtitleCue } from '../contracts/subtitle';

export interface SentenceGrouperOptions {
  maxGapMs?: number;             // Max silence gap allowed when merging mid-sentence cues (default 500ms)
  maxSegmentDurationMs?: number; // Target max segment span so seek-to-cue-start stays tight & responsive (default 7_500ms)
  maxWordsPerSegment?: number;   // Cap word count per segment for natural breath pacing (default 24 words)
  configVersion?: string;
}

const STRONG_SENTENCE_END = /[.?!…]["')\]]*$/;
const CLAUSE_BREAK_END = /[,;:—–]["')\]]*$/;
const SPEAKER_CHANGE_START = /^(-\s+|>>\s*|\[[^\]]+\]:?\s*|[A-Z][A-Z0-9 _]{1,18}:\s+)/;
const CONJUNCTION_START = /^(and|but|or|because|so|which|that|when|while|if|although|then|now|here|where)\b/i;

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function groupCuesIntoSegments(
  cues: SubtitleCue[],
  options: SentenceGrouperOptions = {},
): SpeechSegment[] {
  if (cues.length === 0) return [];

  const maxGapMs = options.maxGapMs ?? 500;
  const maxSegmentDurationMs = options.maxSegmentDurationMs ?? 7_500;
  const maxWordsPerSegment = options.maxWordsPerSegment ?? 24;
  const configVersion = options.configVersion ?? 'default';

  const rawGroups: SubtitleCue[][] = [];
  let currentGroup: SubtitleCue[] = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (currentGroup.length === 0) {
      currentGroup.push(cue);
      continue;
    }

    const prevCue = currentGroup[currentGroup.length - 1]!;
    const firstCue = currentGroup[0]!;
    const gapMs = Math.max(0, cue.startMs - prevCue.endMs);
    const combinedText = `${currentGroup.map((c) => c.rawText).join(' ')} ${cue.rawText}`;
    const combinedDurationMs = cue.endMs - firstCue.startMs;
    const combinedWords = countWords(combinedText);

    const prevEndedSentence = STRONG_SENTENCE_END.test(prevCue.rawText.trim());
    const prevEndedClause = CLAUSE_BREAK_END.test(prevCue.rawText.trim());
    const nextChangesSpeaker = SPEAKER_CHANGE_START.test(cue.rawText.trim());
    const nextStartsConjunction = CONJUNCTION_START.test(cue.rawText.trim());

    let shouldFlush = false;

    if (nextChangesSpeaker) {
      shouldFlush = true;
    } else if (prevEndedSentence) {
      shouldFlush = true;
    } else if (gapMs > maxGapMs) {
      shouldFlush = true;
    } else if ((prevEndedClause || nextStartsConjunction) && (combinedDurationMs >= 4_500 || combinedWords >= 15)) {
      // Natural breath/clause split so unpunctuated auto-captions stay crisp 4-7s units
      shouldFlush = true;
    } else if (combinedDurationMs > maxSegmentDurationMs || combinedWords > maxWordsPerSegment) {
      shouldFlush = true;
    }

    if (shouldFlush) {
      rawGroups.push(currentGroup);
      currentGroup = [cue];
    } else {
      currentGroup.push(cue);
    }
  }

  if (currentGroup.length > 0) {
    rawGroups.push(currentGroup);
  }

  return rawGroups.map((group, index) => {
    const startMs = group[0]!.startMs;
    const endMs = group[group.length - 1]!.endMs;
    const nextGroup = rawGroups[index + 1];
    const sourceText = group
      .map((c) => c.rawText.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const segmentId = `seg-${index}-${sha256Hex(`${startMs}:${endMs}:${sourceText}`).slice(0, 12)}`;

    return {
      segmentIndex: index,
      segmentId,
      sourceCueIds: group.map((c) => c.cueId),
      startMs,
      endMs,
      nextSegmentStartMs: nextGroup ? nextGroup[0]!.startMs : null,
      sourceText,
      configVersion,
      status: 'UNPROCESSED',
    };
  });
}
