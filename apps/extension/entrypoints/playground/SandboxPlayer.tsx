import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseSrt, parseVtt } from '@dubcera/core';
import { AdaptiveSyncCoordinator, type CoordinatorUiSnapshot } from '../../src/coordinator/syncCoordinator';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type DubCeraSettings } from '../../src/storage/settingsStore';
import { BufferingBadge } from '../../src/ui/BufferingBadge';
import { SubtitleOverlay } from '../../src/ui/SubtitleOverlay';

const BUILTIN_UNITY_LECTURE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.200
Welcome back to our Unity 2D

2
00:00:03.250 --> 00:00:06.200
physics architecture lesson.

3
00:00:07.000 --> 00:00:09.800
First, we need to select our player GameObject

4
00:00:09.900 --> 00:00:13.200
in the Hierarchy and attach a Rigidbody2D component.

5
00:00:14.200 --> 00:00:17.500
Notice that if you move physics bodies inside Update,

6
00:00:17.600 --> 00:00:21.400
your collision detection may jitter when frame rates fluctuate.

7
00:00:22.400 --> 00:00:26.000
Therefore, always apply forces inside FixedUpdate

8
00:00:26.100 --> 00:00:29.500
and expose tuning variables using SerializeField in the Inspector.

9
00:00:32.000 --> 00:00:35.500
Next, let's configure OnTriggerEnter so collectibles

10
00:00:35.600 --> 00:00:39.200
spawn a glowing Particle System without blocking movement.

11
00:00:42.000 --> 00:00:46.500
If you scrub ahead to minute one right now, DubCera will hold the Buffer Gate,

12
00:00:46.600 --> 00:00:51.000
prioritize translating and synthesizing these upcoming sentences first, and automatically resume!

13
00:00:54.000 --> 00:00:58.500
Finally, we will build a reusable Prefab and customize its look in Shader Graph

