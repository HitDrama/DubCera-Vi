import {
  buildAudioCacheKey,
  buildPreemptiveQueue,
  buildVideoManifestKey,
  canAutoResumeFromBuffer,
  computeConfigVersion,
  createInitialPlaybackState,
  enterDubBuffering,
  exitDubBuffering,
  getRequiredBufferIndices,
  groupCuesIntoSegments,
  markAutoplayRejected,
  planSegmentDualClock,
  predictLookaheadDrift,
  recordSeekInitiated,
  recordUserPauseIntent,
  recordUserPlayIntent,
  resolveSegmentIndexAtVideoTime,
  selectActiveDisplayChunk,
  sha256Hex,
  splitIntoDisplayChunks,
  type DisplayChunk,
  type PlaybackState,
  type SpeechSegment,
  type SubtitleCue,
  type TranslationProvider,
} from '@dubcera/core';
import { loadVideoManifest, saveVideoManifest, toPersistedSegments } from '../storage/manifestDb';
import { toSynthesisConfigSnapshot, type DubCeraSettings } from '../storage/settingsStore';
import { FreeWebTranslationProvider } from '../translation/freeWebProvider';
import { LlmApiTranslationProvider } from '../translation/llmApiProvider';
import { LocalTtsClient } from '../tts/localTtsClient';
import { SingleAudioQueue } from './singleAudioQueue';

export interface CoordinatorUiSnapshot {
  playbackState: PlaybackState;
  bufferingMessage: string | null;
  activeChunk: DisplayChunk | null;
  statusBanner: string;
  ttsDegradedSubtitleOnly: boolean;
  readyCount: number;
  translatedCount: number;
  totalSegments: number;
  segments: ReadonlyArray<SpeechSegment>;
}

export class AdaptiveSyncCoordinator {
  private playbackState: PlaybackState = createInitialPlaybackState();
  private segments: SpeechSegment[] = [];
  private videoKey = '';
  private subtitleHash = '';
  private activeConfigVersion = '';
  private ttsDegradedSubtitleOnly = false;
  private bufferingMessage: string | null = null;
  private statusBanner = 'Sẵn sàng';
  private activeChunk: DisplayChunk | null = null;

  private readonly ttsClient: LocalTtsClient;
  private readonly audioQueue: SingleAudioQueue;

  private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private workerLoopRunning = false;
  private playbackLoopId = 0;
  private prevAudioEndClockMs = 0;
  private originalUserVideoVolume = 1.0;
  private baseUserVideoRate = 1.0;
  private ignorePauseEventUntilMs = 0;
  private ignorePlayEventUntilMs = 0;
  private ignoreRateChangeUntilMs = 0;

  private readonly boundHandlers: {
    play: () => void;
    pause: () => void;
    seeking: () => void;
    seeked: () => void;
    ratechange: () => void;
    timeupdate: () => void;
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private settings: DubCeraSettings,
    private readonly platform: string,
    private readonly canonicalVideoId: string,
    private readonly onSnapshotChange: (snapshot: CoordinatorUiSnapshot) => void,
  ) {
    this.ttsClient = new LocalTtsClient(settings.localTtsUrl, settings.localTtsToken);
    this.audioQueue = new SingleAudioQueue((prog) => {
      if (!prog) return;
      const seg = this.segments[prog.segmentIndex];
      if (seg?.displayChunks && seg.displayChunks.length > 0) {
        const nextChunk = selectActiveDisplayChunk(seg.displayChunks, prog.progressRatio);
        if (nextChunk?.chunkId !== this.activeChunk?.chunkId) {
          this.activeChunk = nextChunk;
          this.emitSnapshot();
        }
      }
    });

    this.originalUserVideoVolume = video.volume;
    this.baseUserVideoRate = video.playbackRate || 1.0;

    this.boundHandlers = {
      play: () => this.handleNativePlayEvent(),
      pause: () => this.handleNativePauseEvent(),
      seeking: () => this.handleNativeSeekingEvent(),
      seeked: () => this.handleNativeSeekedEvent(),
      ratechange: () => this.handleNativeRateChangeEvent(),
      timeupdate: () => this.handleNativeTimeUpdate(),
    };
  }

