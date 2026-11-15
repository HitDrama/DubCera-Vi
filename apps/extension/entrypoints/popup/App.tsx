import React, { useEffect, useState } from 'react';
import type { SubtitleDisplayMode, SyncMode } from '@dubcera/core';
import { clearAllVideoManifests } from '../../src/storage/manifestDb';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type DubCeraSettings,
} from '../../src/storage/settingsStore';
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
        const health = await client.checkHealth(2500);
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
      // 1. Wipe extension-origin IndexedDB + broadcast invalidation epoch to all open & future tabs (YouTube/Udemy)
      await clearAllVideoManifests();
      const next = await saveSettings({ cacheInvalidatedAtMs: Date.now() });
      setSettings(next);

      // 2. Wipe local disk TTS WAV + metadata cache if Local TTS service is online
      const client = new LocalTtsClient(next.localTtsUrl, next.localTtsToken);
      try {
        const diskRes = await client.clearDiskCache();
        setCacheNotice(
          `Đã xóa sạch ${diskRes.deletedCount} file voice (${formatBytesToMb(diskRes.freedBytes)}) & toàn bộ cache bản dịch.`,
        );
      } catch {
        setCacheNotice(
          'Đã xóa toàn bộ cache bản dịch trên trình duyệt (khởi động lại Local TTS nếu muốn dọn thêm file .wav trên ổ đĩa).',
        );
      }
    } finally {
      setClearingCache(false);
    }
  };

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
          background: serverOnline ? 'rgba(16, 185, 129, 0.14)' : 'rgba(245, 158, 11, 0.14)',
          border: `1px solid ${serverOnline ? 'rgba(16, 185, 129, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
          color: serverOnline ? '#6EE7B7' : '#FCD34D',
        }}
      >
        {serverOnline === null
          ? 'Đang kiểm tra kết nối Local TTS (127.0.0.1:8765)...'
          : serverOnline
            ? `Local TTS Sẵn sàng (${voices.length} giọng khả dụng)`
            : 'Local TTS chưa chạy — Sẽ tự động hiển thị Phụ đề tiếng Việt'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <label
            style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}
          >
            Giọng đọc & Chế độ Phần cứng
          </label>
          <select
            value={`${settings.engineId}::${settings.voiceId}::${settings.sampleRate}`}
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
            {voices.length > 0 ? (
              voices.map((v) => (
                <option
                  key={`${v.engineId}-${v.voiceId}`}
                  value={`${v.engineId}::${v.voiceId}::${v.sampleRate}`}
                >
                  {v.displayName}
                </option>
              ))
            ) : (
              <>
                <option value="vieneu-onnx::Hải Đăng::48000">
                  VieNeu v3 Turbo - Hải Đăng (48kHz · Chuẩn Anh-Việt)
                </option>
                <option value="vieneu-nano::Hải Đăng::24000">
                  VieNeu Nano - Hải Đăng (CPU Eco · Máy yếu)
                </option>
              </>
            )}
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
