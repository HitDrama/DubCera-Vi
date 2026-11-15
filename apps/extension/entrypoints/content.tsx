import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseVtt, type SubtitleCue } from '@dubcera/core';
import { parseYouTubeTimedTextPayload } from '../src/adapters/youtube/youtubeTimedTextParser';
import { sendBackgroundRpc } from '../src/bridges/extensionRpc';
import { AdaptiveSyncCoordinator, type CoordinatorUiSnapshot } from '../src/coordinator/syncCoordinator';
import { clearAllBuiltinAudioCache } from '../src/storage/builtinAudioCacheDb';
import { clearAllVideoManifests } from '../src/storage/manifestDb';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type DubCeraSettings,
} from '../src/storage/settingsStore';
import { BufferingBadge } from '../src/ui/BufferingBadge';
import { SubtitleOverlay } from '../src/ui/SubtitleOverlay';

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.udemy.com/*'],
  runAt: 'document_idle',
  main() {
    let activeVideo: HTMLVideoElement | null = null;
    let activeVideoId = '';
    let coordinator: AdaptiveSyncCoordinator | null = null;
    let shadowHost: HTMLDivElement | null = null;
    let reactRoot: Root | null = null;
    let playerToggleBtn: HTMLButtonElement | null = null;
    let currentSettings: DubCeraSettings = DEFAULT_SETTINGS;
    let lastCacheInvalidatedAtMs = 0;
    let latestSnapshot: CoordinatorUiSnapshot | null = null;
    let captionState: 'IDLE' | 'LOADING' | 'READY' | 'MISSING' = 'IDLE';
    let missingRetryCount = 0;

    // Hide default YouTube & Udemy native caption boxes while DubCera overlay is active so two subtitle boxes never collide
    const hideNativeCcStyle = document.createElement('style');
    hideNativeCcStyle.id = 'dubcera-hide-native-cc';
    document.head.appendChild(hideNativeCcStyle);

    function syncNativeCcVisibility(): void {
      const shouldHideNative =
        currentSettings.enabled &&
        currentSettings.subtitleMode !== 'OFF' &&
        captionState === 'READY';
      hideNativeCcStyle.textContent = shouldHideNative
        ? [
            '.ytp-caption-window-container,',
            '[data-purpose="captions-cue-text"],',
            '[class*="captions-display--captions-container"],',
            '[class*="captions-display--captions-cue-text"],',
            '.shaka-text-container,',
            '.vjs-text-track-display {',
            '  opacity: 0 !important;',
            '  pointer-events: none !important;',
            '}',
          ].join('\n')
        : '';
    }

    function resolvePlatformAndVideoId(): { platform: 'youtube' | 'udemy'; videoId: string } | null {
      const host = location.hostname.toLowerCase();
      if (host.includes('youtube.com')) {
        const url = new URL(location.href);
        const v = url.searchParams.get('v');
        if (v) return { platform: 'youtube', videoId: v };
        const shortsMatch = location.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
        if (shortsMatch?.[1]) return { platform: 'youtube', videoId: shortsMatch[1] };
        return null;
      }
      if (host.includes('udemy.com')) {
        const lectureMatch = location.pathname.match(/\/learn\/lecture\/(\d+)/);
        if (lectureMatch?.[1]) {
          return { platform: 'udemy', videoId: lectureMatch[1] };
        }
        return { platform: 'udemy', videoId: location.pathname };
      }
      return null;
    }

    function computeBadgeVisuals(): { badgeText: string; accentColor: string } {
      const isEnabled = currentSettings.enabled;
      const isBuffering = Boolean(latestSnapshot?.bufferingMessage);

      if (!isEnabled) {
        return { badgeText: 'TẮT', accentColor: '#94A3B8' };
      }
      if (captionState === 'MISSING') {
        return { badgeText: 'NO CC', accentColor: '#F87171' };
      }
      if (isBuffering || captionState === 'LOADING') {
        return { badgeText: 'NẠP...', accentColor: '#FBBF24' };
      }
      return { badgeText: 'VI ON', accentColor: '#38BDF8' };
    }

    function handleToggleClick(): void {
      void (async () => {
        const nextEnabled = !currentSettings.enabled;
        currentSettings = await saveSettings({ enabled: nextEnabled });
        syncNativeCcVisibility();

        if (!nextEnabled) {
          // Immediately destroy coordinator, unmount Shadow DOM & release all RAM!
          cleanupCurrentSession();
          activeVideoId = '';
          missingRetryCount = 0;
          updatePlayerToggleButtonAppearance();
          return;
        }

        activeVideoId = '';
        missingRetryCount = 0;
        updatePlayerToggleButtonAppearance();
        await tryAttachToPageVideo();
      })();
    }

    function handleQuickEngineSwitch(): void {
      void (async () => {
        const switchingToLocal = currentSettings.engineId === 'builtin-cloud-vi';
        currentSettings = await saveSettings(
          switchingToLocal
            ? { engineId: 'vieneu-onnx', voiceId: 'Hải Đăng', sampleRate: 48000, enabled: true }
            : { engineId: 'builtin-cloud-vi', voiceId: 'vi-standard', sampleRate: 24000, enabled: true },
        );
        if (coordinator) {
          await coordinator.updateSettings(currentSettings);
        }
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();
      })();
    }

    function updatePlayerToggleButtonAppearance(): void {
      if (!playerToggleBtn) return;

      const isEnabled = currentSettings.enabled;
      const { badgeText, accentColor } = computeBadgeVisuals();

      playerToggleBtn.title = isEnabled
        ? `DubCera đang BẬT (${latestSnapshot?.statusBanner ?? 'Giọng: ' + currentSettings.voiceId}) — Bấm để Tắt | Chuột phải đổi Nhanh/Chuẩn`
        : 'DubCera đang TẮT — Bấm để Bật lồng tiếng Việt';

      // Build DOM nodes without innerHTML so strict TrustedHTML CSP never blocks rendering
      playerToggleBtn.replaceChildren();

      const pill = document.createElement('span');
      pill.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:5px',
        'padding:3px 9px',
        'border-radius:6px',
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        'font-size:11.5px',
        'font-weight:700',
        'letter-spacing:0.02em',
        'line-height:1.2',
        'white-space:nowrap',
        `color:${isEnabled ? '#F8FAFC' : '#CBD5E1'}`,
        `background:${isEnabled ? 'rgba(14,165,233,0.24)' : 'rgba(15,23,42,0.65)'}`,
        `border:1.5px solid ${accentColor}`,
        'vertical-align:middle',
      ].join(';');

      const dot = document.createElement('span');
      dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${accentColor};display:inline-block;`;

      const label = document.createElement('span');
      label.textContent = `DC · ${badgeText}`;

      pill.appendChild(dot);
      pill.appendChild(label);
      playerToggleBtn.appendChild(pill);
    }

    /**
     * Finds the true horizontal control button row on Udemy (right beside CC / Settings / Fullscreen),
     * avoiding `[data-purpose="video-control-bar"]` root which stacks vertically behind subtitles!
     */
    function findUdemyHorizontalRowAnchor(): { row: HTMLElement; beforeNode: HTMLElement } | null {
      const anchorBtn = document.querySelector(
        '[data-purpose="captions-dropdown-button"], [data-purpose="playback-rate-button"], [data-purpose="settings-button"], [data-purpose="fullscreen-toggle-button"]',
      ) as HTMLElement | null;
      if (!anchorBtn) return null;

      let child: HTMLElement | null = anchorBtn;
      for (let depth = 0; depth < 5 && child?.parentElement; depth++) {
        const parentEl: HTMLElement = child.parentElement;
        const style = getComputedStyle(parentEl);
        if (style.display.includes('flex') && style.flexDirection === 'row') {
          return { row: parentEl, beforeNode: child };
        }
        child = parentEl;
      }
      return null;
    }

    function ensurePlayerControlBarButton(): void {
      const ytRightControls = document.querySelector('.ytp-right-controls') as HTMLElement | null;
      const udemyAnchor = ytRightControls ? null : findUdemyHorizontalRowAnchor();

      const targetParent = ytRightControls ?? udemyAnchor?.row ?? null;
      if (!targetParent) {
        if (playerToggleBtn && !playerToggleBtn.isConnected) {
          playerToggleBtn = null;
        }
        return;
      }

      const existing = document.getElementById('dubcera-player-toggle-btn') as HTMLButtonElement | null;
      if (existing && targetParent.contains(existing)) {
        playerToggleBtn = existing;
        updatePlayerToggleButtonAppearance();
        return;
      }

      existing?.remove();

      const btn = document.createElement('button');
      btn.id = 'dubcera-player-toggle-btn';
      btn.type = 'button';
      if (ytRightControls) {
        btn.className = 'ytp-button';
        btn.style.cssText = `
          width: auto !important;
          min-width: 78px;
          height: 100%;
          display: inline-flex !important;
          align-items: center;
          justify-content: center;
          padding: 0 6px !important;
          background: transparent;
          border: none;
          cursor: pointer;
          vertical-align: top;
        `;
      } else {
        btn.style.cssText = `
          flex: 0 0 auto;
          align-self: center;
          height: 30px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin: 0 6px;
          padding: 0 2px;
          background: transparent;
          border: none;
          cursor: pointer;
          z-index: 30;
        `;
      }

      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        handleToggleClick();
      });

      btn.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        handleQuickEngineSwitch();
      });

      const beforeEl = ytRightControls ? ytRightControls.firstChild : (udemyAnchor?.beforeNode ?? null);
      targetParent.insertBefore(btn, beforeEl);
      playerToggleBtn = btn;
      updatePlayerToggleButtonAppearance();
    }

    // Capture-phase guard for YouTube & Udemy external pause controls (`Space` / `K` / Play-Pause button)
    function setupExternalControlsCapture(): void {
      window.addEventListener(
        'keydown',
        (ev) => {
          if (!coordinator || !latestSnapshot?.playbackState.isBuffering) return;
          const target = ev.target as HTMLElement | null;
          if (
            target &&
            (target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.isContentEditable)
          ) {
            return;
          }
          if (ev.code === 'Space' || ev.key.toLowerCase() === 'k') {
            coordinator.requestExplicitUserPause();
          }
        },
        true,
      );

      window.addEventListener(
        'click',
        (ev) => {
          if (!coordinator || !latestSnapshot?.playbackState.isBuffering) return;
          const el = ev.target as HTMLElement | null;
          if (
            el?.closest(
              '.ytp-play-button, [data-purpose="play-button"], [data-purpose="pause-button"]',
            )
          ) {
            coordinator.requestExplicitUserPause();
          }
        },
        true,
      );
    }

    function renderOverlayUI(): void {
      if (!reactRoot) return;
      const showFallbackCornerPill = !playerToggleBtn || !playerToggleBtn.isConnected;
      const { badgeText, accentColor } = computeBadgeVisuals();

      reactRoot.render(
        <React.StrictMode>
          {showFallbackCornerPill && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleToggleClick();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleQuickEngineSwitch();
              }}
              title="Bấm để Bật/Tắt DubCera | Chuột phải đổi Nhanh/Chuẩn"
              style={{
                position: 'absolute',
                top: '14px',
                left: '16px',
                zIndex: 2147483644,
                pointerEvents: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: '8px',
                background: 'rgba(15, 23, 42, 0.78)',
                border: `1.5px solid ${accentColor}`,
                color: '#F8FAFC',
                fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                fontSize: '11.5px',
                fontWeight: 700,
                cursor: 'pointer',
                opacity: captionState === 'READY' && !latestSnapshot?.bufferingMessage ? 0.65 : 0.95,
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: accentColor,
                  display: 'inline-block',
                }}
              />
              <span>DC · {badgeText}</span>
            </button>
          )}
          <SubtitleOverlay
            chunk={currentSettings.enabled ? (latestSnapshot?.activeChunk ?? null) : null}
            mode={currentSettings.subtitleMode}
          />
          <BufferingBadge
            bufferingMessage={currentSettings.enabled ? (latestSnapshot?.bufferingMessage ?? null) : null}
            autoplayBlocked={latestSnapshot?.playbackState.autoplayBlocked ?? false}
            onExplicitPause={() => coordinator?.requestExplicitUserPause()}
            onResumeAutoplay={() => void coordinator?.resumeAfterAutoplayBlock()}
          />
        </React.StrictMode>,
      );
    }

    function handleCoordinatorSnapshot(snapshot: CoordinatorUiSnapshot): void {
      latestSnapshot = snapshot;
      syncNativeCcVisibility();
      updatePlayerToggleButtonAppearance();
      renderOverlayUI();
    }

    function mountOverlayContainer(video: HTMLVideoElement): void {
      const container = (video.closest('.html5-video-player') ??
        video.closest('[data-purpose="video-player"]') ??
        video.closest('[class*="video-player--container"]') ??
        video.parentElement) as HTMLElement | null;
      if (!container) return;
      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      if (shadowHost && container.contains(shadowHost) && reactRoot) {
        renderOverlayUI();
        return;
      }

      reactRoot?.unmount();
      shadowHost?.remove();
      shadowHost = document.createElement('div');
      shadowHost.id = 'dubcera-overlay-host';
      shadowHost.style.cssText =
        'position:absolute;inset:0;pointer-events:none;z-index:2147483640;';
      const shadow = shadowHost.attachShadow({ mode: 'open' });
      const mountPoint = document.createElement('div');
      mountPoint.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      shadow.appendChild(mountPoint);
      container.appendChild(shadowHost);

      reactRoot = createRoot(mountPoint);
      renderOverlayUI();
    }

    async function fetchVttViaBackgroundOrDirect(srcUrl: string): Promise<string | null> {
      try {
        const absoluteUrl = new URL(srcUrl, location.href).toString();
        if (absoluteUrl.startsWith('https://')) {
          return await sendBackgroundRpc<string>({
            type: 'FETCH_SUBTITLE_TEXT',
            url: absoluteUrl,
          });
        }
      } catch {
        // Fallback to direct page fetch (e.g. blob: or same-origin URL)
      }

      try {
        const resp = await fetch(srcUrl);
        if (resp.ok) return await resp.text();
      } catch {
        // Ignore
      }
      return null;
    }

    async function extractStandardHtml5Cues(video: HTMLVideoElement): Promise<SubtitleCue[]> {
      const trackEls = Array.from(video.querySelectorAll('track')).filter((el) => {
        const kind = (el.getAttribute('kind') ?? '').toLowerCase();
        const src = el.getAttribute('src') ?? '';
        if (kind === 'metadata' || kind === 'chapters') return false;
        if (/(?:sprite|thumb|storyboard)/i.test(src)) return false;
        return true;
      });
      const sortedTrackEls = [...trackEls].sort((a, b) => {
        const aEn = (a.getAttribute('srclang') ?? '').toLowerCase().startsWith('en') ? 0 : 1;
        const bEn = (b.getAttribute('srclang') ?? '').toLowerCase().startsWith('en') ? 0 : 1;
        return aEn - bEn;
      });

      for (const trackEl of sortedTrackEls) {
        const src = trackEl.getAttribute('src');
        if (!src) continue;
        const vttText = await fetchVttViaBackgroundOrDirect(src);
        if (vttText) {
          const parsed = parseVtt(vttText);
          if (parsed.length > 0) return parsed;
        }
      }

      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i]!;
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;

        const wasDisabled = track.mode === 'disabled';
        if (wasDisabled) {
          track.mode = 'hidden';
          await new Promise((r) => setTimeout(r, 150));
        }

        if (track.cues && track.cues.length > 0) {
          const cues: SubtitleCue[] = [];
          for (let c = 0; c < track.cues.length; c++) {
            const item = track.cues[c] as VTTCue;
            if (item && typeof item.text === 'string' && item.text.trim()) {
              cues.push({
                cueId: item.id || `dom-cue-${c}`,
                startMs: Math.round(item.startTime * 1000),
                endMs: Math.round(item.endTime * 1000),
                rawText: item.text.trim(),
              });
            }
          }
          if (cues.length > 0) return cues;
        }
      }

      return [];
    }

    async function startCoordinatorWithCues(
      video: HTMLVideoElement,
      platform: 'youtube' | 'udemy',
      videoId: string,
      cues: SubtitleCue[],
    ): Promise<void> {
      coordinator?.dispose();
      mountOverlayContainer(video);

      captionState = 'READY';
      missingRetryCount = 0;
      syncNativeCcVisibility();
      updatePlayerToggleButtonAppearance();
      renderOverlayUI();

      coordinator = new AdaptiveSyncCoordinator(
        video,
        currentSettings,
        platform,
        videoId,
        handleCoordinatorSnapshot,
      );
      await coordinator.initializeWithCues(cues);
    }

    // 1. Listen for YouTube MAIN-world caption payload responses
    window.addEventListener('dubcera:yt-captions-result', (ev: Event) => {
      const customEv = ev as CustomEvent<{
        videoId?: string;
        ok?: boolean;
        payload?: string;
      }>;
      const detail = customEv.detail;
      if (!detail || detail.videoId !== activeVideoId || !activeVideo) return;
      if (coordinator) return;

      if (!detail.ok || !detail.payload) {
        captionState = 'MISSING';
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();
        return;
      }

      const cues = parseYouTubeTimedTextPayload(detail.payload);
      if (cues.length === 0) {
        captionState = 'MISSING';
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();
        return;
      }

      void startCoordinatorWithCues(activeVideo, 'youtube', detail.videoId, cues);
    });

    // 2. Listen for Udemy MAIN-world caption payload / `.vtt` URL responses
    window.addEventListener('dubcera:udemy-captions-result', (ev: Event) => {
      const customEv = ev as CustomEvent<{
        videoId?: string;
        ok?: boolean;
        vttText?: string;
        vttUrl?: string;
      }>;
      const detail = customEv.detail;
      if (!detail || detail.videoId !== activeVideoId || !activeVideo) return;
      if (coordinator) return;

      const targetVideo = activeVideo;
      const targetVideoId = detail.videoId;

      void (async () => {
        if (!detail.ok) {
          captionState = 'MISSING';
          updatePlayerToggleButtonAppearance();
          renderOverlayUI();
          return;
        }

        let rawVtt = detail.vttText ?? null;
        if (!rawVtt && detail.vttUrl) {
          rawVtt = await fetchVttViaBackgroundOrDirect(detail.vttUrl);
        }

        if (!rawVtt || targetVideo !== activeVideo || coordinator) {
          if (!coordinator) {
            captionState = 'MISSING';
            updatePlayerToggleButtonAppearance();
            renderOverlayUI();
          }
          return;
        }

        const cues = parseVtt(rawVtt);
        if (cues.length === 0) {
          captionState = 'MISSING';
          updatePlayerToggleButtonAppearance();
          renderOverlayUI();
          return;
        }

        await startCoordinatorWithCues(targetVideo, 'udemy', targetVideoId, cues);
      })();
    });

    function cleanupCurrentSession(): void {
      coordinator?.dispose();
      coordinator = null;
      latestSnapshot = null;
      reactRoot?.unmount();
      reactRoot = null;
      shadowHost?.remove();
      shadowHost = null;
      activeVideo = null;
      captionState = 'IDLE';
      syncNativeCcVisibility();
      updatePlayerToggleButtonAppearance();
    }

    async function tryAttachToPageVideo(): Promise<void> {
      currentSettings = await loadSettings();
      if (lastCacheInvalidatedAtMs === 0) {
        lastCacheInvalidatedAtMs = currentSettings.cacheInvalidatedAtMs;
      }
      ensurePlayerControlBarButton();

      const meta = resolvePlatformAndVideoId();
      if (!meta) {
        if (coordinator) cleanupCurrentSession();
        return;
      }

      const ytPlayer = document.querySelector('.html5-video-player');
      if (ytPlayer?.classList.contains('ad-showing')) {
        return;
      }

      const video = document.querySelector('video') as HTMLVideoElement | null;
      if (!video) return;

      if (!currentSettings.enabled) {
        if (coordinator || shadowHost) {
          cleanupCurrentSession();
        }
        activeVideoId = '';
        updatePlayerToggleButtonAppearance();
        return;
      }

      if (video === activeVideo && meta.videoId === activeVideoId) {
        mountOverlayContainer(video);
        if (coordinator || captionState === 'LOADING') return;
        if (captionState === 'MISSING' && missingRetryCount >= 3) return;
        if (captionState === 'MISSING') {
          missingRetryCount += 1;
        }
      } else {
        cleanupCurrentSession();
        activeVideo = video;
        activeVideoId = meta.videoId;
        missingRetryCount = 0;
        mountOverlayContainer(video);
      }

      if (meta.platform === 'youtube') {
        captionState = 'LOADING';
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();
        window.dispatchEvent(
          new CustomEvent('dubcera:request-yt-captions', {
            detail: { videoId: meta.videoId },
          }),
        );
      } else {
        captionState = 'LOADING';
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();

        const domCues = await extractStandardHtml5Cues(video);
        if (domCues.length > 0) {
          await startCoordinatorWithCues(video, meta.platform, meta.videoId, domCues);
        } else {
          window.dispatchEvent(
            new CustomEvent('dubcera:request-udemy-captions', {
              detail: { videoId: meta.videoId },
            }),
          );
        }
      }
    }

    setupExternalControlsCapture();

    chrome.storage?.onChanged?.addListener(() => {
      void (async () => {
        const nextSettings = await loadSettings();
        const cacheWasCleared = nextSettings.cacheInvalidatedAtMs > lastCacheInvalidatedAtMs;
        currentSettings = nextSettings;
        lastCacheInvalidatedAtMs = nextSettings.cacheInvalidatedAtMs;

        if (cacheWasCleared) {
          // Wipe this origin's IndexedDB manifest + builtin MP3 audio cache & reset active coordinator
          await Promise.all([clearAllVideoManifests(), clearAllBuiltinAudioCache()]);
          cleanupCurrentSession();
          activeVideoId = '';
          missingRetryCount = 0;
          syncNativeCcVisibility();
          updatePlayerToggleButtonAppearance();
          renderOverlayUI();
          if (currentSettings.enabled) {
            await tryAttachToPageVideo();
          }
          return;
        }

        if (!currentSettings.enabled) {
          cleanupCurrentSession();
          activeVideoId = '';
          missingRetryCount = 0;
          syncNativeCcVisibility();
          updatePlayerToggleButtonAppearance();
          return;
        }

        syncNativeCcVisibility();
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();
        if (coordinator) {
          await coordinator.updateSettings(currentSettings);
        } else {
          activeVideoId = '';
          missingRetryCount = 0;
          await tryAttachToPageVideo();
        }
      })();
    });

    window.addEventListener('yt-navigate-finish', () => {
      activeVideoId = '';
      missingRetryCount = 0;
      setTimeout(() => void tryAttachToPageVideo(), 500);
    });

    // Immediately abort all background TTS/Translation & free memory if user closes tab or navigates away
    window.addEventListener('pagehide', () => cleanupCurrentSession());
    window.addEventListener('beforeunload', () => cleanupCurrentSession());

    // Fast initial mount + SPA polling for both YouTube and Udemy Lecture Auto-Advance
    void tryAttachToPageVideo();
    setInterval(() => {
      ensurePlayerControlBarButton();
      void tryAttachToPageVideo();
    }, 2000);
  },
});