  public async initializeWithCues(cues: SubtitleCue[]): Promise<void> {
    this.attachVideoListeners();
    const configSnap = toSynthesisConfigSnapshot(this.settings);
    this.activeConfigVersion = computeConfigVersion(configSnap);

    this.subtitleHash = sha256Hex(
      cues.map((c) => `${c.startMs}-${c.endMs}:${c.rawText}`).join('|'),
    ).slice(0, 24);
    this.videoKey = buildVideoManifestKey({
      platform: this.platform,
      canonicalVideoId: this.canonicalVideoId,
      subtitleHash: this.subtitleHash,
      targetLang: 'vi',
    });

    const freshSegments = groupCuesIntoSegments(cues, {
      configVersion: this.activeConfigVersion,
    });

    // 1. Hydrate persisted translations & audio keys from IndexedDB
    const persisted = await loadVideoManifest(this.videoKey);
    if (persisted && persisted.segments.length === freshSegments.length) {
      for (let i = 0; i < freshSegments.length; i++) {
        const saved = persisted.segments[i];
        const seg = freshSegments[i]!;
        if (saved && saved.sourceText === seg.sourceText && saved.translatedText) {
          seg.translatedText = saved.translatedText;
          seg.displayChunks = splitIntoDisplayChunks(seg.segmentId, saved.translatedText, seg.sourceText);
          seg.audioCacheKey = buildAudioCacheKey(saved.translatedText, configSnap);
          seg.status = 'TRANSLATED';
        }
      }
    }

    this.segments = freshSegments;

    // 2. Verify existing WAV artifacts on local disk in one batch call
    await this.verifyDiskCacheAndHealth();

    this.statusBanner = this.ttsDegradedSubtitleOnly
      ? 'Local TTS chưa bật — Đang chạy chế độ Phụ đề tiếng Việt'
      : `Đã nạp ${this.segments.length} câu thoại`;
    this.emitSnapshot();

    // Kick off background worker pipeline immediately
    void this.pumpPreparationQueue();

    if (!this.video.paused && this.settings.enabled) {
      this.playbackState = recordUserPlayIntent(this.playbackState);
      void this.coordinateAtPlayhead(this.video.currentTime * 1000);
    }
  }

  public async updateSettings(nextSettings: DubCeraSettings): Promise<void> {
    const prevConfigVer = this.activeConfigVersion;
    this.settings = nextSettings;
    this.ttsClient.updateCredentials(nextSettings.localTtsUrl, nextSettings.localTtsToken);

    const configSnap = toSynthesisConfigSnapshot(nextSettings);
    this.activeConfigVersion = computeConfigVersion(configSnap);

    if (!nextSettings.enabled) {
      this.audioQueue.stopImmediate();
      this.video.volume = this.originalUserVideoVolume;
      this.activeChunk = null;
      this.bufferingMessage = null;
      this.playbackState = exitDubBuffering(this.playbackState);
      this.statusBanner = 'Đã tắt lồng tiếng';
      this.emitSnapshot();
      return;
    }

    if (prevConfigVer !== this.activeConfigVersion) {
      // Voice/engine changed: keep all translatedText intact, recompute audioCacheKeys, re-verify disk cache!
      this.playbackState = recordSeekInitiated(this.playbackState);
      this.audioQueue.stopImmediate();
      for (const seg of this.segments) {
        seg.configVersion = this.activeConfigVersion;
        if (seg.translatedText) {
          seg.audioCacheKey = buildAudioCacheKey(seg.translatedText, configSnap);
          seg.status = 'TRANSLATED';
          seg.audioDurationMs = undefined;
        }
      }
      await this.verifyDiskCacheAndHealth();
      void this.pumpPreparationQueue();
      if (!this.video.paused) {
        void this.coordinateAtPlayhead(this.video.currentTime * 1000);
      }
    }
    this.emitSnapshot();
  }

  /**
   * Explicit UI button action when user clicks `[Tạm dừng]` right on the BufferingBadge
   */
  public requestExplicitUserPause(): void {
    this.playbackState = recordUserPauseIntent(this.playbackState);
    this.bufferingMessage = null;
    this.audioQueue.stopImmediate();
    if (!this.video.paused) {
      this.programmaticPauseVideo();
    }
    this.statusBanner = 'Đã tạm dừng';
    this.emitSnapshot();
  }

