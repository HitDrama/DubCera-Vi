import {
  base64ToWavBlobUrl,
  isContentScriptContext,
  sendBackgroundRpc,
} from '../bridges/extensionRpc';

export interface LocalVoiceOption {
  voiceId: string;
  displayName: string;
  engineId: string;
  sampleRate: number;
  tier: string;
}

export interface LocalTtsHealth {
  status: string;
  version: string;
  activeProfile: string;
  safeCpuThreads: number;
  availableEngines: string[];
  availableVoices: LocalVoiceOption[];
}

export interface VerifiedCacheEntry {
  audioCacheKey: string;
  audioDurationMs: number;
  sampleRate: number;
  audioUrl: string;
}

export interface SynthesizeResult {
  audioCacheKey: string;
  cacheHit: boolean;
  audioDurationMs: number;
  sampleRate: number;
  engineUsed: string;
  synthesisElapsedMs: number;
  audioUrl: string;
}

export interface ClearDiskCacheResult {
  deletedCount: number;
  freedBytes: number;
}

export class LocalTtsClient {
  constructor(
    private baseUrl: string,
    private authToken: string,
    private readonly sessionTag?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  public abortActiveSessionRequests(): void {
    if (this.sessionTag && isContentScriptContext()) {
      void sendBackgroundRpc({
        type: 'ABORT_SESSION_REQUESTS',
        sessionTag: this.sessionTag,
      }).catch(() => {});
    }
  }

  public releaseServerMemory(): void {
    if (isContentScriptContext()) {
      void sendBackgroundRpc({
        type: 'TTS_RELEASE_MEMORY',
        baseUrl: this.baseUrl,
        token: this.authToken,
      }).catch(() => {});
      return;
    }
    void fetch(`${this.baseUrl}/v1/memory/release`, {
      method: 'POST',
      headers: { 'X-DubCera-Token': this.authToken },
    }).catch(() => {});
  }

  public updateCredentials(baseUrl: string, authToken: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authToken = authToken;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-DubCera-Token': this.authToken,
    };
  }

  public async checkHealth(timeoutMs = 3500, autoStart = false): Promise<LocalTtsHealth> {
    if (isContentScriptContext() || (autoStart && typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage))) {
      return sendBackgroundRpc<LocalTtsHealth>({
        type: 'TTS_HEALTH',
        baseUrl: this.baseUrl,
        token: this.authToken,
        timeoutMs,
        autoStart,
      });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/v1/health`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(`Health HTTP ${resp.status}`);
      }
      return (await resp.json()) as LocalTtsHealth;
    } finally {
      clearTimeout(timer);
    }
  }

  public async verifyCachedKeys(cacheKeys: string[]): Promise<Record<string, VerifiedCacheEntry>> {
    if (cacheKeys.length === 0) return {};
    if (isContentScriptContext()) {
      return sendBackgroundRpc<Record<string, VerifiedCacheEntry>>({
        type: 'TTS_VERIFY_CACHE',
        baseUrl: this.baseUrl,
        token: this.authToken,
        cacheKeys,
      });
    }

    const resp = await fetch(`${this.baseUrl}/v1/cache/verify`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ cacheKeys }),
    });
    if (!resp.ok) {
      throw new Error(`Cache verify HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { validItems: Record<string, VerifiedCacheEntry> };
    return data.validItems ?? {};
  }

  public async synthesize(params: {
    audioCacheKey: string;
    text: string;
    voiceId: string;
    engineId: string;
    sampleRate: number;
    signal?: AbortSignal;
  }): Promise<SynthesizeResult> {
    if (isContentScriptContext()) {
      return sendBackgroundRpc<SynthesizeResult>({
        type: 'TTS_SYNTHESIZE',
        baseUrl: this.baseUrl,
        token: this.authToken,
        audioCacheKey: params.audioCacheKey,
        text: params.text,
        voiceId: params.voiceId,
        engineId: params.engineId,
        sampleRate: params.sampleRate,
        sessionTag: this.sessionTag,
      });
    }

    const resp = await fetch(`${this.baseUrl}/v1/synthesize`, {
      method: 'POST',
      headers: this.headers,
      signal: params.signal,
      body: JSON.stringify({
        audioCacheKey: params.audioCacheKey,
        text: params.text,
        targetLang: 'vi',
        voiceId: params.voiceId,
        engineId: params.engineId,
        modelVersion: 'v1',
        sampleRate: params.sampleRate,
        styleOrPitchConfig: 'default',
        pauseConfig: 'default',
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`TTS synthesize HTTP ${resp.status}: ${detail}`);
    }
    return (await resp.json()) as SynthesizeResult;
  }

  public async fetchAudioBlobUrl(audioCacheKey: string, signal?: AbortSignal): Promise<string> {
    if (isContentScriptContext()) {
      const b64 = await sendBackgroundRpc<string>({
        type: 'TTS_FETCH_AUDIO_B64',
        baseUrl: this.baseUrl,
        token: this.authToken,
        audioCacheKey,
        sessionTag: this.sessionTag,
      });
      return base64ToWavBlobUrl(b64);
    }

    const resp = await fetch(`${this.baseUrl}/v1/audio/${audioCacheKey}`, {
      method: 'GET',
      headers: { 'X-DubCera-Token': this.authToken },
      signal,
    });
    if (!resp.ok) {
      throw new Error(`Audio fetch HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  }

  public async clearDiskCache(): Promise<ClearDiskCacheResult> {
    const resp = await fetch(`${this.baseUrl}/v1/cache/clear`, {
      method: 'POST',
      headers: this.headers,
    });
    if (!resp.ok) {
      throw new Error(`Clear cache HTTP ${resp.status}`);
    }
    return (await resp.json()) as ClearDiskCacheResult;
  }
}
