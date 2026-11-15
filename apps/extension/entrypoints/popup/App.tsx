import React, { useEffect, useState } from 'react';
import type { SubtitleDisplayMode, SyncMode } from '@dubcera/core';
import { clearAllBuiltinAudioCache } from '../../src/storage/builtinAudioCacheDb';
import { clearAllVideoManifests } from '../../src/storage/manifestDb';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type DubCeraSettings,
} from '../../src/storage/settingsStore';
import {
  BUILTIN_CLOUD_ENGINE_ID,
  BUILTIN_CLOUD_VOICE_ID,
} from '../../src/tts/builtinCloudTtsClient';
import { LocalTtsClient, type LocalVoiceOption } from '../../src/tts/localTtsClient';

function formatBytesToMb(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

export const App: React.FC = () => {
  const [settings, setSettings] = useState<DubCeraSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<LocalVoiceOption[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettings();
      setSettings(loaded);
      const client = new LocalTtsClient(loaded.localTtsUrl, loaded.localTtsToken);
      try {
        const health = await client.checkHealth(1500);
        setVoices(health.availableVoices);
        setServerOnline(true);
      } catch {
        setServerOnline(false);
      }
    })();
  }, []);

  const update = async (patch: Partial<DubCeraSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
  };

  const openSandbox = () => {
    const url = chrome.runtime.getURL('/playground.html');
    chrome.tabs.create({ url });
  };

  const handleClearAllCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    setCacheNotice(null);

    try {
      const [, builtinCleared] = await Promise.all([
        clearAllVideoManifests(),
        clearAllBuiltinAudioCache(),
      ]);
      const next = await saveSettings({ cacheInvalidatedAtMs: Date.now() });
      setSettings(next);

      let totalDeletedFiles = builtinCleared.deletedCount;
      let totalFreedBytes = builtinCleared.freedBytes;

      if (serverOnline) {
        const client = new LocalTtsClient(next.localTtsUrl, next.localTtsToken);
        try {
          const diskRes = await client.clearDiskCache();
          totalDeletedFiles += diskRes.deletedCount;
          totalFreedBytes += diskRes.freedBytes;
        } catch {
          // Ignore if local server was turned off
        }
      }

      setCacheNotice(
        totalDeletedFiles > 0
          ? `Đã xóa sạch ${totalDeletedFiles} file voice (${formatBytesToMb(totalFreedBytes)}) & toàn bộ cache bản dịch trên mọi tab.`
          : 'Đã làm sạch toàn bộ cache bản dịch & giọng đọc trên mọi tab trình duyệt.',
      );
    } finally {
      setClearingCache(false);
    }
  };

  const usingBuiltinMode = settings.engineId === BUILTIN_CLOUD_ENGINE_ID || serverOnline === false;

  return (
    <div
      style={{
        width: '350px',
        padding: '16px',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
        }}
      >
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#38BDF8' }}>DubCera</div>
          <div style={{ fontSize: '11px', color: '#94A3B8' }}>Every word. Perfectly synced.</div>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => void update({ enabled: e.target.checked })}
          />
          {settings.enabled ? 'Đang Bật' : 'Tắt'}
        </label>
      </div>

      <div
        style={{
          padding: '8px 10px',
          borderRadius: '8px',
          marginBottom: '12px',
          fontSize: '12px',
          background: 'rgba(16, 185, 129, 0.14)',
          border: '1px solid rgba(16, 185, 129, 0.4)',
          color: '#6EE7B7',
        }}
      >
        {usingBuiltinMode
          ? serverOnline
            ? 'Đang chạy Giọng đọc Tích hợp sẵn (Độc lập 100% · Có thể đổi sang VieNeu Local bên dưới)'
            : 'Chế độ Độc lập trên Chrome — Không cần bật Python (0 MB Python RAM)'
          : `Đang dùng Local TTS VieNeu (${voices.length} giọng khả dụng)`}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <label
            style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}
          >
            Nguồn Giọng đọc Tiếng Việt
          </label>
          <select
            value={
              usingBuiltinMode && settings.engineId !== BUILTIN_CLOUD_ENGINE_ID
                ? `${BUILTIN_CLOUD_ENGINE_ID}::${BUILTIN_CLOUD_VOICE_ID}::24000`
                : `${settings.engineId}::${settings.voiceId}::${settings.sampleRate}`
            }
            onChange={(e) => {
              const [engineId, voiceId, sr] = e.target.value.split('::');
              if (engineId && voiceId) {
                void update({ engineId, voiceId, sampleRate: Number(sr) || 24000 });
              }
            }}
            style={{
              width: '100%',
              padding: '7px 8px',
              borderRadius: '6px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #334155',
            }}
          >
            <option value={`${BUILTIN_CLOUD_ENGINE_ID}::${BUILTIN_CLOUD_VOICE_ID}::24000`}>
              Giọng Tiếng Việt Tích hợp sẵn (Mặc định · Không cần Python)
            </option>
            {serverOnline &&
              voices.map((v) => (
                <option
                  key={`${v.engineId}-${v.voiceId}`}
                  value={`${v.engineId}::${v.voiceId}::${v.sampleRate}`}
                >
                  {v.displayName} (Local)
                </option>
              ))}
          </select>
        </div>

        <div>
          <label
            style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}
          >
            Chế độ Đồng bộ Hình – Tiếng
          </label>
          <select
            value={settings.syncMode}
            onChange={(e) => void update({ syncMode: e.target.value as SyncMode })}
            style={{
              width: '100%',
              padding: '7px 8px',
              borderRadius: '6px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #334155',
            }}
          >
            <option value="LEARNING_HOLD_VIDEO">
              Ưu tiên đọc đủ (Cho phép giữ nhịp video khi câu dài)
            </option>
            <option value="STRICT_VIDEO_SPEED">Giữ cứng tốc độ video gốc</option>
          </select>
        </div>

        <div>
          <label
            style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}
          >
            Hiển thị Phụ đề (1–2 dòng gọn)
          </label>
          <select
            value={settings.subtitleMode}
            onChange={(e) => void update({ subtitleMode: e.target.value as SubtitleDisplayMode })}
            style={{
              width: '100%',
              padding: '7px 8px',
              borderRadius: '6px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #334155',
            }}
          >
            <option value="BILINGUAL">Song ngữ (Tiếng Việt + Phụ đề gốc)</option>
            <option value="VI_ONLY">Chỉ Tiếng Việt</option>
            <option value="OFF">Ẩn Phụ đề (Chỉ nghe Voice)</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => void handleClearAllCache()}
          disabled={clearingCache}
          style={{
            marginTop: '4px',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid rgba(248, 113, 113, 0.45)',
            background: clearingCache ? 'rgba(127, 29, 29, 0.3)' : 'rgba(239, 68, 68, 0.16)',
            color: '#FCA5A5',
            fontWeight: 700,
            cursor: clearingCache ? 'wait' : 'pointer',
          }}
        >
          {clearingCache
            ? 'Đang dọn dẹp toàn bộ Cache...'
            : 'Xóa sạch Cache (Bản dịch & Giọng đọc)'}
        </button>

        {cacheNotice && (
          <div
            style={{
              padding: '7px 9px',
              borderRadius: '6px',
              fontSize: '11.5px',
              lineHeight: 1.4,
              background: 'rgba(56, 189, 248, 0.12)',
              border: '1px solid rgba(56, 189, 248, 0.35)',
              color: '#BAE6FD',
            }}
          >
            {cacheNotice}
          </div>
        )}

        <button
          type="button"
          onClick={openSandbox}
          style={{
            marginTop: '2px',
            padding: '9px 12px',
            borderRadius: '8px',
            border: 'none',
            background: '#0284C7',
            color: '#FFFFFF',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Mở Trình Phát Thử Nghiệm (HTML5 Sandbox)
        </button>
      </div>
    </div>
  );
};
