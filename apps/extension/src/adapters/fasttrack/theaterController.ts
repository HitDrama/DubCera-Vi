import { isBunnyEmbedUrl } from '../bunny/bunnyStreamAdapter';

export const THEATER_STYLE_ID = 'dubcera-fasttrack-theater-styles';
export const THEATER_ACTIVE_CLASS = 'dubcera-ft-theater-active';
export const THEATER_MODAL_CLASS = 'dubcera-ft-theater-modal';
export const THEATER_MINIMIZE_BTN_CLASS = 'dubcera-ft-theater-minimize-btn';
export const THEATER_EXPAND_BTN_CLASS = 'dubcera-ft-theater-expand-btn';

export interface ActiveFastTrackPopup {
  popup: HTMLElement;
  iframe: HTMLIFrameElement;
  modal: HTMLElement | null;
  videoKey: string;
}

interface SavedRestoreSnapshot {
  windowScrollX: number;
  windowScrollY: number;
  modalScrollTop: number;
  previousActiveElement: HTMLElement | null;
}

/**
 * Finds the currently visible FastTrack `.iframe-popup` containing an active Bunny Stream iframe.
 * Ignores YouTube preview iframes and hidden/empty `src=""` lesson iframes.
 */
export function findActiveFastTrackBunnyPopup(root: Document = document): ActiveFastTrackPopup | null {
  const popups = Array.from(root.querySelectorAll<HTMLElement>('.iframe-popup'));
  for (const popup of popups) {
    const iframe = popup.querySelector<HTMLIFrameElement>('iframe.iframe-video, iframe');
    if (!iframe) continue;

    const src = iframe.getAttribute('src') ?? '';
    if (!src || !isBunnyEmbedUrl(src)) continue;

    const cs = getComputedStyle(popup);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;

    const modal = popup.closest<HTMLElement>('#watchNowModal, .modal');
    const videoKey = src.split('?')[0] ?? src;
    return { popup, iframe, modal, videoKey };
  }
  return null;
}

