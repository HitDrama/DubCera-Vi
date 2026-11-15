import {
  base64ToAudioBytes,
  isContentScriptContext,
  sendBackgroundRpc,
} from '../bridges/extensionRpc';
import {
  getBuiltinCachedAudio,
  putBuiltinCachedAudio,
  verifyBuiltinCachedAudioKeys,
} from '../storage/builtinAudioCacheDb';

export const BUILTIN_CLOUD_ENGINE_ID = 'builtin-cloud-vi';
export const BUILTIN_CLOUD_VOICE_ID = 'vi-standard';

export interface BuiltinSynthResponse {
  audioDurationMs: number;
  blobUrl: string;
  cacheHit: boolean;
}

function splitClausesLocal(rawText: string, maxChars = 175): string[] {
  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;
  while (remaining.length > maxChars) {
    const windowSlice = remaining.slice(0, maxChars + 1);
    let splitIdx = -1;
    for (let i = windowSlice.length - 1; i >= Math.floor(maxChars * 0.45); i--) {
      if (/[,;:.?!—–]/.test(windowSlice[i]!) && (i + 1 >= windowSlice.length || windowSlice[i + 1] === ' ')) {
        splitIdx = i + 1;
        break;
      }
    }
    if (splitIdx === -1) splitIdx = windowSlice.lastIndexOf(' ');
    if (splitIdx <= 0) splitIdx = maxChars;
    const head = remaining.slice(0, splitIdx).trim();
    if (head) chunks.push(head);
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Pure-Extension Zero-Install Vietnamese TTS Client (Cách 1).
 * Runs 100% inside the Chrome Extension with 0 MB Python RAM and no external software required.
 */
export class BuiltinCloudTtsClient {
  constructor(private readonly sessionTag?: string) {}

  public abortActiveSessionRequests(): void {
    if (this.sessionTag && isContentScriptContext()) {
      void sendBackgroundRpc({
        type: 'ABORT_SESSION_REQUESTS',
        sessionTag: this.sessionTag,
      }).catch(() => {});
    }
  }

  public async verifyCachedKeys(
    cacheKeys: string[],
    minValidTimestampMs = 0,
  ): Promise<Record<string, { audioDurationMs: number }>> {
    return verifyBuiltinCachedAudioKeys(cacheKeys, minValidTimestampMs);
  }

  public async getCachedBlobUrl(
    audioCacheKey: string,
    minValidTimestampMs = 0,
  ): Promise<string | null> {
    const hit = await getBuiltinCachedAudio(audioCacheKey, minValidTimestampMs);
    if (!hit) return null;
    const blob = new Blob([hit.audioBytes], { type: hit.mimeType || 'audio/mpeg' });
    return URL.createObjectURL(blob);
  }

  public async synthesizeAndCache(params: {
    audioCacheKey: string;
    text: string;
    minValidTimestampMs?: number;
    signal?: AbortSignal;
  }): Promise<BuiltinSynthResponse> {
    const minTs = params.minValidTimestampMs ?? 0;
    const existing = await getBuiltinCachedAudio(params.audioCacheKey, minTs);
    if (existing) {
      const blob = new Blob([existing.audioBytes], { type: existing.mimeType || 'audio/mpeg' });
      return {
        audioDurationMs: existing.audioDurationMs,
        blobUrl: URL.createObjectURL(blob),
        cacheHit: true,
      };
    }

    let bytes: Uint8Array;
    let mimeType = 'audio/mpeg';
    let audioDurationMs: number;

    if (isContentScriptContext()) {
      const res = await sendBackgroundRpc<{
        audioBase64: string;
        mimeType: string;
        audioDurationMs: number;
      }>({
        type: 'BUILTIN_TTS_SYNTHESIZE',
        text: params.text,
        targetLang: 'vi',
        sessionTag: this.sessionTag,
      });
      bytes = base64ToAudioBytes(res.audioBase64);
      mimeType = res.mimeType || 'audio/mpeg';
      audioDurationMs = res.audioDurationMs;
    } else {
      const chunks = splitClausesLocal(params.text, 175);
      const parts: Uint8Array[] = [];
      let total = 0;
      for (const piece of chunks) {
        const url = new URL('https://translate.googleapis.com/translate_tts');
        url.searchParams.set('ie', 'UTF-8');
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('tl', 'vi');
        url.searchParams.set('q', piece);
        const resp = await fetch(url.toString(), { method: 'GET', signal: params.signal });
        if (!resp.ok) throw new Error(`Built-in TTS HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        parts.push(buf);
        total += buf.byteLength;
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        bytes.set(p, offset);
        offset += p.byteLength;
      }
      audioDurationMs = Math.max(250, Math.round(total / 8));
    }

    const arrayBuf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    await putBuiltinCachedAudio({
      audioCacheKey: params.audioCacheKey,
      mimeType,
      audioDurationMs,
      audioBytes: arrayBuf,
    });

    const blob = new Blob([arrayBuf], { type: mimeType });
    return {
      audioDurationMs,
      blobUrl: URL.createObjectURL(blob),
      cacheHit: false,
    };
  }
}