  /**
   * Explicit UI recovery action if browser blocked autoplay Promise
   */
  public async resumeAfterAutoplayBlock(): Promise<void> {
    this.playbackState = recordUserPlayIntent(this.playbackState);
    this.emitSnapshot();
    await this.coordinateAtPlayhead(this.video.currentTime * 1000);
  }

  public dispose(): void {
    if (this.seekDebounceTimer) clearTimeout(this.seekDebounceTimer);
    this.detachVideoListeners();
    this.audioQueue.dispose();
    this.video.volume = this.originalUserVideoVolume;
  }

  private attachVideoListeners(): void {
    this.video.addEventListener('play', this.boundHandlers.play);
    this.video.addEventListener('pause', this.boundHandlers.pause);
    this.video.addEventListener('seeking', this.boundHandlers.seeking);
    this.video.addEventListener('seeked', this.boundHandlers.seeked);
    this.video.addEventListener('ratechange', this.boundHandlers.ratechange);
    this.video.addEventListener('timeupdate', this.boundHandlers.timeupdate);
  }

  private detachVideoListeners(): void {
    this.video.removeEventListener('play', this.boundHandlers.play);
    this.video.removeEventListener('pause', this.boundHandlers.pause);
    this.video.removeEventListener('seeking', this.boundHandlers.seeking);
    this.video.removeEventListener('seeked', this.boundHandlers.seeked);
    this.video.removeEventListener('ratechange', this.boundHandlers.ratechange);
    this.video.removeEventListener('timeupdate', this.boundHandlers.timeupdate);
  }

  private programmaticPauseVideo(): void {
    if (!this.video.paused) {
      this.ignorePauseEventUntilMs = performance.now() + 250;
      this.video.pause();
    }
  }

  private async programmaticPlayVideo(): Promise<boolean> {
    if (!this.video.paused) return true;
    this.ignorePlayEventUntilMs = performance.now() + 250;
    try {
      await this.video.play();
      return true;
    } catch {
      this.playbackState = markAutoplayRejected(this.playbackState);
      this.statusBanner = 'Trình duyệt chặn tự phát — Bấm nút Tiếp tục';
      this.emitSnapshot();
      return false;
    }
  }

