import React, { useEffect, useState } from 'react';
import type { SubtitleDisplayMode, SyncMode } from '@dubcera/core';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DubCeraSettings,
  type TranslationProviderKind,
} from '../storage/settingsStore';
import { BUILTIN_CLOUD_ENGINE_ID } from '../tts/builtinCloudTtsClient';
import { LocalTtsClient, type LocalVoiceOption } from '../tts/localTtsClient';
import {
  mergeVoiceCatalogWithLiveServer,
  toVoiceSelectValue,
} from '../tts/voiceCatalog';
import {
  getBuiltinVoiceShortLabel,
  resolveBuiltinFallbackVoiceId,
} from '../tts/voiceTimbreProcessor';

export interface PlayerSettingsPopoverProps {
  open: boolean;
  settings: DubCeraSettings;
  onUpdateSettings: (patch: Partial<DubCeraSettings>) => Promise<void>;
  onClose: () => void;
}

export const PlayerSettingsPopover: React.FC<PlayerSettingsPopoverProps> = ({
  open,
  settings,
  onUpdateSettings,
  onClose,
}) => {
  const [liveVoices, setLiveVoices] = useState<LocalVoiceOption[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.llmApiKey);
  const [modelDraft, setModelDraft] = useState(
    settings.llmModel || DEFAULT_MODEL_BY_PROVIDER[settings.translationProvider],
  );
  const [copiedCmd, setCopiedCmd] = useState(false);

  useEffect(() => {
    setApiKeyDraft(settings.llmApiKey);
  }, [settings.llmApiKey]);

  useEffect(() => {
    setModelDraft(settings.llmModel || DEFAULT_MODEL_BY_PROVIDER[settings.translationProvider]);
  }, [settings.llmModel, settings.translationProvider]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const client = new LocalTtsClient(settings.localTtsUrl, settings.localTtsToken);
    void client
      .checkHealth(1200)
      .then((res) => {
        if (!cancelled) {
          setLiveVoices(res.availableVoices);
          setServerOnline(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerOnline(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, settings.localTtsUrl, settings.localTtsToken]);

  if (!open) return null;

  const catalog = mergeVoiceCatalogWithLiveServer(liveVoices);
  const builtinGroup = catalog.filter((v) => v.group === 'builtin');
  const nanoGroup = catalog.filter((v) => v.group === 'nano');
  const turboGroup = catalog.filter((v) => v.group === 'turbo');

  const selectedNeedsLocal = settings.engineId !== BUILTIN_CLOUD_ENGINE_ID;
  const currentSelectValue = toVoiceSelectValue(
    settings.engineId,
    settings.voiceId,
    settings.sampleRate,
  );

  const handleCopyStartCmd = () => {
    const cmd = `cd "d:\\New-project\\DubCera\\services\\tts-local"; .\\.venv\\Scripts\\python.exe -m dubcera_tts`;
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2200);
    });
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        right: '16px',
        bottom: '62px',
        width: '328px',
        padding: '13px 14px',
        borderRadius: '12px',
        background: 'rgba(15, 23, 42, 0.96)',
        border: '1px solid rgba(56, 189, 248, 0.45)',
        boxShadow: '0 14px 34px rgba(0, 0, 0, 0.65)',
        color: '#F8FAFC',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '12.5px',
        zIndex: 2147483646,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '9px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: '13.5px', color: '#38BDF8' }}>
          Cài đặt Nhanh DubCera
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#94A3B8',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            padding: '0 4px',
          }}
        >
          ✕
        </button>
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}>
          Chọn Giọng đọc Tiếng Việt ({catalog.length} giọng)
        </label>
        <select
          value={currentSelectValue}
          onChange={(e) => {
            const [engineId, voiceId, sr] = e.target.value.split('::');
            if (engineId && voiceId) {
              void onUpdateSettings({
                engineId,
                voiceId,
                sampleRate: Number(sr) || 24000,
              });
            }
          }}
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: '6px',
            background: '#1E293B',
            color: '#F8FAFC',
            border: '1px solid #475569',
            fontSize: '12px',
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
              padding: '6px 8px',
              borderRadius: '6px',
              fontSize: '11px',
              lineHeight: 1.35,
              background: 'rgba(245, 158, 11, 0.14)',
              border: '1px solid rgba(245, 158, 11, 0.45)',
              color: '#FDE68A',
            }}
          >
            <div>
              Server <b>VieNeu</b> đang tắt nên tạm đọc bằng giọng{' '}
              <b>
                {getBuiltinVoiceShortLabel(
                  resolveBuiltinFallbackVoiceId(settings.engineId, settings.voiceId),
                )}
              </b>{' '}
              tích hợp. Muốn đổi giọng <b>không cần Server</b>, chọn ngay nhóm{' '}
              <b>Độc lập trên Chrome</b> ở đầu danh sách — hoặc mở <b>Start-DubCera-Voices.bat</b>{' '}
              để nghe đúng giọng <b>{settings.voiceId}</b>:
            </div>
            <button
              type="button"
              onClick={handleCopyStartCmd}
              style={{
                marginTop: '5px',
                padding: '4px 8px',
                borderRadius: '5px',
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
          </div>
        )}
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: '4px', color: '#CBD5E1', fontWeight: 600 }}>
          Bộ Dịch Thuật Lồng Tiếng
        </label>
        <select
          value={settings.translationProvider}
          onChange={(e) => {
            const nextProv = e.target.value as TranslationProviderKind;
            const nextModel =
              nextProv === settings.translationProvider
                ? settings.llmModel
                : DEFAULT_MODEL_BY_PROVIDER[nextProv] || settings.llmModel;
            setModelDraft(nextModel);
            void onUpdateSettings({
              translationProvider: nextProv,
              llmModel: nextModel,
            });
          }}
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: '6px',
            background: '#1E293B',
            color: '#F8FAFC',
            border: '1px solid #475569',
            fontSize: '12px',
          }}
        >
          <option value="free-web">Dịch Thông Minh Miễn Phí (Không cần Key)</option>
          <option value="gemini">Google Gemini AI (Chuẩn ViDubbing · Key Miễn Phí)</option>
          <option value="groq">Groq Llama-3.3 70B AI (Key Miễn Phí)</option>
          <option value="openai-compatible">OpenAI / DeepSeek</option>
        </select>

        {settings.translationProvider !== 'free-web' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '6px' }}>
            <textarea
              rows={2}
              placeholder="Dán 1 hoặc nhiều API Key (mỗi dòng 1 key)..."
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '5px 7px',
                borderRadius: '5px',
                background: '#1E293B',
                color: '#F8FAFC',
                border: '1px solid #475569',
                fontSize: '11px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: '5px' }}>
              <input
                type="text"
                placeholder={`Model (vd: ${DEFAULT_MODEL_BY_PROVIDER[settings.translationProvider] || 'gemini-3.5-flash-lite'})`}
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                style={{
                  flex: 1,
                  padding: '5px 7px',
                  borderRadius: '5px',
                  background: '#1E293B',
                  color: '#F8FAFC',
                  border: '1px solid #475569',
                  fontSize: '11.5px',
                }}
              />
              <button
                type="button"
                onClick={() =>
                  void onUpdateSettings({
                    llmApiKey: apiKeyDraft.trim(),
                    llmModel:
                      modelDraft.trim() ||
                      DEFAULT_MODEL_BY_PROVIDER[settings.translationProvider] ||
                      settings.llmModel,
                  })
                }
                style={{
                  padding: '5px 10px',
                  borderRadius: '5px',
                  border: 'none',
                  background: '#10B981',
                  color: '#052E16',
                  fontWeight: 700,
                  fontSize: '11.5px',
                  cursor: 'pointer',
                }}
              >
                Lưu
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: '3px', color: '#CBD5E1', fontWeight: 600 }}>
            Phụ đề
          </label>
          <select
            value={settings.subtitleMode}
            onChange={(e) => void onUpdateSettings({ subtitleMode: e.target.value as SubtitleDisplayMode })}
            style={{
              width: '100%',
              padding: '5px 6px',
              borderRadius: '6px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #475569',
              fontSize: '11.5px',
            }}
          >
            <option value="BILINGUAL">Song ngữ</option>
            <option value="VI_ONLY">Chỉ Tiếng Việt</option>
            <option value="OFF">Ẩn Phụ đề</option>
          </select>
        </div>

        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: '3px', color: '#CBD5E1', fontWeight: 600 }}>
            Nhịp đồng bộ
          </label>
          <select
            value={settings.syncMode}
            onChange={(e) => void onUpdateSettings({ syncMode: e.target.value as SyncMode })}
            style={{
              width: '100%',
              padding: '5px 6px',
              borderRadius: '6px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #475569',
              fontSize: '11.5px',
            }}
          >
            <option value="LEARNING_HOLD_VIDEO">Ưu tiên đọc đủ</option>
            <option value="STRICT_VIDEO_SPEED">Giữ tốc độ gốc</option>
          </select>
        </div>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 8px',
          borderRadius: '6px',
          background: '#1E293B',
          border: '1px solid #334155',
          cursor: 'pointer',
          color: '#E2E8F0',
          fontSize: '11.5px',
        }}
      >
        <span>Auto Theater (FastTrack)</span>
        <input
          type="checkbox"
          checked={settings.fastTrackAutoTheater}
          onChange={(e) => void onUpdateSettings({ fastTrackAutoTheater: e.target.checked })}
        />
      </label>
    </div>
  );
};
