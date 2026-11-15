import {
  DEFAULT_TECH_GLOSSARY,
  formatGlossaryPromptDirective,
  type TranslationBatchRequest,
  type TranslationBatchResultItem,
  type TranslationProvider,
} from '@dubcera/core';

export interface LlmProviderConfig {
  endpointUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Context-aware OpenAI-compatible LLM Translation Provider (works with OpenAI, Gemini OpenAI endpoint, DeepSeek, Ollama/LM Studio).
 * Translates batches into natural spoken Vietnamese for dubbing while preserving technical identifiers.
 */
export class LlmApiTranslationProvider implements TranslationProvider {
  public readonly providerId = 'openai-compatible';

  constructor(private readonly config: LlmProviderConfig) {}

  public async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationBatchResultItem[]> {
    const glossaryDirective = formatGlossaryPromptDirective(
      request.glossary ?? DEFAULT_TECH_GLOSSARY,
    );

    const systemPrompt = [
      'Bạn là biên dịch viên lồng tiếng chuyên nghiệp cho các khóa học lập trình, Unity và công nghệ.',
      'Hãy dịch từng câu sang tiếng Việt tự nhiên, rõ nghĩa, dễ nghe khi đọc thành tiếng (TTS), không thêm bớt ý.',
      glossaryDirective,
      'Trả về DUY NHẤT một JSON object hợp lệ dạng: {"items":[{"segmentId":"...","translatedText":"..."}]} khớp chính xác 1-1 với danh sách đầu vào.',
    ].join(' ');

    const userPayload = JSON.stringify({
      contextBefore: request.contextBefore,
      items: request.items,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`;
    }

    const resp = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPayload },
        ],
      }),
    });

    if (!resp.ok) {
      throw new Error(`LLM Translation HTTP ${resp.status}`);
    }

    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = body.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(rawContent) as { items?: TranslationBatchResultItem[] };

    const outMap = new Map<string, string>();
    for (const item of parsed.items ?? []) {
      if (item.segmentId && item.translatedText?.trim()) {
        outMap.set(item.segmentId, item.translatedText.trim());
      }
    }

    // Verify 1-1 completeness
    return request.items.map((reqItem) => {
      const translated = outMap.get(reqItem.segmentId);
      if (!translated) {
        throw new Error(`LLM omitted segmentId ${reqItem.segmentId}`);
      }
      return {
        segmentId: reqItem.segmentId,
        translatedText: translated,
      };
    });
  }
}
