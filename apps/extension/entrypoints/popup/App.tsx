import React, { useEffect, useState } from 'react';
import type { SubtitleDisplayMode, SyncMode } from '@dubcera/core';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type DubCeraSettings } from '../../src/storage/settingsStore';
import { LocalTtsClient, type LocalVoiceOption } from '../../src/tts/localTtsClient';

export const App: React.FC = () => {
  const [settings, setSettings] = useState<DubCeraSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<LocalVoiceOption[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

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

  return (
    <div
      style={{
        width: '350px',
        padding: '16px',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#38BDF8' }}>DubCera</div>
          <div style={{ fontSize: '11px', color: '#94A3B8' }}>Every word. Perfectly synced.</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: 600 }}>
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
          <label style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}>
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
                <option key={`${v.engineId}-${v.voiceId}`} value={`${v.engineId}::${v.voiceId}::${v.sampleRate}`}>
                  {v.displayName}
                </option>
              ))
            ) : (
              <>
                <option value="vieneu-onnx::Hải Đăng::48000">VieNeu v3 Turbo - Hải Đăng (48kHz · Chuẩn Anh-Việt)</option>
                <option value="vieneu-nano::Hải Đăng::24000">VieNeu Nano - Hải Đăng (CPU Eco · Máy yếu)</option>
              </>
            )}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}>
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
            <option value="LEARNING_HOLD_VIDEO">Ưu tiên đọc đủ (Cho phép giữ nhịp video khi câu dài)</option>
            <option value="STRICT_VIDEO_SPEED">Giữ cứng tốc độ video gốc</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}>
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
          onClick={openSandbox}
          style={{
            marginTop: '6px',
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
