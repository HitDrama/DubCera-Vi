export interface ActiveSegmentProgress {
  segmentIndex: number;
  progressRatio: number; // 0.0 -> 1.0
}

/**
 * Enforces Invariant I3 (strictly single sequential voice stream, zero overlap)
 * and Sliding Window Blob URL cleanup so 60-120 minute lectures never leak browser RAM.
 */
export class SingleAudioQueue {
  private readonly audioEl: HTMLAudioElement;
  private blobUrlCache = new Map<string, string>(); // audioCacheKey -> blob: URL
  private accessOrder: string[] = [];
  private readonly maxCachedBlobs = 6;
  private currentRejectOrFinish: (() => void) | null = null;
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

  public stopImmediate(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    this.onProgress?.(null);

    if (this.currentRejectOrFinish) {
      const resolvePrev = this.currentRejectOrFinish;
      this.currentRejectOrFinish = null;
      resolvePrev();
    }
  }

  public dispose(): void {
    this.stopImmediate();
    for (const url of this.blobUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrlCache.clear();
    this.accessOrder = [];
  }

  /**
   * Plays a single segment from start to finish at `effectiveSpeechRate` with pitch preservation.
   * Never clips trailing PCM samples (Invariant I2).
   */
  public async playSegment(params: {
    segmentIndex: number;
    blobUrl: string;
    effectiveSpeechRate: number;
    volume?: number;
  }): Promise<void> {
    this.stopImmediate();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.rafHandle !== null) {
          cancelAnimationFrame(this.rafHandle);
          this.rafHandle = null;
        }
        this.currentRejectOrFinish = null;
        this.onProgress?.(null);
        resolve();
      };

      this.currentRejectOrFinish = finish;

      this.audioEl.src = params.blobUrl;
      this.audioEl.volume = Math.max(0, Math.min(1, params.volume ?? 1.0));
      this.audioEl.preservesPitch = true;
      this.audioEl.playbackRate = params.effectiveSpeechRate;

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
          this.currentRejectOrFinish = null;
          this.onProgress?.(null);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
