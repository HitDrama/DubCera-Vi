import type {
  DubCeraRpcRequest,
  DubCeraRpcResponse,
  StructuredTranslatedSentence,
} from '../src/bridges/extensionRpc';

const activeSessionControllers = new Map<string, Set<AbortController>>();

function registerSessionController(sessionTag?: string): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!sessionTag) {
    return { controller, cleanup: () => {} };
  }
  let group = activeSessionControllers.get(sessionTag);
  if (!group) {
    group = new Set<AbortController>();
    activeSessionControllers.set(sessionTag, group);
  }
  group.add(controller);
  return {
    controller,
    cleanup: () => {
      const current = activeSessionControllers.get(sessionTag);
      if (current) {
        current.delete(controller);
        if (current.size === 0) {
          activeSessionControllers.delete(sessionTag);
        }
      }
    },
  };
}

function abortSessionControllers(sessionTag: string): number {
  const group = activeSessionControllers.get(sessionTag);
  if (!group) return 0;
  let count = 0;
  for (const ctrl of group) {
    ctrl.abort();
    count += 1;
  }
  activeSessionControllers.delete(sessionTag);
  return count;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function splitTextForBuiltinTts(rawText: string, maxChars = 180): string[] {
  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > maxChars) {
    const windowSlice = remaining.slice(0, maxChars + 1);
    let splitIdx = -1;

    // Prefer splitting right after clause punctuation (, ; : . ? ! —)
    for (let i = windowSlice.length - 1; i >= Math.floor(maxChars * 0.45); i--) {
      if (/[,;:.?!—–]/.test(windowSlice[i]!) && (i + 1 >= windowSlice.length || windowSlice[i + 1] === ' ')) {
        splitIdx = i + 1;
        break;
      }
    }

    // Fallback to last word space boundary
    if (splitIdx === -1) {
      splitIdx = windowSlice.lastIndexOf(' ');
    }
    if (splitIdx <= 0) {
      splitIdx = maxChars;
    }

    const head = remaining.slice(0, splitIdx).trim();
    if (head) chunks.push(head);
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

async function handleAiLlmTranslate(
  msg: Extract<DubCeraRpcRequest, { type: 'AI_LLM_TRANSLATE' }>,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = msg.apiKey.trim();
  if (!apiKey) {
    throw new Error('Missing AI API key');
  }

  if (msg.provider === 'gemini') {
    const modelName = (msg.model || 'gemini-2.5-flash').replace(/^models\//, '');
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(geminiUrl, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: msg.systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: msg.userPayload }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}: ${detail.slice(0, 180)}`);
    }

    const body = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const rawText =
      body.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('')
        .trim() ?? '';

    if (!rawText) {
      throw new Error('Gemini returned empty content');
    }
    return rawText;
  }

  const endpoint =
    msg.provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : msg.endpointUrl.trim() || 'https://api.openai.com/v1/chat/completions';

  const defaultModel = msg.provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';

  const resp = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: msg.model.trim() || defaultModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: msg.systemPrompt },
        { role: 'user', content: msg.userPayload },
      ],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`LLM HTTP ${resp.status}: ${detail.slice(0, 180)}`);
  }

  const body = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawContent = body.choices?.[0]?.message?.content?.trim() ?? '';
  if (!rawContent) {
    throw new Error('LLM returned empty content');
  }
  return rawContent;
}

async function handleRpc(msg: DubCeraRpcRequest): Promise<unknown> {
  switch (msg.type) {
    case 'ABORT_SESSION_REQUESTS': {
      return { aborted: abortSessionControllers(msg.sessionTag) };
    }

    case 'TTS_RELEASE_MEMORY': {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 700);
      try {
        await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/memory/release`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'X-DubCera-Token': msg.token },
        });
        return { released: true };
      } catch {
        return { released: false };
      } finally {
        clearTimeout(timer);
      }
    }

    case 'TTS_HEALTH': {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), msg.timeoutMs ?? 3500);
      try {
        const resp = await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/health`, {
          method: 'GET',
          signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`Health HTTP ${resp.status}`);
        return await resp.json();
      } finally {
        clearTimeout(timer);
      }
    }

    case 'TTS_VERIFY_CACHE': {
      const resp = await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/cache/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DubCera-Token': msg.token,
        },
        body: JSON.stringify({ cacheKeys: msg.cacheKeys }),
      });
      if (!resp.ok) throw new Error(`Cache verify HTTP ${resp.status}`);
      const body = (await resp.json()) as { validItems?: Record<string, unknown> };
      return body.validItems ?? {};
    }

    case 'TTS_SYNTHESIZE': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const resp = await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/synthesize`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-DubCera-Token': msg.token,
          },
          body: JSON.stringify({
            audioCacheKey: msg.audioCacheKey,
            text: msg.text,
            targetLang: 'vi',
            voiceId: msg.voiceId,
            engineId: msg.engineId,
            modelVersion: 'v1',
            sampleRate: msg.sampleRate,
            styleOrPitchConfig: 'default',
            pauseConfig: 'default',
          }),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          throw new Error(`TTS synthesize HTTP ${resp.status}: ${detail}`);
        }
        return await resp.json();
      } finally {
        cleanup();
      }
    }

    case 'TTS_FETCH_AUDIO_B64': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const resp = await fetch(
          `${msg.baseUrl.replace(/\/+$/, '')}/v1/audio/${msg.audioCacheKey}`,
          {
            method: 'GET',
            signal: controller.signal,
            headers: { 'X-DubCera-Token': msg.token },
          },
        );
        if (!resp.ok) throw new Error(`Audio fetch HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        return arrayBufferToBase64(buf);
      } finally {
        cleanup();
      }
    }

    case 'BUILTIN_TTS_SYNTHESIZE': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const chunks = splitTextForBuiltinTts(msg.text, 180);
        if (chunks.length === 0) {
          throw new Error('Empty TTS text');
        }

        const chunksBase64: string[] = [];
        let totalLength = 0;

        for (const piece of chunks) {
          const url = new URL('https://translate.googleapis.com/translate_tts');
          url.searchParams.set('ie', 'UTF-8');
          url.searchParams.set('client', 'gtx');
          url.searchParams.set('tl', msg.targetLang || 'vi');
          url.searchParams.set('ttsspeed', '1');
          url.searchParams.set('q', piece);

          const resp = await fetch(url.toString(), {
            method: 'GET',
            signal: controller.signal,
          });
          if (!resp.ok) {
            throw new Error(`Built-in TTS HTTP ${resp.status}`);
          }
          const buf = await resp.arrayBuffer();
          totalLength += buf.byteLength;
          chunksBase64.push(arrayBufferToBase64(buf));
        }

        return {
          chunksBase64,
          mimeType: 'audio/mpeg',
          rawDurationMs: Math.max(250, Math.round(totalLength / 8)),
        };
      } finally {
        cleanup();
      }
    }

    case 'FREE_WEB_TRANSLATE': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', msg.sourceLang || 'auto');
        url.searchParams.set('tl', msg.targetLang || 'vi');
        url.searchParams.set('dt', 't');
        if (msg.structured) {
          url.searchParams.set('dj', '1');
        }
        url.searchParams.set('q', msg.query);

        const resp = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`Translate HTTP ${resp.status}`);

        if (msg.structured) {
          const djJson = (await resp.json()) as {
            sentences?: Array<{ orig?: string; trans?: string }>;
          };
          const out: StructuredTranslatedSentence[] = [];
          for (const s of djJson.sentences ?? []) {
            if (typeof s.trans === 'string') {
              out.push({ orig: s.orig ?? '', trans: s.trans });
            }
          }
          return out;
        }

        const rawJson = (await resp.json()) as unknown;
        const parts = Array.isArray(rawJson) && Array.isArray(rawJson[0]) ? (rawJson[0] as unknown[]) : [];
        return parts
          .map((p) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : ''))
          .join('');
      } finally {
        cleanup();
      }
    }

    case 'AI_LLM_TRANSLATE': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        return await handleAiLlmTranslate(msg, controller.signal);
      } finally {
        cleanup();
      }
    }

    case 'FETCH_SUBTITLE_TEXT': {
      const parsed = new URL(msg.url);
      const host = parsed.hostname.toLowerCase();
      const isAllowedSubtitleHost =
        parsed.protocol === 'https:' &&
        (host.endsWith('.udemycdn.com') ||
          host.endsWith('.udemy.com') ||
          host === 'udemy.com' ||
          host.endsWith('.youtube.com'));
      if (!isAllowedSubtitleHost) {
        throw new Error(`Disallowed subtitle host: ${host}`);
      }
      const resp = await fetch(parsed.toString(), { method: 'GET' });
      if (!resp.ok) {
        throw new Error(`Subtitle fetch HTTP ${resp.status}`);
      }
      return await resp.text();
    }
  }
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    console.info('[DubCera] Extension installed and RPC background worker ready.');
  });

  chrome.runtime.onMessage.addListener(
    (
      message: DubCeraRpcRequest | undefined,
      _sender,
      sendResponse: (res: DubCeraRpcResponse) => void,
    ) => {
      if (!message || typeof message.type !== 'string') return false;

      void handleRpc(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    },
  );
});
