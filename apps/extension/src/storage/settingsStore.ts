import type {
  HardwareProfilePreference,
  SubtitleDisplayMode,
  SyncMode,
  SynthesisConfigSnapshot,
} from '@dubcera/core';

export interface DubCeraSettings {
  enabled: boolean;
  localTtsUrl: string;
  localTtsToken: string;
  voiceId: string;
  engineId: string;
  sampleRate: number;
  hardwareProfile: HardwareProfilePreference;
  syncMode: SyncMode;
  subtitleMode: SubtitleDisplayMode;
  maxEffectiveSpeechRate: number;
  originalVideoVolumeRatio: number; // e.g. 0.12 (12% background ducked volume)
  translationProvider: 'free-web' | 'openai-compatible';
  llmEndpointUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export const DEFAULT_SETTINGS: DubCeraSettings = {
  enabled: true,
  localTtsUrl: 'http://127.0.0.1:8765',
  localTtsToken: 'dubcera-local-dev-token',
  voiceId: 'Hải Đăng',
  engineId: 'vieneu-onnx',
  sampleRate: 48000,
  hardwareProfile: 'AUTO',
  syncMode: 'LEARNING_HOLD_VIDEO',
  subtitleMode: 'BILINGUAL',
  maxEffectiveSpeechRate: 1.3,
  originalVideoVolumeRatio: 0.12,
  translationProvider: 'free-web',
  llmEndpointUrl: 'https://api.openai.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
};

const STORAGE_KEY = 'dubcera_settings_v1';

export async function loadSettings(): Promise<DubCeraSettings> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      if (data && data[STORAGE_KEY]) {
        return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] as Partial<DubCeraSettings>) };
      }
    } else if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DubCeraSettings>) };
      }
    }
  } catch {
    // Fallback cleanly to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(patch: Partial<DubCeraSettings>): Promise<DubCeraSettings> {
  const current = await loadSettings();
  const updated: DubCeraSettings = { ...current, ...patch };
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    }
  } catch {
    // Ignore quota errors in restricted frames
  }
  return updated;
}

export function toSynthesisConfigSnapshot(settings: DubCeraSettings): SynthesisConfigSnapshot {
  return {
    targetLang: 'vi',
    voiceId: settings.voiceId,
    engineId: settings.engineId,
    modelVersion: 'v1',
    sampleRate: settings.sampleRate,
    styleOrPitchConfig: 'default',
    pauseConfig: 'default',
  };
}
