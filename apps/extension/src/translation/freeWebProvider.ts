import {
  cleanSourceForTranslation,
  polishTranslatedVietnamese,
  type TranslationBatchRequest,
  type TranslationBatchResultItem,
  type TranslationProvider,
} from '@dubcera/core';
import { isContentScriptContext, sendBackgroundRpc } from '../bridges/extensionRpc';

export class FreeWebTranslationProvider implements TranslationProvider {
  public readonly providerId = 'free-web';

  constructor(private readonly sessionTag?: string) {}

  private async runTranslateQuery(
    query: string,
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const effectiveSource = !sourceLang || sourceLang === 'en' ? 'auto' : sourceLang;
    if (isContentScriptContext()) {
      return sendBackgroundRpc<string>({
        type: 'FREE_WEB_TRANSLATE',
        sourceLang: effectiveSource,
        targetLang: targetLang || 'vi',
        query,
        sessionTag: this.sessionTag,
      });
    }

    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', effectiveSource);
    url.searchParams.set('tl', targetLang || 'vi');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', query);

    const resp = await fetch(url.toString(), { method: 'GET', signal });
    if (!resp.ok) {
      throw new Error(`FreeWebTranslationProvider HTTP ${resp.status}`);
    }

    const rawJson = (await resp.json()) as unknown;
    const parts = Array.isArray(rawJson) && Array.isArray(rawJson[0]) ? (rawJson[0] as unknown[]) : [];
    return parts
      .map((p) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : ''))
      .join('');
  }

  public async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationBatchResultItem[]> {
    if (request.items.length === 0) return [];

    const preparedItems = request.items.map((item) => ({
      segmentId: item.segmentId,
      rawSource: item.sourceText,
      cleanedSource: cleanSourceForTranslation(item.sourceText) || item.sourceText,
    }));

    // Include up to 2 preceding sentences so neural translation resolves pronouns & topic context
    const priorContext = request.contextBefore
      .slice(-2)
      .map((c) => cleanSourceForTranslation(c))
      .filter((c) => c.length > 0);

    const payloadLines: string[] = [];
    priorContext.forEach((ctxLine, cIdx) => {
      payloadLines.push(`(0.${cIdx + 1}) ${ctxLine}`);
    });
    preparedItems.forEach((entry, idx) => {
      payloadLines.push(`(${idx + 1}) ${entry.cleanedSource}`);
    });

    const combinedTranslated = await this.runTranslateQuery(
      payloadLines.join('\n'),
      request.sourceLang,
      request.targetLang,
      signal,
    );

    const splitMap = new Map<number, string>();
    const markerRegex = /[（(]\s*(\d+(?:\.\d+)?)\s*[)）]/g;
    const matches = Array.from(combinedTranslated.matchAll(markerRegex));

    for (let m = 0; m < matches.length; m++) {
      const currentMatch = matches[m]!;
      const label = currentMatch[1]!;
      if (label.includes('.')) {
        // Context-only line (0.1, 0.2) — discard from output
        continue;
      }
      const idx = Number(label) - 1;
      const sliceStart = (currentMatch.index ?? 0) + currentMatch[0].length;
      const sliceEnd =
        m + 1 < matches.length
          ? (matches[m + 1]!.index ?? combinedTranslated.length)
          : combinedTranslated.length;
      const extracted = combinedTranslated.slice(sliceStart, sliceEnd).trim();
      if (idx >= 0 && extracted) {
        splitMap.set(idx, extracted);
      }
    }

    const results: TranslationBatchResultItem[] = [];
    for (let i = 0; i < preparedItems.length; i++) {
      const entry = preparedItems[i]!;
      let rawTranslated = splitMap.get(i);
      if (!rawTranslated) {
        rawTranslated = await this.runTranslateQuery(
          entry.cleanedSource,
          request.sourceLang,
          request.targetLang,
          signal,
        );
      }

      results.push({
        segmentId: entry.segmentId,
        translatedText: polishTranslatedVietnamese(rawTranslated, entry.rawSource),
      });
    }

    return results;
  }
}
