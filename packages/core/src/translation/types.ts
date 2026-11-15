import type { GlossaryEntry } from './glossary';

export interface TranslationSegmentItem {
  segmentId: string;
  sourceText: string;
  durationMs?: number;
}

export interface TranslationBatchRequest {
  sourceLang: string; // e.g. 'en' or 'auto'
  targetLang: string; // e.g. 'vi'
  videoTitle?: string;
  contextBefore: string[];
  items: TranslationSegmentItem[];
  glossary?: ReadonlyArray<GlossaryEntry>;
}

export interface TranslationBatchResultItem {
  segmentId: string;
  translatedText: string;
}

export interface TranslationProvider {
  readonly providerId: string;
  translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationBatchResultItem[]>;
}
