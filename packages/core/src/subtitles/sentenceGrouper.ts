import { sha256Hex } from '../cache/cacheKey';
import type { SegmentFlowProfile, SpeechSegment, SubtitleCue } from '../contracts/subtitle';

export interface SentenceGrouperOptions {
  maxGapMs?: number;             // Max silence gap allowed when merging mid-sentence cues (default 700ms)
  maxSegmentDurationMs?: number; // Target max segment span for fluent full-sentence prosody (default 12_000ms)
  maxWordsPerSegment?: number;   // Cap word count per segment for natural breath pacing (default 36 words)
  configVersion?: string;
}

interface TimedTextSpan {
  cueId: string;
  startMs: number;
  endMs: number;
  text: string;
  softenPrevPeriodOnJoin?: boolean;
}

const STRONG_SENTENCE_END = /[.?!…]["')\]]*$/;
const PLAIN_PERIOD_END = /\.\s*["')\]]*$/;
const ELLIPSIS_END = /(?:\.\.\.|…)\s*["')\]]*$/;
const CLAUSE_BREAK_END = /[,;:—–]["')\]]*$/;
const SPEAKER_CHANGE_START = /^(-\s+|>>\s*|\[[^\]]+\]:?\s*|[A-Z][A-Z0-9 _]{1,18}:\s+)/;
const CONJUNCTION_START =
  /^(and|but|or|because|so|which|that|when|while|if|although|then|now|here|where|however|first|next|finally|also|let's|let us|alright|okay)\b/i;
const ASR_DISCOURSE_BREAK_START =
  /^(so|and so|and then|now|because|but|however|first|second|next|finally|also|let's|let us|alright|okay|if we|if you|when we|when you|here we|in this)\b/i;
const DANGLING_FUNCTION_TAIL =
  /\b(?:to|of|in|on|at|for|with|from|by|about|into|onto|between|through|the|a|an|this|that|these|those|my|our|your|his|her|its|their|is|are|was|were|be|been|have|has|had|do|does|did|will|would|can|could|should|must|and|or|but|so|if|when|while|because|very|really|quite|more|most|going|want|need|how|what|where|who)$/i;
const ELLIPTICAL_LIST_CONTINUATION_START =
  /^(or|nor|such as|including|especially|for example|for instance)\b/i;
const SHORT_NOUN_FRAGMENT =
  /^(a|an|the|some|other|more|another)\s+[a-z0-9][a-z0-9 -]*[.?!]?$/i;
const NON_BREAKING_ABBREV =
  /\b(?:e\.g|i\.e|vs|etc|mr|mrs|ms|dr|prof|st|jr|sr|fig|no|vol|inc|ltd|approx|min|max)$/i;

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function computeAcousticSpanWeight(spanText: string): number {
  const alphaNumChars = (spanText.match(/[A-Za-z0-9À-ỹ]/g) ?? []).length;
  const commas = (spanText.match(/[,;:—–]/g) ?? []).length;
  const strongEnds = (spanText.match(/[.?!…]+/g) ?? []).length;
  return Math.max(1, alphaNumChars) + commas * 1.8 + strongEnds * 3.5;
}

/**
 * Splits a single VTT/SRT cue into sub-cue sentence spans when `.` / `?` / `!` / `…`
 * occurs mid-cue, projecting timestamps proportionally by acoustic character + pause weight.
 *
 * Example:
 * Cue [8000..12500] "explosions. Now let's open Unity."
 * -> Span A [8000..9380] "explosions." (merges backward with "to create realistic")
 * -> Span B [9380..12500] "Now let's open Unity." (starts cleanly at 9.38s!)
 */
export function splitCueIntoTimedSpans(cue: SubtitleCue): TimedTextSpan[] {
  const normalized = cue.rawText.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const parts: string[] = [];
  let sliceStart = 0;
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === '.' || ch === '?' || ch === '!' || ch === '…') {
      const punctStart = i;
      while (
        i + 1 < normalized.length &&
        (normalized[i + 1] === '.' ||
          normalized[i + 1] === '?' ||
          normalized[i + 1] === '!' ||
          normalized[i + 1] === '…')
      ) {
        i++;
      }
      const punctToken = normalized.slice(punctStart, i + 1);

      while (i + 1 < normalized.length && /["')\]]/.test(normalized[i + 1]!)) {
        i++;
      }

      const nextIdx = i + 1;
      if (nextIdx < normalized.length && /\s/.test(normalized[nextIdx]!)) {
        let afterSpace = nextIdx;
        while (afterSpace < normalized.length && /\s/.test(normalized[afterSpace]!)) {
          afterSpace++;
        }

        if (afterSpace < normalized.length) {
          const prefixBeforePunct = normalized.slice(sliceStart, punctStart).trim();
          const remainder = normalized.slice(afterSpace);
          const isSingleDot = punctToken === '.';
          const isAbbrev = isSingleDot && NON_BREAKING_ABBREV.test(prefixBeforePunct);
          const isSingleInitial =
            isSingleDot &&
            /(?:^|\s)[A-Z]$/.test(prefixBeforePunct) &&
            /^[A-Z]/.test(remainder);
          const startsValidNextSentence = /^["'(\[-]*[A-Z0-9À-Ỹ]/.test(remainder);

          if (!isAbbrev && !isSingleInitial && startsValidNextSentence && prefixBeforePunct.length > 0) {
            parts.push(normalized.slice(sliceStart, i + 1).trim());
            sliceStart = afterSpace;
            i = afterSpace;
            continue;
          }
        }
      }
    }
    i++;
  }

  const tail = normalized.slice(sliceStart).trim();
  if (tail) {
    parts.push(tail);
  }

  if (parts.length <= 1) {
    return [
      {
        cueId: cue.cueId,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: normalized,
      },
    ];
  }

  const weights = parts.map(computeAcousticSpanWeight);
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  const totalDurationMs = Math.max(0, cue.endMs - cue.startMs);

  const spans: TimedTextSpan[] = [];
  let cumulativeWeight = 0;
  let cursorStartMs = cue.startMs;

  for (let p = 0; p < parts.length; p++) {
    cumulativeWeight += weights[p]!;
    const isLast = p === parts.length - 1;
    const interpolatedEndMs = isLast
      ? cue.endMs
      : Math.max(
          cursorStartMs + 80,
          Math.min(cue.endMs, Math.round(cue.startMs + totalDurationMs * (cumulativeWeight / totalWeight))),
        );

    spans.push({
      cueId: cue.cueId,
      startMs: cursorStartMs,
      endMs: interpolatedEndMs,
      text: parts[p]!,
    });
    cursorStartMs = interpolatedEndMs;
  }

  return spans;
}

function joinSpansIntoText(group: TimedTextSpan[]): string {
  if (group.length === 0) return '';
  let result = group[0]!.text.trim();

  for (let i = 1; i < group.length; i++) {
    const span = group[i]!;
    let nextText = span.text.trim();
    if (!nextText) continue;

    if (span.softenPrevPeriodOnJoin) {
      // Smooth ASR false full-stop inside continuous list/enumeration (e.g. "explosions. A smoke. Or a fire simulation.")
      // into natural comma prosody without dropping a single word (Invariant I1).
      result = result.replace(/\.\s*(["')\]]*)$/, ',$1');
      if (/^[A-Z](?:[a-z]|\s)/.test(nextText) && !/^I\b/.test(nextText)) {
        nextText = nextText[0]!.toLowerCase() + nextText.slice(1);
      }
    }

    result = `${result} ${nextText}`;
  }

  return result.replace(/\s+/g, ' ').trim();
}

function classifyFlowProfile(params: {
  wordCount: number;
  durationMs: number;
  continuesImmediately: boolean;
  continuedFromPrev: boolean;
}): SegmentFlowProfile {
  const { wordCount, durationMs, continuesImmediately, continuedFromPrev } = params;

  if (wordCount <= 4 || ((wordCount <= 6 || durationMs < 2_400) && !continuesImmediately)) {
    return 'SHORT_UTTERANCE';
  }

  if (
    continuesImmediately ||
    (continuedFromPrev && wordCount >= 7) ||
    (durationMs >= 5_000 && wordCount >= 11)
  ) {
    return 'CONTINUOUS_FLOW';
  }

  return 'STANDALONE_NORMAL';
}

export function groupCuesIntoSegments(
  cues: SubtitleCue[],
  options: SentenceGrouperOptions = {},
): SpeechSegment[] {
  if (cues.length === 0) return [];

  const maxGapMs = options.maxGapMs ?? 700;
  const maxSegmentDurationMs = options.maxSegmentDurationMs ?? 12_000;
  const maxWordsPerSegment = options.maxWordsPerSegment ?? 36;
  const configVersion = options.configVersion ?? 'default';

  // 1. Project multi-sentence cues onto sub-cue timed spans so cross-cue enjambments
  //    (e.g. "...create realistic" + "explosions. Next sentence...") align to true sentence boundaries.
  const timedSpans: TimedTextSpan[] = [];
  for (const cue of cues) {
    timedSpans.push(...splitCueIntoTimedSpans(cue));
  }
  if (timedSpans.length === 0) return [];

  const rawGroups: TimedTextSpan[][] = [];
  let currentGroup: TimedTextSpan[] = [];

  for (let i = 0; i < timedSpans.length; i++) {
    const span = { ...timedSpans[i]! };
    if (currentGroup.length === 0) {
      currentGroup.push(span);
      continue;
    }

    const prevSpan = currentGroup[currentGroup.length - 1]!;
    const firstSpan = currentGroup[0]!;
    const gapMs = Math.max(0, span.startMs - prevSpan.endMs);
    const currentText = joinSpansIntoText(currentGroup);
    const currentWords = countWords(currentText);
    const currentDurationMs = Math.max(0, prevSpan.endMs - firstSpan.startMs);

    const spanWords = countWords(span.text);
    const spanDurationMs = Math.max(0, span.endMs - span.startMs);
    const combinedDurationMs = Math.max(0, span.endMs - firstSpan.startMs);
    const combinedWords = currentWords + spanWords;

    const prevTrimmed = prevSpan.text.trim();
    const nextTrimmed = span.text.trim();
    const prevEndedSentence = STRONG_SENTENCE_END.test(prevTrimmed);
    const prevEndedPlainPeriod =
      PLAIN_PERIOD_END.test(prevTrimmed) && !ELLIPSIS_END.test(prevTrimmed);
    const prevEndedClause = CLAUSE_BREAK_END.test(prevTrimmed);
    const prevHasDanglingTail =
      !prevEndedSentence && !prevEndedClause && DANGLING_FUNCTION_TAIL.test(prevTrimmed);
    const nextChangesSpeaker = SPEAKER_CHANGE_START.test(nextTrimmed);
    const nextStartsConjunction = CONJUNCTION_START.test(nextTrimmed);
    const nextStartsAsrDiscourse = ASR_DISCOURSE_BREAK_START.test(nextTrimmed);

    const withinCeiling =
      combinedDurationMs <= maxSegmentDurationMs && combinedWords <= maxWordsPerSegment;
    const withinDanglingGraceCeiling =
      prevHasDanglingTail &&
      combinedDurationMs <= maxSegmentDurationMs + 2_200 &&
      combinedWords <= maxWordsPerSegment + 5;

    // Detect ASR false period inside an ongoing list or elliptical phrase (e.g. "A smoke.", "Or a fire simulation.")
    const isEllipticalContinuation =
      prevEndedPlainPeriod &&
      !nextChangesSpeaker &&
      gapMs <= 320 &&
      withinCeiling &&
      ((ELLIPTICAL_LIST_CONTINUATION_START.test(nextTrimmed) && spanWords <= 10) ||
        (spanWords <= 3 && spanDurationMs <= 1_850 && SHORT_NOUN_FRAGMENT.test(nextTrimmed)));

    // Merge ultra-brief lead-in sentence spoken in the exact same breath (e.g. "Alright." + "Let's configure it.")
    const isSameBreathMicroLeadIn =
      prevEndedSentence &&
      !nextChangesSpeaker &&
      gapMs <= 220 &&
      withinCeiling &&
      currentWords <= 3 &&
      currentDurationMs <= 1_800;

    let shouldFlush = false;

    if (nextChangesSpeaker) {
      shouldFlush = true;
    } else if (prevEndedSentence) {
      if (isEllipticalContinuation) {
        span.softenPrevPeriodOnJoin = true;
        shouldFlush = false;
      } else if (isSameBreathMicroLeadIn) {
        shouldFlush = false;
      } else {
        shouldFlush = true;
      }
    } else if (gapMs > maxGapMs) {
      shouldFlush = true;
    } else if (
      !prevHasDanglingTail &&
      nextStartsAsrDiscourse &&
      !prevEndedClause &&
      (currentWords >= 14 || currentDurationMs >= 4_800)
    ) {
      // Clean clause boundary for unpunctuated YouTube ASR auto-captions
      shouldFlush = true;
    } else if (
      !prevHasDanglingTail &&
      gapMs >= 280 &&
      (currentWords >= 12 || currentDurationMs >= 4_200)
    ) {
      // Natural speaker breath pause on unpunctuated auto-captions
      shouldFlush = true;
    } else if (
      !prevHasDanglingTail &&
      (prevEndedClause || nextStartsConjunction) &&
      (combinedDurationMs >= 8_200 || combinedWords >= 25)
    ) {
      shouldFlush = true;
    } else if (!withinCeiling && !withinDanglingGraceCeiling) {
      shouldFlush = true;
    }

    if (shouldFlush) {
      rawGroups.push(currentGroup);
      currentGroup = [span];
    } else {
      currentGroup.push(span);
    }
  }

  if (currentGroup.length > 0) {
    rawGroups.push(currentGroup);
  }

  return rawGroups.map((group, index) => {
    const startMs = group[0]!.startMs;
    const endMs = group[group.length - 1]!.endMs;
    const prevGroup = index > 0 ? rawGroups[index - 1] : undefined;
    const nextGroup = rawGroups[index + 1];

    const prevEndMs = prevGroup ? prevGroup[prevGroup.length - 1]!.endMs : null;
    const nextSegmentStartMs = nextGroup ? nextGroup[0]!.startMs : null;
    const gapFromPrevMs = prevEndMs !== null ? Math.max(0, startMs - prevEndMs) : null;
    const gapToNextMs = nextSegmentStartMs !== null ? Math.max(0, nextSegmentStartMs - endMs) : null;

    const continuesImmediately = gapToNextMs !== null && gapToNextMs <= 500;
    const continuedFromPrev = gapFromPrevMs !== null && gapFromPrevMs <= 500;

    const sourceText = joinSpansIntoText(group);
    const wordCount = countWords(sourceText);
    const durationMs = Math.max(0, endMs - startMs);

    const flowProfile = classifyFlowProfile({
      wordCount,
      durationMs,
      continuesImmediately,
      continuedFromPrev,
    });

    const uniqueCueIds = Array.from(new Set(group.map((s) => s.cueId)));
    const segmentId = `seg-${index}-${sha256Hex(`${startMs}:${endMs}:${sourceText}`).slice(0, 12)}`;

    return {
      segmentIndex: index,
      segmentId,
      sourceCueIds: uniqueCueIds,
      startMs,
      endMs,
      nextSegmentStartMs,
      gapFromPrevMs,
      gapToNextMs,
      continuesImmediately,
      flowProfile,
      sourceText,
      configVersion,
      status: 'UNPROCESSED',
    };
  });
}
