import type {
  LocalTtsHealth,
  SynthesizeResult,
  VerifiedCacheEntry,
} from '../tts/localTtsClient';

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
    }
  | { type: 'TTS_FETCH_AUDIO_B64'; baseUrl: string; token: string; audioCacheKey: string }
  | { type: 'FREE_WEB_TRANSLATE'; sourceLang: string; targetLang: string; query: string }
  | { type: 'FETCH_SUBTITLE_TEXT'; url: string };

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

export function base64ToWavBlobUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

export type { LocalTtsHealth, SynthesizeResult, VerifiedCacheEntry };