export function ensureTheaterStylesInjected(doc: Document = document): void {
  if (doc.getElementById(THEATER_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = THEATER_STYLE_ID;
  style.textContent = `
    .${THEATER_MODAL_CLASS} {
      z-index: 2147483000 !important;
    }

    .${THEATER_MODAL_CLASS} .modal-dialog {
      transform: none !important;
    }

    .iframe-popup.${THEATER_ACTIVE_CLASS} {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      z-index: 2147483001 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      background: rgba(5, 8, 15, 0.94) !important;
      overflow: hidden !important;
    }

    .iframe-popup.${THEATER_ACTIVE_CLASS} > iframe.iframe-video,
    .iframe-popup.${THEATER_ACTIVE_CLASS} > iframe {
      position: relative !important;
      top: auto !important;
      left: auto !important;
      width: min(96vw, calc(92vh * 16 / 9)) !important;
      height: min(92vh, calc(96vw * 9 / 16)) !important;
      max-width: 96vw !important;
      max-height: 92vh !important;
      border: 0 !important;
      border-radius: 8px !important;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.78) !important;
      flex: 0 0 auto !important;
    }

    .iframe-popup.${THEATER_ACTIVE_CLASS} > .close-button {
      position: fixed !important;
      top: 14px !important;
      right: 18px !important;
      z-index: 2147483003 !important;
      width: 34px !important;
      height: 34px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border-radius: 8px !important;
      background: rgba(15, 23, 42, 0.85) !important;
      border: 1px solid rgba(148, 163, 184, 0.4) !important;
      opacity: 0.92 !important;
      transition: opacity 0.15s ease, background 0.15s ease !important;
    }

    .iframe-popup.${THEATER_ACTIVE_CLASS} > .close-button:hover {
      opacity: 1 !important;
      background: rgba(239, 68, 68, 0.85) !important;
    }

    .${THEATER_MINIMIZE_BTN_CLASS} {
      position: fixed !important;
      top: 14px !important;
      right: 60px !important;
      z-index: 2147483003 !important;
      height: 34px !important;
      padding: 0 12px !important;
      border-radius: 8px !important;
      border: 1px solid rgba(56, 189, 248, 0.55) !important;
      background: rgba(15, 23, 42, 0.88) !important;
      color: #F8FAFC !important;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
    }

    .${THEATER_MINIMIZE_BTN_CLASS}:hover {
      background: rgba(14, 165, 233, 0.35) !important;
    }

    .${THEATER_EXPAND_BTN_CLASS} {
      position: absolute !important;
      top: 6px !important;
      left: 8px !important;
      z-index: 25 !important;
      padding: 4px 9px !important;
      border-radius: 6px !important;
      border: 1px solid rgba(56, 189, 248, 0.6) !important;
      background: rgba(15, 23, 42, 0.86) !important;
      color: #E0F2FE !important;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
    }

    .${THEATER_EXPAND_BTN_CLASS}:hover {
      background: rgba(14, 165, 233, 0.45) !important;
    }
  `;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * Controls Auto Theater Mode on FastTrackTutorials by toggling CSS classes on the existing
 * `.iframe-popup` container — NEVER creating a new iframe, changing `src`, or moving the iframe
 * in the DOM so playback and caption state remain 100% intact.
 */
export class FastTrackTheaterController {
  private autoEnabled = true;
  private activePopup: HTMLElement | null = null;
  private activeModal: HTMLElement | null = null;
  private activeVideoKey = '';
  private dismissedVideoKey = '';
  private restoreSnapshot: SavedRestoreSnapshot | null = null;
  private minimizeBtn: HTMLButtonElement | null = null;
  private expandBtn: HTMLButtonElement | null = null;
  private observer: MutationObserver | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly boundKeydown: (ev: KeyboardEvent) => void;
  private readonly boundDocumentClick: (ev: MouseEvent) => void;
  private readonly boundWindowMessage: (ev: MessageEvent) => void;

  constructor(private readonly doc: Document = document) {
    this.boundWindowMessage = (ev: MessageEvent) => {
      if (ev.origin !== 'https://iframe.mediadelivery.net') return;
      const data = ev.data as { source?: string; type?: string } | null;
      if (data?.source === 'dubcera-bunny' && data.type === 'DUBCERA_EXIT_THEATER') {
        if (this.activePopup) {
          this.exitTheater(true);
        }
      }
    };

    this.boundKeydown = (ev: KeyboardEvent) => {
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

      if (ev.key === 'Escape' && this.activePopup) {
        ev.preventDefault();
        ev.stopPropagation();
        this.exitTheater(true);
        return;
      }

      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

      const active = findActiveFastTrackBunnyPopup(this.doc);
      if (!active?.iframe.contentWindow) return;

      if (ev.code === 'Space' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        active.iframe.contentWindow.postMessage(
          { source: 'dubcera-fasttrack', type: 'DUBCERA_PLAYER_CMD', action: 'toggle-play' },
          'https://iframe.mediadelivery.net',
        );
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        ev.stopPropagation();
        active.iframe.contentWindow.postMessage(
          {
            source: 'dubcera-fasttrack',
            type: 'DUBCERA_PLAYER_CMD',
            action: 'seek-by',
            deltaSec: -10,
          },
          'https://iframe.mediadelivery.net',
        );
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        ev.stopPropagation();
        active.iframe.contentWindow.postMessage(
          {
            source: 'dubcera-fasttrack',
            type: 'DUBCERA_PLAYER_CMD',
            action: 'seek-by',
            deltaSec: 10,
          },
          'https://iframe.mediadelivery.net',
        );
      }
    };

    this.boundDocumentClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      // User clicked Watch/Watched on a lesson -> allow Auto Theater for the new lesson
      if (target.closest('.PlayVideoBtn')) {
        this.dismissedVideoKey = '';
        this.scheduleSync(80);
        this.scheduleSync(320);
        return;
      }

      // User clicked FastTrack's native close button -> cleanly exit Theater so site closes video
      if (target.closest('.iframe-popup .close-button')) {
        this.dismissedVideoKey = '';
        this.exitTheater(false);
      }
    };
  }

  public start(autoEnabled: boolean): void {
    this.autoEnabled = autoEnabled;
    ensureTheaterStylesInjected(this.doc);

    this.doc.addEventListener('keydown', this.boundKeydown, true);
    this.doc.addEventListener('click', this.boundDocumentClick, true);
    window.addEventListener('message', this.boundWindowMessage);

    this.observer = new MutationObserver(() => {
      this.scheduleSync(60);
    });
    if (this.doc.body) {
      this.observer.observe(this.doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'src'],
      });
    }

    this.sync();
  }

  public setAutoEnabled(enabled: boolean): void {
    this.autoEnabled = enabled;
    if (!enabled) {
      this.exitTheater(false);
    } else {
      this.dismissedVideoKey = '';
      this.sync();
    }
  }

  public isTheaterActive(): boolean {
    return this.activePopup !== null && this.activePopup.classList.contains(THEATER_ACTIVE_CLASS);
  }

  public enterTheater(target: ActiveFastTrackPopup): void {
    if (this.activePopup === target.popup && this.isTheaterActive()) {
      return;
    }

    // If switching from another popup, clean it up first
    if (this.activePopup && this.activePopup !== target.popup) {
      this.exitTheater(false);
    }

    ensureTheaterStylesInjected(this.doc);
    this.removeExpandButton();

    this.restoreSnapshot = {
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
      modalScrollTop: target.modal?.scrollTop ?? 0,
      previousActiveElement:
        this.doc.activeElement instanceof HTMLElement ? this.doc.activeElement : null,
    };

    target.modal?.classList.add(THEATER_MODAL_CLASS);
    target.popup.classList.add(THEATER_ACTIVE_CLASS);

    this.activePopup = target.popup;
    this.activeModal = target.modal;
    this.activeVideoKey = target.videoKey;

    this.mountMinimizeButton(target.popup);
  }

  public exitTheater(markDismissedForCurrentVideo: boolean): void {
    const prevPopup = this.activePopup;
    const prevModal = this.activeModal;
    const prevKey = this.activeVideoKey;
    const snapshot = this.restoreSnapshot;

    if (markDismissedForCurrentVideo && prevKey) {
      this.dismissedVideoKey = prevKey;
    }

    this.removeMinimizeButton();

    prevPopup?.classList.remove(THEATER_ACTIVE_CLASS);
    prevModal?.classList.remove(THEATER_MODAL_CLASS);

    this.activePopup = null;
    this.activeModal = null;
    this.activeVideoKey = '';
    this.restoreSnapshot = null;

    if (snapshot) {
      if (prevModal) {
        prevModal.scrollTop = snapshot.modalScrollTop;
      }
      window.scrollTo(snapshot.windowScrollX, snapshot.windowScrollY);
      if (snapshot.previousActiveElement && snapshot.previousActiveElement.isConnected) {
        try {
          snapshot.previousActiveElement.focus({ preventScroll: true });
        } catch {
          // Ignore focus errors
        }
      }
    }

    // If user minimized while the inline video is still visible, offer a compact button to re-expand
    if (markDismissedForCurrentVideo && prevPopup && prevPopup.isConnected) {
      const stillActive = findActiveFastTrackBunnyPopup(this.doc);
      if (stillActive && stillActive.popup === prevPopup) {
        this.mountExpandButton(stillActive);
      }
    }
  }

  public sync(): void {
    const active = findActiveFastTrackBunnyPopup(this.doc);

    if (!active) {
      if (this.activePopup) {
        this.exitTheater(false);
      }
      this.removeExpandButton();
      this.dismissedVideoKey = '';
      return;
    }

    // If a different lesson opened, clear previous dismissal
    if (this.dismissedVideoKey && this.dismissedVideoKey !== active.videoKey) {
      this.dismissedVideoKey = '';
    }

    if (this.activePopup && this.activePopup !== active.popup) {
      this.exitTheater(false);
    }

    if (this.autoEnabled && this.dismissedVideoKey !== active.videoKey) {
      this.enterTheater(active);
    } else if (!this.isTheaterActive()) {
      this.mountExpandButton(active);
    }
  }

  public dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener('keydown', this.boundKeydown, true);
    this.doc.removeEventListener('click', this.boundDocumentClick, true);
    window.removeEventListener('message', this.boundWindowMessage);
    this.exitTheater(false);
    this.removeExpandButton();
  }

  private scheduleSync(delayMs: number): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, delayMs);
  }

  private mountMinimizeButton(popup: HTMLElement): void {
    this.removeMinimizeButton();
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = THEATER_MINIMIZE_BTN_CLASS;
    btn.textContent = 'Thu nhỏ (Esc)';
    btn.title = 'Thoát chế độ Theater (không tắt video)';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.exitTheater(true);
    });
    popup.appendChild(btn);
    this.minimizeBtn = btn;
  }

  private removeMinimizeButton(): void {
    this.minimizeBtn?.remove();
    this.minimizeBtn = null;
  }

  private mountExpandButton(target: ActiveFastTrackPopup): void {
    if (this.expandBtn && target.popup.contains(this.expandBtn)) return;
    this.removeExpandButton();
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = THEATER_EXPAND_BTN_CLASS;
    btn.textContent = '⛶ Theater';
    btn.title = 'Mở rộng video trong tab (không fullscreen)';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.dismissedVideoKey = '';
      this.enterTheater(target);
    });
    target.popup.appendChild(btn);
    this.expandBtn = btn;
  }

  private removeExpandButton(): void {
    this.expandBtn?.remove();
    this.expandBtn = null;
  }
}