  private programmaticSetVideoRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(2.0, Number(rate.toFixed(2))));
    if (Math.abs(this.video.playbackRate - clamped) < 0.01) return;
    this.ignoreRateChangeUntilMs = performance.now() + 200;
    this.video.playbackRate = clamped;
  }

  private handleNativePlayEvent(): void {
    if (performance.now() < this.ignorePlayEventUntilMs) return;
    this.playbackState = recordUserPlayIntent(this.playbackState);
    if (!this.settings.enabled) return;
    void this.coordinateAtPlayhead(this.video.currentTime * 1000);
  }

  private handleNativePauseEvent(): void {
    if (performance.now() < this.ignorePauseEventUntilMs) return;
    if (this.video.ended) return;
    this.playbackState = recordUserPauseIntent(this.playbackState);
    this.bufferingMessage = null;
    this.audioQueue.stopImmediate();
    this.emitSnapshot();
  }

  private handleNativeSeekingEvent(): void {
    if (!this.settings.enabled) return;
    this.playbackState = recordSeekInitiated(this.playbackState);
    this.prevAudioEndClockMs = 0;
    this.audioQueue.stopImmediate();
    this.activeChunk = null;
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    this.emitSnapshot();
  }

  private handleNativeSeekedEvent(): void {
    if (!this.settings.enabled) return;
    const capturedSession = this.playbackState.sessionId;
    if (this.seekDebounceTimer) clearTimeout(this.seekDebounceTimer);

    // 200ms settle debounce prevents spamming GPU/Translator during rapid timeline scrubbing
    this.seekDebounceTimer = setTimeout(() => {
      if (capturedSession !== this.playbackState.sessionId) return;
      void this.pumpPreparationQueue();
      if (this.playbackState.intent === 'PLAY' || !this.video.paused) {
        this.playbackState = recordUserPlayIntent(this.playbackState);
        void this.coordinateAtPlayhead(this.video.currentTime * 1000);
      } else {
        // Update subtitle preview while paused at seek target
        const idx = resolveSegmentIndexAtVideoTime(this.segments, this.video.currentTime * 1000);
        const seg = idx >= 0 ? this.segments[idx] : undefined;
        this.activeChunk = seg?.displayChunks?.[0] ?? null;
        this.emitSnapshot();
      }
    }, 200);
  }

  private handleNativeRateChangeEvent(): void {
    if (performance.now() < this.ignoreRateChangeUntilMs) return;
    this.baseUserVideoRate = this.video.playbackRate || 1.0;
  }

  private handleNativeTimeUpdate(): void {
    if (!this.settings.enabled) return;
    // In Subtitle-Only fallback mode, render DisplayChunks directly off video.currentTime
    if (this.ttsDegradedSubtitleOnly) {
      const nowVideoMs = this.video.currentTime * 1000;
      const seg = this.segments.find((s) => nowVideoMs >= s.startMs && nowVideoMs <= s.endMs);
      if (seg?.displayChunks && seg.displayChunks.length > 0) {
        const span = Math.max(200, seg.endMs - seg.startMs);
        const progress = (nowVideoMs - seg.startMs) / span;
        this.activeChunk = selectActiveDisplayChunk(seg.displayChunks, progress);
      } else {
        this.activeChunk = null;
      }
      this.emitSnapshot();
    }
  }

  private async verifyDiskCacheAndHealth(): Promise<void> {
    try {
      await this.ttsClient.checkHealth(3000);
      this.ttsDegradedSubtitleOnly = false;
    } catch {
      this.ttsDegradedSubtitleOnly = true;
      return;
    }

    const keysToCheck = this.segments
      .map((s) => s.audioCacheKey)
      .filter((k): k is string => Boolean(k));

    if (keysToCheck.length === 0) return;

    try {
      const validMap = await this.ttsClient.verifyCachedKeys(keysToCheck);
      for (const seg of this.segments) {
        if (seg.audioCacheKey) {
          const hit = validMap[seg.audioCacheKey.toLowerCase()];
          if (hit) {
            seg.audioDurationMs = hit.audioDurationMs;
            seg.status = 'READY';
          }
        }
      }
    } catch {
      // Keep status as TRANSLATED so worker synthesizes on demand
    }
  }

  private getTranslationProvider(): TranslationProvider {
    if (this.settings.translationProvider === 'openai-compatible' && this.settings.llmEndpointUrl.trim()) {
      return new LlmApiTranslationProvider({
        endpointUrl: this.settings.llmEndpointUrl,
        apiKey: this.settings.llmApiKey,
        model: this.settings.llmModel || 'gpt-4o-mini',
      });
    }
    return new FreeWebTranslationProvider();
  }

  private isSegmentPlayable(seg: SpeechSegment): boolean {
    if (this.ttsDegradedSubtitleOnly) {
      return Boolean(seg.translatedText);
    }
    return seg.status === 'READY' && seg.configVersion === this.activeConfigVersion;
  }

  /**
   * Continuous background worker pulling from Two-Tier Preemptive Queue (P0 Urgent -> P1 Background)
   */
  private async pumpPreparationQueue(): Promise<void> {
    if (this.workerLoopRunning || !this.settings.enabled) return;
    this.workerLoopRunning = true;

    try {
      while (this.settings.enabled) {
        const playheadMs = this.video.currentTime * 1000;
        const queue = buildPreemptiveQueue(this.segments, playheadMs, this.activeConfigVersion);
        if (queue.length === 0) break;

        // If running in Subtitle-Only degraded mode, skip segments that already have translatedText
        const nextTask = this.ttsDegradedSubtitleOnly
          ? queue.find((t) => !this.segments[t.segmentIndex]?.translatedText)
          : queue[0];

        if (!nextTask) break;

        const targetSeg = this.segments[nextTask.segmentIndex]!;
        const capturedCfgVersion = this.activeConfigVersion;

        // Step A: Context-window batch translation if untranslated
        if (!targetSeg.translatedText) {
          const batchSize = nextTask.tier === 'P0_URGENT' ? 3 : 12;
          const batchIndices: number[] = [];
          for (
            let i = targetSeg.segmentIndex;
            i < Math.min(this.segments.length, targetSeg.segmentIndex + batchSize);
            i++
          ) {
            if (!this.segments[i]!.translatedText) {
              batchIndices.push(i);
            }
          }

          if (batchIndices.length > 0) {
            const firstIdx = batchIndices[0]!;
            const contextBefore: string[] = [];
            if (firstIdx >= 2) contextBefore.push(this.segments[firstIdx - 2]!.sourceText);
            if (firstIdx >= 1) contextBefore.push(this.segments[firstIdx - 1]!.sourceText);

            for (const idx of batchIndices) {
              this.segments[idx]!.status = 'TRANSLATING';
            }
            this.emitSnapshot();

            try {
              const provider = this.getTranslationProvider();
              const translatedItems = await provider.translateBatch({
                sourceLang: 'en',
                targetLang: 'vi',
                contextBefore,
                items: batchIndices.map((idx) => ({
                  segmentId: this.segments[idx]!.segmentId,
                  sourceText: this.segments[idx]!.sourceText,
                })),
              });

              const configSnap = toSynthesisConfigSnapshot(this.settings);
              for (const item of translatedItems) {
                const seg = this.segments.find((s) => s.segmentId === item.segmentId);
                if (seg) {
                  seg.translatedText = item.translatedText;
                  seg.displayChunks = splitIntoDisplayChunks(
                    seg.segmentId,
                    item.translatedText,
                    seg.sourceText,
                  );
                  seg.audioCacheKey = buildAudioCacheKey(item.translatedText, configSnap);
                  seg.status = 'TRANSLATED';
                }
              }

              await this.persistCurrentManifest();
              this.emitSnapshot();
            } catch (err) {
              for (const idx of batchIndices) {
                this.segments[idx]!.status = 'ERROR';
                this.segments[idx]!.errorMessage = err instanceof Error ? err.message : 'Lỗi dịch';
              }
              this.emitSnapshot();
              await new Promise((r) => setTimeout(r, 1200));
              continue;
            }
          }
        }

        // Step B: Synthesize WAV via local TTS service (unless degraded to Subtitle-Only)
        if (!this.ttsDegradedSubtitleOnly && targetSeg.translatedText && targetSeg.audioCacheKey) {
          targetSeg.status = 'SYNTHESIZING';
          this.emitSnapshot();

          try {
            const synthRes = await this.ttsClient.synthesize({
              audioCacheKey: targetSeg.audioCacheKey,
              text: targetSeg.translatedText,
              voiceId: this.settings.voiceId,
              engineId: this.settings.engineId,
              sampleRate: this.settings.sampleRate,
            });

            // ConfigVersion guard (Invariant I6): Only mark READY on active manifest if config hasn't changed mid-flight
            if (capturedCfgVersion === this.activeConfigVersion) {
              targetSeg.audioDurationMs = synthRes.audioDurationMs;
              targetSeg.status = 'READY';

              // Preload Blob URL into memory if segment is inside urgent lookahead window
              if (nextTask.tier === 'P0_URGENT' && !this.audioQueue.hasPreloaded(targetSeg.audioCacheKey)) {
                const blobUrl = await this.ttsClient.fetchAudioBlobUrl(targetSeg.audioCacheKey);
                this.audioQueue.storePreloadedBlobUrl(targetSeg.audioCacheKey, blobUrl);
              }

              await this.persistCurrentManifest();
              this.emitSnapshot();
            }
          } catch {
            // Ping health once; if server went down, switch gracefully to Subtitle-Only mode!
            try {
              await this.ttsClient.checkHealth(2000);
              targetSeg.status = 'ERROR';
              targetSeg.errorMessage = 'Lỗi tạo âm thanh câu này';
            } catch {
              this.ttsDegradedSubtitleOnly = true;
              this.video.volume = this.originalUserVideoVolume;
              this.statusBanner = 'Mất kết nối Local TTS — Đã chuyển sang hiện Phụ đề tiếng Việt';
            }
            this.emitSnapshot();
          }
        }
      }
    } finally {
      this.workerLoopRunning = false;
    }
  }

  /**
   * Coordinates Pause-Buffer-Resume Gate & Sequential Dual-Clock Playback starting from `targetVideoMs`.
   */
  private async coordinateAtPlayhead(targetVideoMs: number): Promise<void> {
    if (!this.settings.enabled || this.segments.length === 0) return;

    const myLoopId = ++this.playbackLoopId;
    const activeSession = this.playbackState.sessionId;
    void this.pumpPreparationQueue();

    const startIdx = resolveSegmentIndexAtVideoTime(this.segments, targetVideoMs);
    if (startIdx === -1) return;

    const firstSeg = this.segments[startIdx]!;
    // If playhead is in a long silent intro (> 5s before speech starts), let video play while preparing!
    if (firstSeg.startMs - targetVideoMs > 5000 && !this.isSegmentPlayable(firstSeg)) {
      const waitVideoMs = firstSeg.startMs - targetVideoMs - 1500;
      const waitWallMs = Math.max(200, waitVideoMs / Math.max(0.5, this.video.playbackRate));
      await new Promise((r) => setTimeout(r, waitWallMs));
      if (myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) return;
    }

    // Check required initial buffer window [k, k+1]
    const requiredIndices = getRequiredBufferIndices(this.segments, startIdx);
    const allReadyImmediately = requiredIndices.every((idx) =>
      this.isSegmentPlayable(this.segments[idx]!),
    );

    if (!allReadyImmediately) {
      const { nextState, snapshot } = enterDubBuffering(this.playbackState);
      this.playbackState = nextState;
      this.programmaticPauseVideo();

      const waitStartedMs = performance.now();
      while (true) {
        if (myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) return;
        if (this.playbackState.intent !== 'PLAY') return;

        const readyInWindow = requiredIndices.filter((idx) =>
          this.isSegmentPlayable(this.segments[idx]!),
        ).length;
        const errored = requiredIndices.some((idx) => this.segments[idx]!.status === 'ERROR');
        if (errored) break;

        if (readyInWindow >= requiredIndices.length) break;

        this.bufferingMessage = `Đang dịch & chuẩn bị giọng đọc... (${readyInWindow}/${requiredIndices.length})`;
        this.statusBanner = this.bufferingMessage;
        this.emitSnapshot();

        void this.pumpPreparationQueue();

        // Safety timeout: never trap user video forever if network/TTS hangs
        if (performance.now() - waitStartedMs > 12_000) {
          break;
        }
        await new Promise((r) => setTimeout(r, 120));
      }

      this.bufferingMessage = null;
      this.playbackState = exitDubBuffering(this.playbackState);
      this.emitSnapshot();

      const windowReadyNow = requiredIndices.some((idx) =>
        this.isSegmentPlayable(this.segments[idx]!),
      );
      if (!canAutoResumeFromBuffer(this.playbackState, snapshot, windowReadyNow)) {
        return;
      }

      const played = await this.programmaticPlayVideo();
      if (!played) return;
    }

    if (this.ttsDegradedSubtitleOnly) {
      this.video.volume = this.originalUserVideoVolume;
      return;
    }

    // Duck original video volume smoothly during Vietnamese dubbing
    this.video.volume = Math.max(0, Math.min(1, this.settings.originalVideoVolumeRatio));
    this.statusBanner = 'Đang phát lồng tiếng Việt';
    this.emitSnapshot();

    // Sequential Single-Voice Loop from startIdx -> end
    for (let idx = startIdx; idx < this.segments.length; idx++) {
      if (myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) return;
      if (this.playbackState.intent !== 'PLAY') return;

      const seg = this.segments[idx]!;
      void this.pumpPreparationQueue();

      // Wait until current video time reaches near segment.startMs
      while (true) {
        if (myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) return;
        if (this.playbackState.intent !== 'PLAY') return;
        const nowVideoMs = this.video.currentTime * 1000;
        const deltaVideoMs = seg.startMs - nowVideoMs;
        if (deltaVideoMs <= 80) break;
        await new Promise((r) => setTimeout(r, Math.min(100, deltaVideoMs / Math.max(0.5, this.video.playbackRate))));
      }

      // If this segment still isn't READY when playhead arrives, hold Buffer Gate cleanly!
      if (!this.isSegmentPlayable(seg) && seg.status !== 'ERROR') {
        await this.coordinateAtPlayhead(seg.startMs);
        return;
      }

      if (seg.status === 'ERROR' || !seg.audioCacheKey || !seg.audioDurationMs) {
        // Invariant I7: Never silently hide missing audio; show translated/source subtitle + banner
        this.activeChunk = seg.displayChunks?.[0] ?? {
          chunkId: `${seg.segmentId}-fallback`,
          text: seg.translatedText ?? seg.sourceText,
          weightRatio: 1,
        };
        this.statusBanner = 'Một câu thiếu âm thanh — Đang hiển thị phụ đề';
        this.emitSnapshot();
        continue;
      }

      // Lookahead 3-5 segments drift check
      const drift = predictLookaheadDrift({
        nowClockMs: performance.now(),
        currentVideoTimeMs: this.video.currentTime * 1000,
        userVideoRate: this.baseUserVideoRate,
        prevAudioEndClockMs: this.prevAudioEndClockMs,
        upcomingSegments: this.segments.slice(idx, idx + 5),
        syncMode: this.settings.syncMode,
        maxEffectiveSpeechRate: this.settings.maxEffectiveSpeechRate,
      });

      if (this.settings.syncMode === 'LEARNING_HOLD_VIDEO') {
        this.programmaticSetVideoRate(this.baseUserVideoRate * drift.recommendedVideoRateMultiplier);
      } else {
        this.programmaticSetVideoRate(this.baseUserVideoRate);
      }

      const schedule = planSegmentDualClock({
        nowClockMs: performance.now(),
        currentVideoTimeMs: this.video.currentTime * 1000,
        videoRate: this.video.playbackRate || 1.0,
        prevAudioEndClockMs: this.prevAudioEndClockMs,
        segmentStartVideoMs: seg.startMs,
        segmentEndVideoMs: seg.endMs,
        nextSegmentStartVideoMs: seg.nextSegmentStartMs,
        audioDurationMs: seg.audioDurationMs,
        maxEffectiveSpeechRate: this.settings.maxEffectiveSpeechRate,
      });

      const waitBeforeStartMs = Math.max(0, schedule.actualStartClockMs - performance.now());
      if (waitBeforeStartMs > 15) {
        await new Promise((r) => setTimeout(r, waitBeforeStartMs));
      }
      if (myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) return;

      let blobUrl = this.audioQueue.getBlobUrl(seg.audioCacheKey);
      if (!blobUrl) {
        try {
          blobUrl = await this.ttsClient.fetchAudioBlobUrl(seg.audioCacheKey);
          this.audioQueue.storePreloadedBlobUrl(seg.audioCacheKey, blobUrl);
        } catch {
          continue;
        }
      }

      this.playbackState = { ...this.playbackState, activeSegmentIndex: idx };
      this.activeChunk = seg.displayChunks?.[0] ?? null;
      this.emitSnapshot();

      try {
        await this.audioQueue.playSegment({
          segmentIndex: idx,
          blobUrl,
          effectiveSpeechRate: schedule.effectiveSpeechRate,
        });
        this.prevAudioEndClockMs = performance.now();
      } catch {
        // Stopped due to seek/pause or transient decode error
      }

      // If in LEARNING_HOLD_VIDEO mode and next sentence already passed by > 1.5s, hold video briefly at boundary
      if (
        this.settings.syncMode === 'LEARNING_HOLD_VIDEO' &&
        seg.nextSegmentStartMs !== null &&
        this.video.currentTime * 1000 - seg.nextSegmentStartMs > 1500
      ) {
        this.programmaticSetVideoRate(this.baseUserVideoRate * 0.85);
      }
    }

    this.programmaticSetVideoRate(this.baseUserVideoRate);
    this.activeChunk = null;
    this.emitSnapshot();
  }

  private async persistCurrentManifest(): Promise<void> {
    if (!this.videoKey) return;
    await saveVideoManifest({
      videoKey: this.videoKey,
      platform: this.platform,
      canonicalVideoId: this.canonicalVideoId,
      subtitleHash: this.subtitleHash,
      targetLang: 'vi',
      activeConfigVersion: this.activeConfigVersion,
      updatedAtMs: Date.now(),
      segments: toPersistedSegments(this.segments),
    });
  }

  private emitSnapshot(): void {
    const readyCount = this.segments.filter(
      (s) => s.status === 'READY' && s.configVersion === this.activeConfigVersion,
    ).length;
    const translatedCount = this.segments.filter((s) => Boolean(s.translatedText)).length;

    this.onSnapshotChange({
      playbackState: this.playbackState,
      bufferingMessage: this.bufferingMessage,
      activeChunk: this.activeChunk,
      statusBanner: this.statusBanner,
      ttsDegradedSubtitleOnly: this.ttsDegradedSubtitleOnly,
      readyCount,
      translatedCount,
      totalSegments: this.segments.length,
      segments: [...this.segments],
    });
  }
}
