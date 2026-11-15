import { BUILTIN_CLOUD_ENGINE_ID, BUILTIN_CLOUD_VOICE_ID } from './builtinCloudTtsClient';
import type { LocalVoiceOption } from './localTtsClient';

export interface CatalogVoiceEntry {
  engineId: string;
  voiceId: string;
  sampleRate: number;
  displayName: string;
  group: 'builtin' | 'nano' | 'turbo';
  requiresLocalServer: boolean;
}

export const STATIC_VOICE_CATALOG: ReadonlyArray<CatalogVoiceEntry> = [
  {
    engineId: BUILTIN_CLOUD_ENGINE_ID,
    voiceId: BUILTIN_CLOUD_VOICE_ID,
    sampleRate: 24000,
    displayName: 'Nữ Tự Nhiên — Chuẩn Mặc Định (Không cần Server)',
    group: 'builtin',
    requiresLocalServer: false,
  },
  {
    engineId: BUILTIN_CLOUD_ENGINE_ID,
    voiceId: 'vi-male-lecture',
    sampleRate: 24000,
    displayName: 'Nam Trầm — Giọng Bài Giảng / Thuyết Minh (Không cần Server)',
    group: 'builtin',
    requiresLocalServer: false,
  },
  {
    engineId: BUILTIN_CLOUD_ENGINE_ID,
    voiceId: 'vi-male-warm',
    sampleRate: 24000,
    displayName: 'Nam Ấm — Giọng Kể Chuyện Trầm Sâu (Không cần Server)',
    group: 'builtin',
    requiresLocalServer: false,
  },
  {
    engineId: BUILTIN_CLOUD_ENGINE_ID,
    voiceId: 'vi-female-bright',
    sampleRate: 24000,
    displayName: 'Nữ Thanh — Giọng Trẻ Trung Sáng Rõ (Không cần Server)',
    group: 'builtin',
    requiresLocalServer: false,
  },
  {
    engineId: 'vieneu-nano',
    voiceId: 'Minh Quân',
    sampleRate: 24000,
    displayName: 'VieNeu Nano — Minh Quân (Nam Bắc · Cần bật Server)',
    group: 'nano',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-nano',
    voiceId: 'Anh Khôi',
    sampleRate: 24000,
    displayName: 'VieNeu Nano — Anh Khôi (Nam Bắc Kể chuyện · Cần bật Server)',
    group: 'nano',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-nano',
    voiceId: 'Adam',
    sampleRate: 24000,
    displayName: 'VieNeu Nano — Adam (Nam miền Nam · Cần bật Server)',
    group: 'nano',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-nano',
    voiceId: 'Trúc Ly',
    sampleRate: 24000,
    displayName: 'VieNeu Nano — Trúc Ly (Nữ miền Bắc · Cần bật Server)',
    group: 'nano',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-nano',
    voiceId: 'Ái Hân',
    sampleRate: 24000,
    displayName: 'VieNeu Nano — Ái Hân (Nữ miền Nam · Cần bật Server)',
    group: 'nano',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Hải Đăng',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Hải Đăng (Nam Bắc 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Thiện Minh',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Thiện Minh (Nam Bài giảng 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Thái Sơn',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Thái Sơn (Nam miền Nam 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Quang Sơn',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Quang Sơn (Nam miền Trung 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Trúc Ly',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Trúc Ly (Nữ Bắc 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Thùy Dung',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Thùy Dung (Nữ miền Nam 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
  {
    engineId: 'vieneu-onnx',
    voiceId: 'Ngọc Trân',
    sampleRate: 48000,
    displayName: 'VieNeu Turbo — Ngọc Trân (Nữ miền Trung 48kHz · Cần bật Server)',
    group: 'turbo',
    requiresLocalServer: true,
  },
];

export function mergeVoiceCatalogWithLiveServer(
  liveVoices: ReadonlyArray<LocalVoiceOption>,
): CatalogVoiceEntry[] {
  const result: CatalogVoiceEntry[] = [...STATIC_VOICE_CATALOG];
  const existingKeys = new Set(result.map((v) => `${v.engineId}::${v.voiceId}`));

  for (const lv of liveVoices) {
    if (lv.engineId === 'mock-tone' || lv.engineId === 'edge-hybrid') continue;
    const key = `${lv.engineId}::${lv.voiceId}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      result.push({
        engineId: lv.engineId,
        voiceId: lv.voiceId,
        sampleRate: lv.sampleRate,
        displayName: lv.displayName,
        group: lv.engineId === 'vieneu-nano' ? 'nano' : 'turbo',
        requiresLocalServer: true,
      });
    }
  }

  return result;
}

export function toVoiceSelectValue(engineId: string, voiceId: string, sampleRate: number): string {
  return `${engineId}::${voiceId}::${sampleRate}`;
}
