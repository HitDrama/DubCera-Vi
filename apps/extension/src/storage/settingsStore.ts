import type {
  HardwareProfilePreference,
  SubtitleDisplayMode,
  SyncMode,
  SynthesisConfigSnapshot,
} from '@dubcera/core';

export type TranslationProviderKind = 'free-web' | 'gemini' | 'groq' | 'openai-compatible';

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
  minEffectiveSpeechRate: number;
  maxEffectiveSpeechRate: number;
  originalVideoVolumeRatio: number; // e.g. 0.12 (12% background ducked volume)
  translationProvider: TranslationProviderKind;
  llmEndpointUrl: string;
  llmApiKey: string;
  llmModel: string;
  cacheInvalidatedAtMs: number;
}

export const DEFAULT_SETTINGS: DubCeraSettings = {
  enabled: true,
  localTtsUrl: 'http://127.0.0.1:8765',
  localTtsToken: 'dubcera-local-dev-token',
  voiceId: 'vi-standard',
  engineId: 'builtin-cloud-vi',
  sampleRate: 24000,
  hardwareProfile: 'AUTO',
  syncMode: 'LEARNING_HOLD_VIDEO',
  subtitleMode: 'BILINGUAL',
  minEffectiveSpeechRate: 1.0,
  maxEffectiveSpeechRate: 1.2,
  originalVideoVolumeRatio: 0.12,
  translationProvider: 'free-web',
  llmEndpointUrl: 'https://api.openai.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'gemini-2.5-flash',
  cacheInvalidatedAtMs: 0,
};

const STORAGE_KEY = 'dubcera_settings_v1';

function normalizeMigratedVoiceSettings(merged: DubCeraSettings): DubCeraSettings {
  merged.minEffectiveSpeechRate = Math.max(1.0, merged.minEffectiveSpeechRate || 1.0);
  if (merged.engineId === 'edge-hybrid') {
    const wasFemale = merged.voiceId.toLowerCase().includes('hoaimy');
    merged.engineId = 'vieneu-nano';
    merged.voiceId = wasFemale ? 'Trúc Ly' : 'Minh Quân';
    merged.sampleRate = 24000;
  } else if (merged.engineId === 'vieneu-nano' && merged.voiceId === 'Hải Đăng') {
    merged.voiceId = 'Minh Quân';
    merged.sampleRate = 24000;
  }
  return merged;
}

export async function loadSettings(): Promise<DubCeraSettings> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      if (data && data[STORAGE_KEY]) {
        const merged = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] as Partial<DubCeraSettings>) };
        return normalizeMigratedVoiceSettings(merged);
      }
    } else if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const merged = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DubCeraSettings>) };
        return normalizeMigratedVoiceSettings(merged);
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
    modelVersion: 'v3-multivoice-wsola',
    sampleRate: settings.sampleRate,
    styleOrPitchConfig: 'default',
    pauseConfig: 'default',
  };
}
