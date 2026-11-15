import React, { useEffect, useState } from 'react';
import type { SubtitleDisplayMode, SyncMode } from '@dubcera/core';
import { clearAllBuiltinAudioCache } from '../../src/storage/builtinAudioCacheDb';
import { clearAllVideoManifests } from '../../src/storage/manifestDb';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type DubCeraSettings,
  type TranslationProviderKind,
} from '../../src/storage/settingsStore';
import { BUILTIN_CLOUD_ENGINE_ID } from '../../src/tts/builtinCloudTtsClient';
import { LocalTtsClient, type LocalVoiceOption } from '../../src/tts/localTtsClient';
import {
  mergeVoiceCatalogWithLiveServer,
  toVoiceSelectValue,
} from '../../src/tts/voiceCatalog';
import {
  getBuiltinVoiceShortLabel,
  resolveBuiltinFallbackVoiceId,
} from '../../src/tts/voiceTimbreProcessor';

function formatBytesToMb(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

const DEFAULT_MODEL_BY_PROVIDER: Record<TranslationProviderKind, string> = {
  'free-web': '',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  'openai-compatible': 'gpt-4o-mini',
};

export const App: React.FC = () => {
  const [settings, setSettings] = useState<DubCeraSettings>(DEFAULT_SETTINGS);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('gemini-2.5-flash');
  const [endpointDraft, setEndpointDraft] = useState('https://api.openai.com/v1/chat/completions');
  const [aiSavedNotice, setAiSavedNotice] = useState<string | null>(null);
  const [voices, setVoices] = useState<LocalVoiceOption[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  const checkLocalServer = async (cfg: DubCeraSettings) => {
    const client = new LocalTtsClient(cfg.localTtsUrl, cfg.localTtsToken);
    try {
      const health = await client.checkHealth(1500);
      setVoices(health.availableVoices);
      setServerOnline(true);
    } catch {
      setServerOnline(false);
    }
  };

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettings();
      setSettings(loaded);
      setApiKeyDraft(loaded.llmApiKey);
      setModelDraft(loaded.llmModel || DEFAULT_MODEL_BY_PROVIDER[loaded.translationProvider]);
      setEndpointDraft(loaded.llmEndpointUrl);
      await checkLocalServer(loaded);
    })();
  }, []);

  const update = async (patch: Partial<DubCeraSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
  };

  const handleProviderChange = async (provider: TranslationProviderKind) => {
    setAiSavedNotice(null);
    const suggestedModel = DEFAULT_MODEL_BY_PROVIDER[provider] || settings.llmModel;
    setModelDraft(suggestedModel);
    await update({
      translationProvider: provider,
      llmModel: suggestedModel,
    });
  };

  const handleSaveAiConfig = async () => {
    await update({
      llmApiKey: apiKeyDraft.trim(),
      llmModel: modelDraft.trim() || DEFAULT_MODEL_BY_PROVIDER[settings.translationProvider],
      llmEndpointUrl: endpointDraft.trim() || 'https://api.openai.com/v1/chat/completions',
    });
    setAiSavedNotice(
      apiKeyDraft.trim()
        ? 'Đã lưu cấu hình Dịch AI Ngữ Cảnh — Đang áp dụng ngay trên video!'
        : 'Chưa có API Key — Hệ thống sẽ tự dùng Dịch Thông Minh Miễn Phí.',
    );
  };

  const handleCopyStartCmd = () => {
    const cmd = `cd "d:\\New-project\\DubCera\\services\\tts-local"; .\\.venv\\Scripts\\python.exe -m dubcera_tts`;
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2200);
    });
  };

  const openExternalLink = (url: string) => {
    chrome.tabs.create({ url });
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

  const catalog = mergeVoiceCatalogWithLiveServer(voices);
  const builtinGroup = catalog.filter((v) => v.group === 'builtin');
  const nanoGroup = catalog.filter((v) => v.group === 'nano');
  const turboGroup = catalog.filter((v) => v.group === 'turbo');

  const selectedNeedsLocal = settings.engineId !== BUILTIN_CLOUD_ENGINE_ID;
  const usingBuiltinMode = !selectedNeedsLocal || serverOnline === false;
  const isAiMode = settings.translationProvider !== 'free-web';

  return (
    <div
      style={{
        width: '364px',
        padding: '15px',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '10px',
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
          padding: '7px 10px',
          borderRadius: '8px',
          marginBottom: '11px',
          fontSize: '11.5px',
          background: 'rgba(16, 185, 129, 0.14)',
          border: '1px solid rgba(16, 185, 129, 0.4)',
          color: '#6EE7B7',
        }}
      >
        {usingBuiltinMode
          ? `Đang phát giọng: ${getBuiltinVoiceShortLabel(
              resolveBuiltinFallbackVoiceId(settings.engineId, settings.voiceId),
            )} — Độc lập trên Chrome (0 MB RAM nền)`
          : `Đang phát giọng: ${settings.voiceId} (${settings.engineId})`}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <label
            style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}
          >
            Chọn Giọng đọc Tiếng Việt ({catalog.length} giọng hiện có)
          </label>
          <select
            value={toVoiceSelectValue(settings.engineId, settings.voiceId, settings.sampleRate)}
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
            <optgroup label="Độc lập trên Chrome (Không cần Python)">
              {builtinGroup.map((v) => (
                <option
                  key={`${v.engineId}-${v.voiceId}`}
                  value={toVoiceSelectValue(v.engineId, v.voiceId, v.sampleRate)}
                >
                  {v.displayName}
                </option>
              ))}
            </optgroup>

            <optgroup label="VieNeu Nano — Nhanh & Nhẹ RAM (~380 MB · Tự xả về 50 MB)">
              {nanoGroup.map((v) => (
                <option
                  key={`${v.engineId}-${v.voiceId}`}
                  value={toVoiceSelectValue(v.engineId, v.voiceId, v.sampleRate)}
                >
                  {v.displayName}
                </option>
              ))}
            </optgroup>

            <optgroup label="VieNeu Turbo — Chất lượng cao 48kHz (Bắc · Trung · Nam)">
              {turboGroup.map((v) => (
                <option
                  key={`${v.engineId}-${v.voiceId}`}
                  value={toVoiceSelectValue(v.engineId, v.voiceId, v.sampleRate)}
                >
                  {v.displayName}
                </option>
              ))}
            </optgroup>
          </select>

          {selectedNeedsLocal && serverOnline === false && (
            <div
              style={{
                marginTop: '6px',
                padding: '8px 9px',
                borderRadius: '7px',
                fontSize: '11.5px',
                lineHeight: 1.4,
                background: 'rgba(245, 158, 11, 0.14)',
                border: '1px solid rgba(245, 158, 11, 0.45)',
                color: '#FDE68A',
              }}
            >
              <div>
                Bạn đã chọn <b>{settings.voiceId}</b> nhưng Server <b>VieNeu</b> đang tắt nên hệ
                thống tạm đọc bằng giọng{' '}
                <b>
                  {getBuiltinVoiceShortLabel(
                    resolveBuiltinFallbackVoiceId(settings.engineId, settings.voiceId),
                  )}
                </b>{' '}
                tích hợp. <i>(Mẹo: Chọn nhóm &quot;Độc lập trên Chrome&quot; ở trên để đổi 4 giọng Nam/Nữ không cần Server, hoặc nháy đúp Start-DubCera-Voices.bat để bật VieNeu)</i>.
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                <button
                  type="button"
                  onClick={handleCopyStartCmd}
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(251, 191, 36, 0.5)',
                    background: 'rgba(251, 191, 36, 0.2)',
                    color: '#FEF3C7',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {copiedCmd ? 'Đã copy lệnh PowerShell!' : 'Copy lệnh bật tts-local'}
                </button>
                <button
                  type="button"
                  onClick={() => void checkLocalServer(settings)}
                  style={{
                    padding: '5px 9px',
                    borderRadius: '6px',
                    border: '1px solid #475569',
                    background: '#1E293B',
                    color: '#E2E8F0',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Kiểm tra lại
                </button>
              </div>
            </div>
          )}
        </div>

        <div>
          <label
            style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}
          >
            Bộ Dịch Thuật Lồng Tiếng (Độ sát ý & văn nói)
          </label>
          <select
            value={settings.translationProvider}
            onChange={(e) => void handleProviderChange(e.target.value as TranslationProviderKind)}
            style={{
              width: '100%',
              padding: '7px 8px',
              borderRadius: '6px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #334155',
            }}
          >
            <option value="free-web">
              Dịch Thông Minh Miễn Phí (Đã tối ưu văn nói · Không cần Key)
            </option>
            <option value="gemini">
              Google Gemini AI (Chuẩn ViDubbing · Key Miễn Phí)
            </option>
            <option value="groq">
              Groq Llama-3.3 70B AI (Siêu tốc · Key Miễn Phí)
            </option>
            <option value="openai-compatible">
              OpenAI / DeepSeek / Tùy chỉnh
            </option>
          </select>
        </div>

        {isAiMode && (
          <div
            style={{
              padding: '10px',
              borderRadius: '8px',
              background: 'rgba(15, 23, 42, 0.75)',
              border: '1px solid #334155',
              display: 'flex',
              flexDirection: 'column',
              gap: '7px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11.5px', color: '#94A3B8', fontWeight: 600 }}>
                {settings.translationProvider === 'gemini'
                  ? 'Gemini API Key (Miễn phí 1.500 lượt/ngày)'
                  : settings.translationProvider === 'groq'
                    ? 'Groq API Key (Miễn phí tốc độ cao)'
                    : 'API Key & Endpoint'}
              </span>
              {settings.translationProvider === 'gemini' && (
                <button
                  type="button"
                  onClick={() => openExternalLink('https://aistudio.google.com/apikey')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#38BDF8',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                >
                  Lấy Key miễn phí
                </button>
              )}
              {settings.translationProvider === 'groq' && (
                <button
                  type="button"
                  onClick={() => openExternalLink('https://console.groq.com/keys')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#38BDF8',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                >
                  Lấy Key miễn phí
                </button>
              )}
            </div>

            <input
              type="password"
              placeholder="Dán API Key vào đây..."
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 8px',
                borderRadius: '6px',
                background: '#1E293B',
                color: '#F8FAFC',
                border: '1px solid #475569',
                fontSize: '12px',
              }}
            />

            {settings.translationProvider === 'openai-compatible' && (
              <input
                type="text"
                placeholder="https://api.openai.com/v1/chat/completions"
                value={endpointDraft}
                onChange={(e) => setEndpointDraft(e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  background: '#1E293B',
                  color: '#F8FAFC',
                  border: '1px solid #475569',
                  fontSize: '12px',
                }}
              />
            )}

            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                placeholder="Model (vd: gemini-2.5-flash)"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                style={{
                  flex: 1,
                  boxSizing: 'border-box',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  background: '#1E293B',
                  color: '#F8FAFC',
                  border: '1px solid #475569',
                  fontSize: '12px',
                }}
              />
              <button
                type="button"
                onClick={() => void handleSaveAiConfig()}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#10B981',
                  color: '#052E16',
                  fontWeight: 700,
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                Áp dụng
              </button>
            </div>

            {aiSavedNotice && (
              <div style={{ fontSize: '11px', color: '#6EE7B7', lineHeight: 1.35 }}>
                {aiSavedNotice}
              </div>
            )}
          </div>
        )}

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
            marginTop: '2px',
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
