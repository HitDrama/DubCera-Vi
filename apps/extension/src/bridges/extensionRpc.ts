import type {
  LocalTtsHealth,
  SynthesizeResult,
  VerifiedCacheEntry,
} from '../tts/localTtsClient';

export interface StructuredTranslatedSentence {
  orig: string;
  trans: string;
}

export type DubCeraRpcRequest =
  | { type: 'TTS_HEALTH'; baseUrl: string; token: string; timeoutMs?: number }
  | { type: 'TTS_VERIFY_CACHE'; baseUrl: string; token: string; cacheKeys: string[] }
  | {
      type: 'TTS_SYNTHESIZE';
      baseUrl: string;
      token: string;
      audioCacheKey: string;
      text: string;
      voiceId: string;
      engineId: string;
      sampleRate: number;
      sessionTag?: string;
    }
  | {
      type: 'TTS_FETCH_AUDIO_B64';
      baseUrl: string;
      token: string;
      audioCacheKey: string;
      sessionTag?: string;
    }
  | {
      type: 'BUILTIN_TTS_SYNTHESIZE';
      text: string;
      targetLang?: string;
      sessionTag?: string;
    }
  | {
      type: 'FREE_WEB_TRANSLATE';
      sourceLang: string;
      targetLang: string;
      query: string;
      structured?: boolean;
      sessionTag?: string;
    }
  | {
      type: 'AI_LLM_TRANSLATE';
      provider: 'gemini' | 'groq' | 'openai-compatible';
      endpointUrl: string;
      apiKey: string;
      model: string;
      systemPrompt: string;
      userPayload: string;
      sessionTag?: string;
    }
  | { type: 'FETCH_SUBTITLE_TEXT'; url: string }
  | { type: 'TTS_RELEASE_MEMORY'; baseUrl: string; token: string }
  | { type: 'ABORT_SESSION_REQUESTS'; sessionTag: string };

export type DubCeraRpcResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function isContentScriptContext(): boolean {
  return (
    typeof location !== 'undefined' &&
    (location.protocol === 'https:' || location.protocol === 'http:') &&
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime?.sendMessage)
  );
}

export async function sendBackgroundRpc<T>(req: DubCeraRpcRequest): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(req)) as DubCeraRpcResponse<T> | undefined;
  if (!resp) {
    throw new Error('No response from DubCera background worker');
  }
  if (!resp.ok) {
    throw new Error(resp.error);
  }
  return resp.data;
}

export function base64ToAudioBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64ToWavBlobUrl(base64: string, mimeType = 'audio/wav'): string {
  const bytes = base64ToAudioBytes(base64);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}

export type { LocalTtsHealth, SynthesizeResult, VerifiedCacheEntry };
