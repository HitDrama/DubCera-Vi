export interface SubtitleCue {
  cueId: string;
  startMs: number; // videoTimeMs axis
  endMs: number;   // videoTimeMs axis
  rawText: string;
}

export interface DisplayChunk {
  chunkId: string;
  text: string;
  sourceExcerpt?: string;
  weightRatio: number; // Sums to 1.0 across all chunks of a SpeechSegment
  alignedStartOffsetMs?: number;
  alignedEndOffsetMs?: number;
}

export type SegmentStatus =
  | 'UNPROCESSED'
  | 'TRANSLATING'
  | 'TRANSLATED'
  | 'SYNTHESIZING'
  | 'READY'
  | 'ERROR';

export type SegmentFlowProfile =
  | 'CONTINUOUS_FLOW'
  | 'STANDALONE_NORMAL'
  | 'SHORT_UTTERANCE';

export interface SpeechSegment {
  segmentIndex: number;
  segmentId: string;
  sourceCueIds: string[];
  startMs: number;              // videoTimeMs axis (interpolated at sub-cue precision when split)
  endMs: number;                // videoTimeMs axis (interpolated at sub-cue precision when split)
  nextSegmentStartMs: number | null;
  gapFromPrevMs?: number | null;
  gapToNextMs?: number | null;
  continuesImmediately?: boolean;
  flowProfile?: SegmentFlowProfile;
  sourceText: string;
  translatedText?: string;
  displayChunks?: DisplayChunk[];
  configVersion: string;
  audioCacheKey?: string;
  audioDurationMs?: number;     // Measured real WAV duration at 1.0x
  status: SegmentStatus;
  errorMessage?: string;
}