14
00:00:58.600 --> 00:01:03.500
so every level in our project shares the exact same visual pipeline.
`;

/**
 * Generates an in-memory, 100% natively seekable 75-second WAV media Blob URL
 * with subtle room ambiance so `<video controls>` works offline out-of-the-box before uploading a real MP4.
 */
function createSyntheticSeekableLectureMediaUrl(durationSeconds = 75): string {
  const sampleRate = 8000;
  const numSamples = durationSeconds * sampleRate;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const subtleTick = i % sampleRate < 120 ? Math.sin(2 * Math.PI * 440 * t) * 0.04 : 0;
    const sample = Math.round(subtleTick * 32767);
    view.setInt16(44 + i * 2, sample, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

export const SandboxPlayer: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const coordinatorRef = useRef<AdaptiveSyncCoordinator | null>(null);

  const defaultMediaUrl = useMemo(() => createSyntheticSeekableLectureMediaUrl(75), []);
  const [videoSrc, setVideoSrc] = useState<string>(defaultMediaUrl);
  const [videoIdLabel, setVideoIdLabel] = useState<string>('unity-2d-physics-demo');
  const [subtitleRaw, setSubtitleRaw] = useState<string>(BUILTIN_UNITY_LECTURE_VTT);
  const [isSrt, setIsSrt] = useState<boolean>(false);
  const [settings, setSettings] = useState<DubCeraSettings>(DEFAULT_SETTINGS);
  const [snapshot, setSnapshot] = useState<CoordinatorUiSnapshot | null>(null);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(defaultMediaUrl);
    };
  }, [defaultMediaUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadSettings();
      if (cancelled) return;
      setSettings(loaded);

      const videoEl = videoRef.current;
      if (!videoEl) return;

      coordinatorRef.current?.dispose();
      const cues = isSrt ? parseSrt(subtitleRaw) : parseVtt(subtitleRaw);
      const coord = new AdaptiveSyncCoordinator(
        videoEl,
        loaded,
        'sandbox',
        videoIdLabel,
        (nextSnap) => {
          if (!cancelled) setSnapshot(nextSnap);
        },
      );
      coordinatorRef.current = coord;
      await coord.initializeWithCues(cues);
    })();

    return () => {
      cancelled = true;
      coordinatorRef.current?.dispose();
      coordinatorRef.current = null;
    };
  }, [videoSrc, subtitleRaw, isSrt, videoIdLabel]);

  const handleEngineSwitch = async (engineId: string, voiceId: string, sampleRate: number) => {
    const updated = await saveSettings({ engineId, voiceId, sampleRate });
    setSettings(updated);
    await coordinatorRef.current?.updateSettings(updated);
  };

  return (
    <div
      style={{
        maxWidth: '1160px',
        margin: '0 auto',
        padding: '24px',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px', color: '#38BDF8' }}>
            DubCera — HTML5 Video Dubbing Sandbox (Phase 1C)
          </h1>
          <div style={{ fontSize: '13px', color: '#94A3B8', marginTop: '4px' }}>
            Kiểm thử trực tiếp: Tua nhảy cóc (Pause-Buffer-Resume) · Cache IndexedDB + SHA-256 WAV · Sub 1–2 dòng + Voice tuần tự
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <select
            value={`${settings.engineId}::${settings.voiceId}::${settings.sampleRate}`}
            onChange={(e) => {
              const [eng, voice, sr] = e.target.value.split('::');
              if (eng && voice) void handleEngineSwitch(eng, voice, Number(sr) || 24000);
            }}
            style={{
              padding: '8px 12px',
              borderRadius: '8px',
              background: '#1E293B',
              color: '#F8FAFC',
              border: '1px solid #334155',
            }}
          >
            <option value="vieneu-onnx::Hải Đăng::48000">VieNeu v3 Turbo - Hải Đăng (48kHz · Chuẩn Anh-Việt)</option>
            <option value="vieneu-onnx::Trúc Ly::48000">VieNeu v3 Turbo - Trúc Ly (48kHz · Nữ Bắc)</option>
            <option value="vieneu-nano::Hải Đăng::24000">VieNeu v3 Nano - Hải Đăng (CPU Eco · Nhanh/Nhẹ)</option>
            <option value="mock-tone::mock-vi-cadence::24000">Mock Tone (Test siêu tốc 0ms)</option>
          </select>
        </div>
      </div>

      {/* Custom Video & VTT/SRT File Loaders */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '16px',
          padding: '12px 16px',
          marginBottom: '16px',
          borderRadius: '10px',
          background: '#111827',
          border: '1px solid #1F2937',
          fontSize: '13px',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#CBD5E1', fontWeight: 600 }}>1. Chọn file Video (.mp4/.webm tùy chọn):</span>
          <input
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setVideoSrc(URL.createObjectURL(file));
                setVideoIdLabel(file.name);
              }
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#CBD5E1', fontWeight: 600 }}>2. Chọn phụ đề (.vtt/.srt tùy chọn):</span>
          <input
            type="file"
            accept=".vtt,.srt,text/vtt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void file.text().then((txt) => {
                  setIsSrt(file.name.toLowerCase().endsWith('.srt'));
                  setSubtitleRaw(txt);
                });
              }
            }}
          />
        </label>
      </div>

      {/* Video Stage + Overlay */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          background: 'linear-gradient(135deg, #0F172A 0%, #1E1B4B 100%)',
          borderRadius: '14px',
          overflow: 'hidden',
          border: '1px solid #334155',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '22px',
            left: '24px',
            color: 'rgba(148, 163, 184, 0.7)',
            fontSize: '13px',
            pointerEvents: 'none',
          }}
        >
          Bài giảng mẫu: Unity 2D Physics Architecture ({videoIdLabel})
        </div>

        <video
          ref={videoRef}
          src={videoSrc}
          controls
          style={{ width: '100%', height: '100%', display: 'block' }}
        />

        <SubtitleOverlay
          chunk={snapshot?.activeChunk ?? null}
          mode={settings.subtitleMode}
        />
        <BufferingBadge
          bufferingMessage={snapshot?.bufferingMessage ?? null}
          autoplayBlocked={snapshot?.playbackState.autoplayBlocked ?? false}
          onExplicitPause={() => coordinatorRef.current?.requestExplicitUserPause()}
          onResumeAutoplay={() => void coordinatorRef.current?.resumeAfterAutoplayBlock()}
        />
      </div>

      {/* Live Telemetry & Segment Cache Table */}
      <div
        style={{
          padding: '16px',
          borderRadius: '12px',
          background: '#111827',
          border: '1px solid #1F2937',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '13px' }}>
          <div>
            <strong>Trạng thái:</strong>{' '}
            <span style={{ color: '#38BDF8' }}>{snapshot?.statusBanner ?? 'Đang khởi tạo...'}</span>
          </div>
          <div>
            <strong>Đã dịch:</strong> {snapshot?.translatedCount ?? 0}/{snapshot?.totalSegments ?? 0} câu ·{' '}
            <strong>Audio READY (Cache):</strong>{' '}
            <span style={{ color: '#34D399', fontWeight: 700 }}>
              {snapshot?.readyCount ?? 0}/{snapshot?.totalSegments ?? 0}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
          {snapshot?.segments.map((seg) => (
            <div
              key={seg.segmentId}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = seg.startMs / 1000 + 0.05;
                }
              }}
              style={{
                cursor: 'pointer',
                padding: '10px 12px',
                borderRadius: '8px',
                background:
                  snapshot.playbackState.activeSegmentIndex === seg.segmentIndex
                    ? 'rgba(14, 165, 233, 0.18)'
                    : '#1E293B',
                border:
                  snapshot.playbackState.activeSegmentIndex === seg.segmentIndex
                    ? '1px solid #38BDF8'
                    : '1px solid #334155',
                fontSize: '12.5px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: '#94A3B8', fontWeight: 600 }}>
                  #{seg.segmentIndex + 1} [{(seg.startMs / 1000).toFixed(1)}s → {(seg.endMs / 1000).toFixed(1)}s]
                </span>
                <span
                  style={{
                    fontWeight: 700,
                    color:
                      seg.status === 'READY'
                        ? '#34D399'
                        : seg.status === 'ERROR'
                          ? '#F87171'
                          : '#FBBF24',
                  }}
                >
                  {seg.status}
                  {seg.audioDurationMs ? ` (${(seg.audioDurationMs / 1000).toFixed(1)}s WAV)` : ''}
                </span>
              </div>
              <div style={{ color: '#CBD5E1' }}>{seg.sourceText}</div>
              {seg.translatedText && (
                <div style={{ color: '#38BDF8', marginTop: '3px', fontWeight: 500 }}>
                  → {seg.translatedText}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
