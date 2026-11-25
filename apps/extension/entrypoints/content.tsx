import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseVtt, type SubtitleCue } from '@dubcera/core';
import {
  extractBunnyEnglishCues,
  parseBunnyEmbedVideoId,
} from '../src/adapters/bunny/bunnyStreamAdapter';
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
import { PlayerSettingsPopover } from '../src/ui/PlayerSettingsPopover';
import { SubtitleOverlay } from '../src/ui/SubtitleOverlay';

export default defineContentScript({
  matches: [
    '*://*.youtube.com/*',
    '*://*.udemy.com/*',
    '*://iframe.mediadelivery.net/*',
    '*://*.thegnomonworkshop.com/*',
  ],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    // YouTube, Udemy & The Gnomon Workshop run strictly in top frame; Bunny Stream runs inside its embed iframe
    const initialHost = location.hostname.toLowerCase();
    const isBunnyHost = initialHost === 'iframe.mediadelivery.net';
    if (!isBunnyHost && window !== window.top) {
      return;
    }
    let activeVideo: HTMLVideoElement | null = null;
    let activeVideoId = '';
    let latestGnomonEntryId = '';
    let coordinator: AdaptiveSyncCoordinator | null = null;
    let shadowHost: HTMLDivElement | null = null;
    let reactRoot: Root | null = null;
    let playerToggleBtn: HTMLButtonElement | null = null;
    let lastButtonRenderKey = '';
    let settingsPopoverOpen = false;
    let settingsInitialized = false;
    let currentSettings: DubCeraSettings = DEFAULT_SETTINGS;
    let lastCacheInvalidatedAtMs = 0;
    let latestSnapshot: CoordinatorUiSnapshot | null = null;
    let captionState: 'IDLE' | 'LOADING' | 'READY' | 'MISSING' = 'IDLE';
    let missingRetryCount = 0;
    let shortcutHudText: string | null = null;
    let shortcutHudTimer: ReturnType<typeof setTimeout> | null = null;
    const CORNER_BAR_POS_KEY = 'dubcera_corner_bar_pos_v1';
    let cornerBarPos: { x: number; y: number } = (() => {
      try {
        const raw = localStorage.getItem(CORNER_BAR_POS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { x?: number; y?: number };
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return { x: Math.max(8, parsed.x), y: Math.max(8, parsed.y) };
          }
        }
      } catch {
        // Ignore restricted storage
      }
      return { x: 16, y: 14 };
    })();
    let cornerBarDragging = false;
    let cornerBarCollapsed = false;

    function clampCornerBarPos(x: number, y: number, barEl: HTMLElement | null): { x: number; y: number } {
      const hostRect = shadowHost?.getBoundingClientRect();
      const barRect = barEl?.getBoundingClientRect();
      const maxX = hostRect
        ? Math.max(8, hostRect.width - (barRect?.width ?? 180) - 8)
        : Math.max(8, window.innerWidth - 200);
      const maxY = hostRect
        ? Math.max(8, hostRect.height - (barRect?.height ?? 36) - 8)
        : Math.max(8, window.innerHeight - 44);
      return {
        x: Math.round(Math.max(8, Math.min(maxX, x))),
        y: Math.round(Math.max(8, Math.min(maxY, y))),
      };
    }

    function startCornerBarDrag(ev: React.PointerEvent<HTMLElement>): void {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();

      const barEl = ev.currentTarget.closest('[data-dc-corner-bar="1"]') as HTMLElement | null;
      const startClientX = ev.clientX;
      const startClientY = ev.clientY;
      const originX = cornerBarPos.x;
      const originY = cornerBarPos.y;
      cornerBarDragging = true;
      renderOverlayUI();

      const onMove = (moveEv: PointerEvent) => {
        const dx = moveEv.clientX - startClientX;
        const dy = moveEv.clientY - startClientY;
        cornerBarPos = clampCornerBarPos(originX + dx, originY + dy, barEl);
        if (barEl) {
          barEl.style.left = `${cornerBarPos.x}px`;
          barEl.style.top = `${cornerBarPos.y}px`;
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        cornerBarDragging = false;
        try {
          localStorage.setItem(CORNER_BAR_POS_KEY, JSON.stringify(cornerBarPos));
        } catch {
          // Ignore storage quota errors
        }
        renderOverlayUI();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    function showShortcutHud(text: string): void {
      shortcutHudText = text;
      if (shortcutHudTimer) clearTimeout(shortcutHudTimer);
      shortcutHudTimer = setTimeout(() => {
        shortcutHudText = null;
        shortcutHudTimer = null;
        renderOverlayUI();
      }, 750);
      renderOverlayUI();
    }

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
            '.vjs-text-track-display,',
            '.plyr__captions,',
            '.playkit-subtitles {',
            '  opacity: 0 !important;',
            '  pointer-events: none !important;',
            '}',
          ].join('\n')
        : '';
    }

    function resolvePlatformAndVideoId(): {
      platform: 'youtube' | 'udemy' | 'bunny' | 'gnomon';
      videoId: string;
    } | null {
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
      if (host === 'iframe.mediadelivery.net') {
        const bunnyId = parseBunnyEmbedVideoId(location.href);
        if (bunnyId) {
          return { platform: 'bunny', videoId: bunnyId };
        }
        return null;
      }
      if (host.includes('thegnomonworkshop.com')) {
        if (latestGnomonEntryId) {
          return { platform: 'gnomon', videoId: latestGnomonEntryId };
        }
        const playkitLabel = document
          .querySelector('.playkit-video-player')
          ?.getAttribute('aria-label')
          ?.trim();
        if (playkitLabel) {
          return { platform: 'gnomon', videoId: `${location.pathname}::${playkitLabel}` };
        }
        return null;
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

    function togglePlayerSettingsPopover(): void {
      settingsPopoverOpen = !settingsPopoverOpen;
      void (async () => {
        if (settingsPopoverOpen) {
          currentSettings = await loadSettings();
          settingsInitialized = true;
          if (!reactRoot) {
            const pageVideo =
              activeVideo ?? (document.querySelector('video') as HTMLVideoElement | null);
            if (pageVideo) {
              mountOverlayContainer(pageVideo);
            }
          }
        }
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();
      })();
    }

    async function handleInlineSettingsUpdate(patch: Partial<DubCeraSettings>): Promise<void> {
      currentSettings = await saveSettings(patch);
      syncNativeCcVisibility();
      updatePlayerToggleButtonAppearance();
      renderOverlayUI();
      // When chrome.storage.onChanged is available, it applies coordinator.updateSettings once
      // consistently across all tabs/frames without double-triggering.
      if (!chrome.storage?.onChanged && coordinator) {
        await coordinator.updateSettings(currentSettings);
      }
    }

    function updatePlayerToggleButtonAppearance(): void {
      if (!playerToggleBtn) return;

      const isEnabled = currentSettings.enabled;
      const { badgeText, accentColor } = computeBadgeVisuals();
      const renderKey = `${isEnabled}|${badgeText}|${accentColor}|${settingsPopoverOpen}|${latestSnapshot?.statusBanner ?? ''}`;
      if (renderKey === lastButtonRenderKey && playerToggleBtn.childElementCount > 0) {
        return;
      }
      lastButtonRenderKey = renderKey;

      playerToggleBtn.title = isEnabled
        ? `DubCera đang BẬT (${latestSnapshot?.statusBanner ?? 'Giọng: ' + currentSettings.voiceId}) — Bấm chữ để Tắt | Bấm ⚙ (hoặc chuột phải) để chọn Giọng & Bộ dịch`
        : 'DubCera đang TẮT — Bấm để Bật | Bấm ⚙ (hoặc chuột phải) để chọn Giọng & Bộ dịch';

      // Build DOM nodes without innerHTML so strict TrustedHTML CSP never blocks rendering
      playerToggleBtn.replaceChildren();

      const pill = document.createElement('span');
      pill.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:5px',
        'padding:3px 8px',
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

      const sep = document.createElement('span');
      sep.style.cssText = 'opacity:0.45;margin:0 1px;font-weight:400;';
      sep.textContent = '|';

      const gear = document.createElement('span');
      gear.setAttribute('data-dc-gear', '1');
      gear.title = 'Mở Cài đặt Giọng đọc & Bộ dịch';
      gear.style.cssText = `font-size:12.5px;line-height:1;padding:0 2px;color:${settingsPopoverOpen ? '#38BDF8' : '#E2E8F0'};`;
      gear.textContent = '⚙';

      pill.appendChild(dot);
      pill.appendChild(label);
      pill.appendChild(sep);
      pill.appendChild(gear);
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
      const plyrControls = ytRightControls
        ? null
        : (document.querySelector('.plyr__controls') as HTMLElement | null);
      const playkitRightControls =
        ytRightControls || plyrControls
          ? null
          : (document.querySelector('.playkit-right-controls') as HTMLElement | null);
      const udemyAnchor =
        ytRightControls || plyrControls || playkitRightControls
          ? null
          : findUdemyHorizontalRowAnchor();

      const targetParent =
        ytRightControls ?? plyrControls ?? playkitRightControls ?? udemyAnchor?.row ?? null;
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
        const targetEl = ev.target as HTMLElement | null;
        if (targetEl?.closest('[data-dc-gear="1"]')) {
          togglePlayerSettingsPopover();
          return;
        }
        handleToggleClick();
      });

      btn.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        togglePlayerSettingsPopover();
      });

      const plyrBeforeEl = plyrControls
        ? ((plyrControls.querySelector('[data-plyr="captions"], .plyr__menu, [data-plyr="fullscreen"]') as HTMLElement | null) ??
          null)
        : null;
      const playkitBeforeEl = playkitRightControls
        ? ((playkitRightControls.querySelector('.playkit-control-captions-control, .playkit-control-fullscreen') as HTMLElement | null) ??
          playkitRightControls.firstChild)
        : null;
      const beforeEl = ytRightControls
        ? ytRightControls.firstChild
        : plyrControls
          ? plyrBeforeEl
          : playkitRightControls
            ? playkitBeforeEl
            : (udemyAnchor?.beforeNode ?? null);
      targetParent.insertBefore(btn, beforeEl);
      playerToggleBtn = btn;
      updatePlayerToggleButtonAppearance();
    }

    // Capture-phase guard for YouTube & Udemy external pause controls (`Space` / `K` / Play-Pause button)
    // Plus dedicated deterministic Space (Play/Pause) & Left/Right (±10s) shortcuts for Bunny/FastTrack
    function executeBunnyPlayerCommand(
      action: 'toggle-play' | 'seek-by',
      deltaSec = 0,
    ): void {
      const video =
        activeVideo ??
        (document.querySelector('video#main-video') as HTMLVideoElement | null) ??
        (document.querySelector('video') as HTMLVideoElement | null);
      if (!video) return;

      if (action === 'toggle-play') {
        if (coordinator && latestSnapshot?.playbackState.isBuffering) {
          coordinator.requestExplicitUserPause();
          showShortcutHud('⏸ Tạm dừng');
          return;
        }
        if (video.paused) {
          void video.play().catch(() => {});
          showShortcutHud('▶ Phát');
        } else {
          video.pause();
          showShortcutHud('⏸ Tạm dừng');
        }
        return;
      }

      if (action === 'seek-by' && Number.isFinite(deltaSec) && deltaSec !== 0) {
        const duration =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : Number.MAX_SAFE_INTEGER;
        const nextTime = Math.max(0, Math.min(duration, video.currentTime + deltaSec));
        video.currentTime = nextTime;
        showShortcutHud(deltaSec < 0 ? `⏪ ${deltaSec}s` : `⏩ +${deltaSec}s`);
      }
    }

    function setupExternalControlsCapture(): void {
      window.addEventListener(
        'keydown',
        (ev) => {
          const target = ev.target as HTMLElement | null;
          if (
            target &&
            (target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.tagName === 'SELECT' ||
              target.isContentEditable)
          ) {
            return;
          }

          if (isBunnyHost) {
            if (ev.key === 'Escape' && window !== window.top) {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              window.parent.postMessage(
                { source: 'dubcera-bunny', type: 'DUBCERA_EXIT_THEATER' },
                '*',
              );
              return;
            }
            if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

            if (ev.code === 'Space' || ev.key === ' ') {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              executeBunnyPlayerCommand('toggle-play');
              return;
            }
            if (ev.key === 'ArrowLeft') {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              executeBunnyPlayerCommand('seek-by', -10);
              return;
            }
            if (ev.key === 'ArrowRight') {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              executeBunnyPlayerCommand('seek-by', 10);
              return;
            }
            return;
          }

          if (!coordinator || !latestSnapshot?.playbackState.isBuffering) return;
          if (ev.code === 'Space' || ev.key.toLowerCase() === 'k') {
            coordinator.requestExplicitUserPause();
          }
        },
        true,
      );

      if (isBunnyHost) {
        window.addEventListener('message', (ev: MessageEvent) => {
          if (
            ev.origin !== 'https://fasttracktutorials.com' &&
            ev.origin !== 'https://www.fasttracktutorials.com'
          ) {
            return;
          }
          const data = ev.data as {
            source?: string;
            type?: string;
            action?: 'toggle-play' | 'seek-by';
            deltaSec?: number;
          } | null;
          if (data?.source !== 'dubcera-fasttrack' || data.type !== 'DUBCERA_PLAYER_CMD') {
            return;
          }
          if (data.action === 'toggle-play' || data.action === 'seek-by') {
            executeBunnyPlayerCommand(data.action, data.deltaSec ?? 0);
          }
        });
      }

      window.addEventListener(
        'click',
        (ev) => {
          if (!coordinator || !latestSnapshot?.playbackState.isBuffering) return;
          const el = ev.target as HTMLElement | null;
          if (
            el?.closest(
              '.ytp-play-button, [data-purpose="play-button"], [data-purpose="pause-button"], .plyr__control[data-plyr="play"], .playkit-control-play-pause button',
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
      const showFallbackCornerPill =
        isBunnyHost || !playerToggleBtn || !playerToggleBtn.isConnected;
      const { badgeText, accentColor } = computeBadgeVisuals();
      const bunnyStatusText =
        captionState === 'LOADING'
          ? 'Đang lấy phụ đề tiếng Anh...'
          : captionState === 'MISSING'
            ? 'Không tìm thấy phụ đề tiếng Anh'
            : (latestSnapshot?.statusBanner ?? 'Sẵn sàng');

      reactRoot.render(
        <React.StrictMode>
          {showFallbackCornerPill && (
            <div
              data-dc-corner-bar="1"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: `${cornerBarPos.y}px`,
                left: `${cornerBarPos.x}px`,
                zIndex: 2147483644,
                pointerEvents: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                maxWidth: 'calc(100% - 24px)',
                userSelect: 'none',
                touchAction: 'none',
              }}
            >
              <span
                onPointerDown={startCornerBarDrag}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  cornerBarPos = { x: 16, y: 14 };
                  try {
                    localStorage.setItem(CORNER_BAR_POS_KEY, JSON.stringify(cornerBarPos));
                  } catch {
                    // Ignore
                  }
                  renderOverlayUI();
                }}
                title="Giữ và kéo để di chuyển thanh DubCera | Nháy đúp để về góc trên-trái"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '5px 6px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.84)',
                  border: '1px solid rgba(148, 163, 184, 0.4)',
                  color: '#94A3B8',
                  fontSize: '12px',
                  lineHeight: 1,
                  cursor: cornerBarDragging ? 'grabbing' : 'grab',
                }}
              >
                ⋮⋮
              </span>
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
                  togglePlayerSettingsPopover();
                }}
                title="Bấm để Bật/Tắt DubCera | Chuột phải mở Cài đặt Giọng đọc"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.84)',
                  border: `1.5px solid ${accentColor}`,
                  color: '#F8FAFC',
                  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                  fontSize: '11.5px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
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
              {isBunnyHost && currentSettings.enabled && !cornerBarCollapsed && (
                <div
                  onPointerDown={startCornerBarDrag}
                  title="Giữ và kéo để di chuyển"
                  style={{
                    padding: '5px 10px',
                    borderRadius: '8px',
                    background: 'rgba(15, 23, 42, 0.82)',
                    border: '1px solid rgba(148, 163, 184, 0.35)',
                    color: '#E2E8F0',
                    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                    fontSize: '11.5px',
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: cornerBarDragging ? 'grabbing' : 'grab',
                  }}
                >
                  {bunnyStatusText}
                </div>
              )}
              {isBunnyHost && currentSettings.enabled && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cornerBarCollapsed = !cornerBarCollapsed;
                    renderOverlayUI();
                  }}
                  title={cornerBarCollapsed ? 'Hiện dòng trạng thái' : 'Thu gọn dòng trạng thái'}
                  style={{
                    padding: '5px 7px',
                    borderRadius: '8px',
                    background: 'rgba(15, 23, 42, 0.84)',
                    border: '1px solid rgba(148, 163, 184, 0.4)',
                    color: '#CBD5E1',
                    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                    fontSize: '11.5px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {cornerBarCollapsed ? '›' : '‹'}
                </button>
              )}
              {isBunnyHost && captionState === 'MISSING' && currentSettings.enabled && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    missingRetryCount = 0;
                    captionState = 'IDLE';
                    void tryAttachToPageVideo();
                  }}
                  style={{
                    padding: '5px 9px',
                    borderRadius: '8px',
                    background: 'rgba(248, 113, 113, 0.22)',
                    border: '1px solid rgba(248, 113, 113, 0.6)',
                    color: '#FECACA',
                    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                    fontSize: '11.5px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  ↻ Thử lại
                </button>
              )}
              {isBunnyHost && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    togglePlayerSettingsPopover();
                  }}
                  title="Mở Cài đặt Giọng đọc, Bộ dịch & Auto Theater"
                  style={{
                    padding: '5px 9px',
                    borderRadius: '8px',
                    background: settingsPopoverOpen
                      ? 'rgba(14, 165, 233, 0.35)'
                      : 'rgba(15, 23, 42, 0.84)',
                    border: '1px solid rgba(56, 189, 248, 0.5)',
                    color: '#E0F2FE',
                    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ⚙
                </button>
              )}
            </div>
          )}
          {shortcutHudText && (
            <div
              style={{
                position: 'absolute',
                top: '18%',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2147483645,
                pointerEvents: 'none',
                padding: '7px 16px',
                borderRadius: '10px',
                background: 'rgba(15, 23, 42, 0.86)',
                border: '1px solid rgba(56, 189, 248, 0.5)',
                color: '#F8FAFC',
                fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                fontSize: '15px',
                fontWeight: 700,
                letterSpacing: '0.02em',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
              }}
            >
              {shortcutHudText}
            </div>
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
          <PlayerSettingsPopover
            open={settingsPopoverOpen}
            settings={currentSettings}
            onUpdateSettings={handleInlineSettingsUpdate}
            onClose={() => {
              settingsPopoverOpen = false;
              updatePlayerToggleButtonAppearance();
              if (!currentSettings.enabled) {
                cleanupCurrentSession();
              } else {
                renderOverlayUI();
              }
            }}
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
        video.closest('.plyr') ??
        video.closest('.playkit-player') ??
        video.closest('.kaltura-player-container') ??
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
      platform: 'youtube' | 'udemy' | 'bunny' | 'gnomon',
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
        { prewarmOnPausedEntry: platform === 'bunny' || platform === 'gnomon' },
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

    // 3. Listen for The Gnomon Workshop (Kaltura) lesson switches & WebVTT caption responses
    window.addEventListener('dubcera:gnomon-lesson-ready', (ev: Event) => {
      const customEv = ev as CustomEvent<{ entryId?: string }>;
      const entryId = customEv.detail?.entryId?.trim();
      if (!entryId) return;
      if (entryId !== latestGnomonEntryId) {
        latestGnomonEntryId = entryId;
        missingRetryCount = 0;
        void tryAttachToPageVideo();
      }
    });

    window.addEventListener('dubcera:gnomon-captions-result', (ev: Event) => {
      const customEv = ev as CustomEvent<{
        videoId?: string;
        ok?: boolean;
        vttText?: string;
        vttUrl?: string;
      }>;
      const detail = customEv.detail;
      if (!detail || !detail.videoId) return;
      if (detail.videoId !== activeVideoId || !activeVideo) return;
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

        if (!rawVtt || targetVideo !== activeVideo || targetVideoId !== activeVideoId || coordinator) {
          if (!coordinator && targetVideoId === activeVideoId) {
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

        await startCoordinatorWithCues(targetVideo, 'gnomon', targetVideoId, cues);
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
      if (!settingsInitialized) {
        currentSettings = await loadSettings();
        lastCacheInvalidatedAtMs = currentSettings.cacheInvalidatedAtMs;
        settingsInitialized = true;
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

      const video = (
        meta.platform === 'bunny'
          ? (document.querySelector('video#main-video') ?? document.querySelector('video'))
          : document.querySelector('video')
      ) as HTMLVideoElement | null;
      if (!video) return;

      if (!currentSettings.enabled) {
        if (coordinator) {
          coordinator.dispose();
          coordinator = null;
          latestSnapshot = null;
        }
        if (shadowHost && !settingsPopoverOpen) {
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
      } else if (meta.platform === 'bunny') {
        captionState = 'LOADING';
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();

        const bunnyResult = await extractBunnyEnglishCues(video, fetchVttViaBackgroundOrDirect);
        if (video !== activeVideo || meta.videoId !== activeVideoId || coordinator) {
          return;
        }
        if (bunnyResult.cues.length > 0) {
          await startCoordinatorWithCues(video, 'bunny', meta.videoId, bunnyResult.cues);
        } else {
          captionState = 'MISSING';
          updatePlayerToggleButtonAppearance();
          renderOverlayUI();
        }
      } else if (meta.platform === 'gnomon') {
        captionState = 'LOADING';
        updatePlayerToggleButtonAppearance();
        renderOverlayUI();

        const domCues = await extractStandardHtml5Cues(video);
        if (video !== activeVideo || meta.videoId !== activeVideoId || coordinator) {
          return;
        }
        if (domCues.length > 0) {
          await startCoordinatorWithCues(video, 'gnomon', meta.videoId, domCues);
        } else {
          window.dispatchEvent(
            new CustomEvent('dubcera:request-gnomon-captions', {
              detail: { videoId: meta.videoId },
            }),
          );
        }
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

    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes['dubcera_settings_v1']) return;
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

    // Fast initial mount + zero-IPC SPA check (skips hidden idle tabs completely)
    void tryAttachToPageVideo();
    setInterval(() => {
      if (document.hidden && !coordinator) return;
      ensurePlayerControlBarButton();
      void tryAttachToPageVideo();
    }, 2000);
  },
});
