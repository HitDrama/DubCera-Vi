import type { DisplayChunk, SegmentStatus } from './subtitle';

export interface SynthesisConfigSnapshot {
  targetLang: string;
  voiceId: string;
  engineId: string;
  modelVersion: string;
  sampleRate: number;
  styleOrPitchConfig: string;
  pauseConfig: string;
}

export interface PersistedSegmentRecord {
  segmentIndex: number;
  segmentId: string;
  sourceCueIds: string[];
  startMs: number;
  endMs: number;
  nextSegmentStartMs: number | null;
  sourceText: string;
  translatedText?: string;
  displayChunks?: DisplayChunk[];
  configVersion: string;
  audioCacheKey?: string;
  audioDurationMs?: number;
  status: SegmentStatus;
}

export interface VideoManifestRecord {
  videoKey: string;
  platform: string;
  canonicalVideoId: string;
  subtitleHash: string;
  targetLang: string;
  activeConfigVersion: string;
  createdAtMs?: number;
  updatedAtMs: number;
  segments: PersistedSegmentRecord[];
}
