import {
  DEFAULT_TECH_GLOSSARY,
  type GlossaryEntry,
  type TranslationBatchRequest,
  type TranslationBatchResultItem,
  type TranslationProvider,
} from '@dubcera/core';
import { isContentScriptContext, sendBackgroundRpc } from '../bridges/extensionRpc';

function maskGlossaryTerms(
  text: string,
  glossary: ReadonlyArray<GlossaryEntry>,
): { masked: string; tokens: Array<{ placeholder: string; term: string }> } {
  const tokens: Array<{ placeholder: string; term: string }> = [];
  let masked = text;

  const sortedTerms = [...glossary]
    .filter((g) => g.preserveExact)
    .sort((a, b) => b.term.length - a.term.length);

  for (const entry of sortedTerms) {
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (regex.test(masked)) {
      const placeholder = `__DC_TERM_${tokens.length}__`;
      tokens.push({ placeholder, term: entry.term });
      masked = masked.replace(regex, placeholder);
    }
  }

  return { masked, tokens };
}

function unmaskGlossaryTerms(
  translated: string,
  tokens: ReadonlyArray<{ placeholder: string; term: string }>,
): string {
  let out = translated;
  for (const t of tokens) {
    const flexRegex = new RegExp(t.placeholder.replace(/_/g, '[_\\s]*'), 'gi');
    out = out.replace(flexRegex, t.term);
  }
  return out.replace(/\s+/g, ' ').trim();
}

export class FreeWebTranslationProvider implements TranslationProvider {
  public readonly providerId = 'free-web';

  constructor(private readonly sessionTag?: string) {}

  private async runTranslateQuery(
    query: string,
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (isContentScriptContext()) {
      return sendBackgroundRpc<string>({
        type: 'FREE_WEB_TRANSLATE',
        sourceLang: sourceLang || 'auto',
        targetLang: targetLang || 'vi',
        query,
        sessionTag: this.sessionTag,
      });
    }

    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', sourceLang || 'auto');
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
    const glossary = request.glossary ?? DEFAULT_TECH_GLOSSARY;
    const results: TranslationBatchResultItem[] = [];

    const maskedEntries = request.items.map((item) => ({
      segmentId: item.segmentId,
      ...maskGlossaryTerms(item.sourceText, glossary),
    }));

    const joinedPayload = maskedEntries
      .map((entry, idx) => `[#${idx}#] ${entry.masked}`)
      .join('\n');

    const combinedTranslated = await this.runTranslateQuery(
      joinedPayload,
      request.sourceLang,
      request.targetLang,
      signal,
    );

    const splitMap = new Map<number, string>();
    const markerRegex = /\[#\s*(\d+)\s*#\]/g;
    const matches = Array.from(combinedTranslated.matchAll(markerRegex));

    for (let m = 0; m < matches.length; m++) {
      const currentMatch = matches[m]!;
      const idx = Number(currentMatch[1]);
      const sliceStart = (currentMatch.index ?? 0) + currentMatch[0].length;
      const sliceEnd =
        m + 1 < matches.length
          ? (matches[m + 1]!.index ?? combinedTranslated.length)
          : combinedTranslated.length;
      splitMap.set(idx, combinedTranslated.slice(sliceStart, sliceEnd).trim());
    }

    for (let i = 0; i < maskedEntries.length; i++) {
      const entry = maskedEntries[i]!;
      let rawTranslated = splitMap.get(i);
      if (!rawTranslated) {
        rawTranslated = await this.runTranslateQuery(
          entry.masked,
          request.sourceLang,
          request.targetLang,
          signal,
        );
      }
      results.push({
        segmentId: entry.segmentId,
        translatedText: unmaskGlossaryTerms(rawTranslated, entry.tokens),
      });
    }

    return results;
  }
}
