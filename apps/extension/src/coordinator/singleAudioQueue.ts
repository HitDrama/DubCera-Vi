export interface ActiveSegmentProgress {
  segmentIndex: number;
  progressRatio: number; // 0.0 -> 1.0
}

export interface PausedAudioBookmark {
  segmentIndex: number;
  audioCacheKey: string;
  resumeOffsetSec: number;
  effectiveSpeechRate: number;
}

/**
 * Enforces Invariant I3 (strictly single sequential voice stream, zero overlap),
 * supports exact-millisecond Pause -> Resume bookmarks, and maintains a Sliding Window
 * Blob URL cache so 60-120 minute lectures never leak browser RAM.
 */
export class SingleAudioQueue {
  private readonly audioEl: HTMLAudioElement;
  private blobUrlCache = new Map<string, string>(); // audioCacheKey -> blob: URL
  private accessOrder: string[] = [];
  private readonly maxCachedBlobs = 6;
  private currentRejectOrFinish: (() => void) | null = null;
  private activeMeta: {
    segmentIndex: number;
    audioCacheKey: string;
    effectiveSpeechRate: number;
  } | null = null;
  private rafHandle: number | null = null;

  constructor(private readonly onProgress?: (info: ActiveSegmentProgress | null) => void) {
    this.audioEl = new Audio();
    this.audioEl.preload = 'auto';
  }

  public storePreloadedBlobUrl(audioCacheKey: string, blobUrl: string): void {
    if (this.blobUrlCache.has(audioCacheKey)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    this.blobUrlCache.set(audioCacheKey, blobUrl);
    this.accessOrder.push(audioCacheKey);

    while (this.accessOrder.length > this.maxCachedBlobs) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) {
        const url = this.blobUrlCache.get(oldestKey);
        if (url && this.audioEl.src !== url) {
          URL.revokeObjectURL(url);
          this.blobUrlCache.delete(oldestKey);
        }
      }
    }
  }

  public hasPreloaded(audioCacheKey: string): boolean {
    return this.blobUrlCache.has(audioCacheKey);
  }

  public getBlobUrl(audioCacheKey: string): string | undefined {
    return this.blobUrlCache.get(audioCacheKey);
  }

  /**
   * Captures the exact playback position when the user pauses mid-sentence so pressing Play
   * without seeking continues smoothly from the exact syllable instead of restarting at rapid speed.
   */
  public capturePauseAndStop(): PausedAudioBookmark | null {
    let bookmark: PausedAudioBookmark | null = null;
    if (
      this.activeMeta &&
      !this.audioEl.paused &&
      Number.isFinite(this.audioEl.currentTime) &&
      this.audioEl.currentTime > 0.08
    ) {
      const dur = this.audioEl.duration;
      const remaining = Number.isFinite(dur) ? dur - this.audioEl.currentTime : 1.0;
      if (remaining > 0.15) {
        bookmark = {
          segmentIndex: this.activeMeta.segmentIndex,
          audioCacheKey: this.activeMeta.audioCacheKey,
          // Step back 120ms so resumed speech never sounds clipped mid-consonant
          resumeOffsetSec: Math.max(0, this.audioEl.currentTime - 0.12),
          effectiveSpeechRate: this.activeMeta.effectiveSpeechRate,
        };
      }
    }
    this.stopImmediate(false);
    return bookmark;
  }

  public stopImmediate(clearProgress = true): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.activeMeta = null;
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    if (clearProgress) {
      this.onProgress?.(null);
    }

    if (this.currentRejectOrFinish) {
      const resolvePrev = this.currentRejectOrFinish;
      this.currentRejectOrFinish = null;
      resolvePrev();
    }
  }

  public clearBlobCache(): void {
    for (const url of this.blobUrlCache.values()) {
      if (this.audioEl.src !== url) {
        URL.revokeObjectURL(url);
      }
    }
    this.blobUrlCache.clear();
    this.accessOrder = [];
  }

  public dispose(): void {
    this.stopImmediate();
    this.clearBlobCache();
  }

  /**
   * Plays a single segment from `startOffsetSec` (default 0) to finish at `effectiveSpeechRate`
   * with pitch preservation. Never clips trailing PCM samples (Invariant I2).
   */
  public async playSegment(params: {
    segmentIndex: number;
    audioCacheKey: string;
    blobUrl: string;
    effectiveSpeechRate: number;
    startOffsetSec?: number;
    volume?: number;
  }): Promise<void> {
    this.stopImmediate(false);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.rafHandle !== null) {
          cancelAnimationFrame(this.rafHandle);
          this.rafHandle = null;
        }
        this.activeMeta = null;
        this.currentRejectOrFinish = null;
        this.onProgress?.(null);
        resolve();
      };

      this.currentRejectOrFinish = finish;
      this.activeMeta = {
        segmentIndex: params.segmentIndex,
        audioCacheKey: params.audioCacheKey,
        effectiveSpeechRate: params.effectiveSpeechRate,
      };

      this.audioEl.src = params.blobUrl;
      this.audioEl.volume = Math.max(0, Math.min(1, params.volume ?? 1.0));
      this.audioEl.preservesPitch = true;
      this.audioEl.playbackRate = params.effectiveSpeechRate;

      const desiredOffset = Math.max(0, params.startOffsetSec ?? 0);
      const applyOffsetIfNeeded = () => {
        if (desiredOffset > 0.05) {
          try {
            const dur = this.audioEl.duration;
            this.audioEl.currentTime = Number.isFinite(dur)
              ? Math.min(desiredOffset, Math.max(0, dur - 0.1))
              : desiredOffset;
          } catch {
            // Browser will start at 0 if seek before metadata fails
          }
        }
      };

      if (this.audioEl.readyState >= 1) {
        applyOffsetIfNeeded();
      } else if (desiredOffset > 0.05) {
        this.audioEl.addEventListener('loadedmetadata', applyOffsetIfNeeded, { once: true });
      }

      const tickProgress = () => {
        if (settled) return;
        const dur = this.audioEl.duration;
        if (Number.isFinite(dur) && dur > 0) {
          const ratio = Math.max(0, Math.min(1, this.audioEl.currentTime / dur));
          this.onProgress?.({ segmentIndex: params.segmentIndex, progressRatio: ratio });
        }
        this.rafHandle = requestAnimationFrame(tickProgress);
      };

      this.audioEl.onended = () => finish();
      this.audioEl.onerror = () => {
        if (settled) return;
        settled = true;
        this.activeMeta = null;
        this.currentRejectOrFinish = null;
        this.onProgress?.(null);
        reject(new Error('HTMLAudioElement playback error'));
      };

      this.audioEl
        .play()
        .then(() => {
          if (!settled) {
            this.rafHandle = requestAnimationFrame(tickProgress);
          }
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          this.activeMeta = null;
          this.currentRejectOrFinish = null;
          this.onProgress?.(null);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
