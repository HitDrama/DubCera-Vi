import {
  DEFAULT_TECH_GLOSSARY,
  formatGlossaryPromptDirective,
  polishTranslatedVietnamese,
  type TranslationBatchRequest,
  type TranslationBatchResultItem,
  type TranslationProvider,
} from '@dubcera/core';
import { isContentScriptContext, sendBackgroundRpc } from '../bridges/extensionRpc';
import { FreeWebTranslationProvider } from './freeWebProvider';

export interface LlmProviderConfig {
  provider: 'gemini' | 'groq' | 'openai-compatible';
  endpointUrl: string;
  apiKey: string;
  model: string;
  sessionTag?: string;
}

function extractJsonObjectText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Studio-Grade Contextual AI Dubbing Translation Provider (Gemini Flash / Groq Llama-3.3 / OpenAI / DeepSeek).
 * Translates subtitle batches into idiomatic, duration-matched spoken Vietnamese for dubbing,
 * routed cleanly through the MV3 Service Worker so page CSP never blocks requests.
 */
export class LlmApiTranslationProvider implements TranslationProvider {
  public readonly providerId: string;
  private readonly fallbackWebProvider: FreeWebTranslationProvider;

  constructor(private readonly config: LlmProviderConfig) {
    this.providerId = config.provider;
    this.fallbackWebProvider = new FreeWebTranslationProvider(config.sessionTag);
  }

  private async invokeModelJson(
    systemPrompt: string,
    userPayload: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (isContentScriptContext()) {
      return sendBackgroundRpc<string>({
        type: 'AI_LLM_TRANSLATE',
        provider: this.config.provider,
        endpointUrl: this.config.endpointUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        systemPrompt,
        userPayload,
        sessionTag: this.config.sessionTag,
      });
    }

    if (this.config.provider === 'gemini') {
      const modelName = (this.config.model || 'gemini-2.5-flash').replace(/^models\//, '');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(this.config.apiKey.trim())}`;
      const resp = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPayload }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      });
      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
      const body = (await resp.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '{}';
    }

    const endpoint =
      this.config.provider === 'groq'
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : this.config.endpointUrl.trim() || 'https://api.openai.com/v1/chat/completions';

    const resp = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model:
          this.config.model.trim() ||
          (this.config.provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini'),
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPayload },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content ?? '{}';
  }

  public async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationBatchResultItem[]> {
    if (!this.config.apiKey.trim()) {
      return this.fallbackWebProvider.translateBatch(request, signal);
    }

    const glossaryDirective = formatGlossaryPromptDirective(
      request.glossary ?? DEFAULT_TECH_GLOSSARY,
    );

    const systemPrompt = [
      'Bạn là biên dịch viên lồng tiếng video (AI Dubbing) chuyên nghiệp hàng đầu tại Việt Nam.',
      'Nhiệm vụ: Dịch từng câu thoại sang văn nói tiếng Việt TỰ NHIÊN, SÁT Ý, MƯỢT MÀ khi đọc thành tiếng (TTS), tuyệt đối tránh dịch word-by-word cứng nhắc kiểu dịch máy.',
      'Quy tắc bắt buộc:',
      '1. Dựa vào videoTitle và contextBefore để hiểu đúng chủ đề chuyên môn và mạch câu chuyện.',
      '2. Xưng hô tự nhiên, đồng nhất: dùng "mình" - "các bạn" hoặc "chúng ta" cho bài giảng/hướng dẫn/vlog cá nhân; dùng giọng thuyết minh tự nhiên cho phim tài liệu/tin tức.',
      '3. Bám sát độ dài thời lượng nói: mỗi câu có gợi ý maxSyllables (số âm tiết tiếng Việt tối đa nên hướng tới để giọng đọc vừa khít khẩu hình ở tốc độ 1.0x). Hãy diễn đạt gọn, thoát ý, giàu nhịp điệu nói, không rườm rà nhưng KHÔNG bỏ sót thông tin quan trọng.',
      `4. ${glossaryDirective}`,
      '5. Trả về DUY NHẤT một JSON object hợp lệ dạng: {"items":[{"segmentId":"...","translatedText":"..."}]} khớp chính xác 1-1 với danh sách đầu vào.',
    ].join('\n');

    const userPayload = JSON.stringify({
      videoTitle: request.videoTitle || undefined,
      contextBefore: request.contextBefore.slice(-3),
      items: request.items.map((it) => ({
        segmentId: it.segmentId,
        sourceText: it.sourceText,
        maxSyllables: it.durationMs
          ? Math.max(6, Math.round((it.durationMs / 1000) * 4.4))
          : undefined,
      })),
    });

    try {
      const rawContent = await this.invokeModelJson(systemPrompt, userPayload, signal);
      const parsed = JSON.parse(extractJsonObjectText(rawContent)) as {
        items?: TranslationBatchResultItem[];
      };

      const outMap = new Map<string, string>();
      for (const item of parsed.items ?? []) {
        if (item.segmentId && item.translatedText?.trim()) {
          outMap.set(item.segmentId, item.translatedText.trim());
        }
      }

      return request.items.map((reqItem) => {
        const translated = outMap.get(reqItem.segmentId);
        if (!translated) {
          throw new Error(`LLM omitted segmentId ${reqItem.segmentId}`);
        }
        return {
          segmentId: reqItem.segmentId,
          translatedText: polishTranslatedVietnamese(translated, reqItem.sourceText),
        };
      });
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      // Graceful fallback to Smart Free Translator if API key is invalid or temporarily rate-limited
      return this.fallbackWebProvider.translateBatch(request, signal);
    }
  }
}
