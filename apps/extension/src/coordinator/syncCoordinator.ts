import {
  buildAudioCacheKey,
  buildPreemptiveQueue,
  buildVideoManifestKey,
  canAutoResumeFromBuffer,
  computeConfigVersion,
  countVietnameseSyllables,
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
  resolveSeekTargetWithSnap,
  resolveSegmentIndexAtVideoTime,
  selectActiveDisplayChunk,
  sha256Hex,
  splitIntoDisplayChunks,
  toSpokenVietnameseTtsText,
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
import {
  BUILTIN_CLOUD_ENGINE_ID,
  BuiltinCloudTtsClient,
} from '../tts/builtinCloudTtsClient';
import { LocalTtsClient } from '../tts/localTtsClient';
import {
  getBuiltinVoiceShortLabel,
  resolveBuiltinFallbackVoiceId,
} from '../tts/voiceTimbreProcessor';
import { SingleAudioQueue, type PausedAudioBookmark } from './singleAudioQueue';

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

interface StoredPauseBookmark extends PausedAudioBookmark {
  videoTimeAtPauseMs: number;
}

const PAUSE_GRACE_DURATION_MS = 10_000;
const TRANSLATE_LOOKAHEAD_MS = 60_000;
const TRANSLATE_LOOKAHEAD_COUNT = 10;
const TTS_LOOKAHEAD_MS = 40_000;
const TTS_LOOKAHEAD_COUNT = 6;

export class AdaptiveSyncCoordinator {
  private readonly sessionTag = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private disposed = false;
  private workerAbortController = new AbortController();

  private playbackState: PlaybackState = createInitialPlaybackState();
  private rawCues: SubtitleCue[] = [];
  private segments: SpeechSegment[] = [];
  private videoKey = '';
  private subtitleHash = '';
  private activeConfigVersion = '';
  private activeTranslationSig = '';
  private lastCacheInvalidatedAtMs = 0;
  private useBuiltinTts = true;
  private ttsDegradedSubtitleOnly = false;
  private bufferingMessage: string | null = null;
  private statusBanner = 'Sẵn sàng';
  private activeChunk: DisplayChunk | null = null;

  private readonly ttsClient: LocalTtsClient;
  private readonly builtinTtsClient: BuiltinCloudTtsClient;
  private readonly audioQueue: SingleAudioQueue;

  private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private prewarmTimer: ReturnType<typeof setInterval> | null = null;
  private prewarmActive = false;
  private pauseGraceDeadlineMs = 0;
  private lastTimeUpdateWakeMs = 0;
  private hasPlayedInSession = false;

  private translationLoopRunning = false;
  private ttsLoopRunning = false;
  private playbackLoopId = 0;
  private prevAudioEndClockMs = 0;
  private originalUserVideoVolume = 1.0;
  private baseUserVideoRate = 1.0;

  private pausedBookmark: StoredPauseBookmark | null = null;
  private pendingSeekSnapRequired = false;
  private wasPlayingBeforeScrub = false;

  private ignorePauseEventUntilMs = 0;
  private ignorePlayEventUntilMs = 0;
  private ignoreRateChangeUntilMs = 0;
  private ignoreSeekEventsUntilMs = 0;

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
    private readonly options: { prewarmOnPausedEntry?: boolean } = {},
  ) {
    this.ttsClient = new LocalTtsClient(
      settings.localTtsUrl,
      settings.localTtsToken,
      this.sessionTag,
    );
    this.builtinTtsClient = new BuiltinCloudTtsClient(this.sessionTag);
    this.useBuiltinTts = settings.engineId === BUILTIN_CLOUD_ENGINE_ID;
    this.lastCacheInvalidatedAtMs = settings.cacheInvalidatedAtMs || 0;
    this.audioQueue = new SingleAudioQueue((prog) => {
      if (!prog || this.disposed) return;
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

  private computeTranslationSignature(s: DubCeraSettings): string {
    if (s.translationProvider !== 'free-web' && s.llmApiKey.trim()) {
      return `${s.translationProvider}:${s.llmModel || 'default'}`;
    }
    return 'free-web-v3';
  }

  public async initializeWithCues(cues: SubtitleCue[]): Promise<void> {
    if (this.disposed) return;
    this.rawCues = cues;
    this.attachVideoListeners();
    const configSnap = toSynthesisConfigSnapshot(this.settings);
    this.activeConfigVersion = computeConfigVersion(configSnap);
    this.activeTranslationSig = this.computeTranslationSignature(this.settings);

    this.subtitleHash = sha256Hex(
      `grouper-v3|${this.activeTranslationSig}|${cues.map((c) => `${c.startMs}-${c.endMs}:${c.rawText}`).join('|')}`,
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

    // 1. Hydrate persisted translations & audio keys from IndexedDB (auto-evicts >1 day old or manually cleared entries)
    const persisted = await loadVideoManifest(
      this.videoKey,
      this.settings.cacheInvalidatedAtMs,
    );
    if (persisted && persisted.segments.length === freshSegments.length) {
      for (let i = 0; i < freshSegments.length; i++) {
        const saved = persisted.segments[i];
        const seg = freshSegments[i]!;
        if (saved && saved.sourceText === seg.sourceText && saved.translatedText) {
          seg.translatedText = saved.translatedText;
          seg.displayChunks = splitIntoDisplayChunks(
            seg.segmentId,
            saved.translatedText,
            seg.sourceText,
          );
          seg.audioCacheKey = buildAudioCacheKey(saved.translatedText, configSnap);
          seg.status = 'TRANSLATED';
        }
      }
    }

    if (this.disposed) return;
    this.segments = freshSegments;

    // 2. Verify existing WAV artifacts on local disk in one batch call
    await this.verifyDiskCacheAndHealth();
    if (this.disposed) return;

    if (!this.video.paused && this.settings.enabled) {
      this.hasPlayedInSession = true;
      this.clearPauseGraceTimer();
      this.playbackState = recordUserPlayIntent(this.playbackState);
      const alignedMs = this.alignPlayheadToSentenceStart();
      this.triggerBackgroundWorkers();
      void this.coordinateAtPlayhead(alignedMs);
    } else if (this.settings.enabled && this.options.prewarmOnPausedEntry && this.segments.length > 0) {
      // Pre-generate initial lookahead voice buffer while paused at 0s (e.g. FastTrack/Bunny)
      this.updatePreviewChunkAtVideoMs(this.video.currentTime * 1000);
      this.startPausedPrewarm();
    } else {
      // Video is paused on entry -> DO NOT start background translation/TTS until user presses Play!
      this.statusBanner = this.ttsDegradedSubtitleOnly
        ? 'Local TTS chưa bật — Bấm Play để dịch & xem phụ đề Việt'
        : `Sẵn sàng (${this.segments.length} câu) — Bấm Play để bắt đầu dịch & lồng tiếng`;
      if (this.settings.enabled) {
        this.updatePreviewChunkAtVideoMs(this.video.currentTime * 1000);
      } else {
        this.emitSnapshot();
      }
    }
  }

  public async updateSettings(nextSettings: DubCeraSettings): Promise<void> {
    if (this.disposed) return;
    const prevEnabled = this.settings.enabled;
    const prevConfigVer = this.activeConfigVersion;
    const prevTransSig = this.activeTranslationSig;
    const prevEngineId = this.settings.engineId;
    const prevVoiceId = this.settings.voiceId;
    const prevSampleRate = this.settings.sampleRate;
    const cacheWasInvalidated =
      (nextSettings.cacheInvalidatedAtMs || 0) !== this.lastCacheInvalidatedAtMs;
    this.lastCacheInvalidatedAtMs = nextSettings.cacheInvalidatedAtMs || 0;

    this.settings = nextSettings;
    this.ttsClient.updateCredentials(nextSettings.localTtsUrl, nextSettings.localTtsToken);

    const nextTransSig = this.computeTranslationSignature(nextSettings);
    const nextConfigIsBuiltin = nextSettings.engineId === BUILTIN_CLOUD_ENGINE_ID;
    const configSnap = nextConfigIsBuiltin
      ? toSynthesisConfigSnapshot({
          ...nextSettings,
          engineId: BUILTIN_CLOUD_ENGINE_ID,
          voiceId: resolveBuiltinFallbackVoiceId(nextSettings.engineId, nextSettings.voiceId),
          sampleRate: 24000,
        })
      : toSynthesisConfigSnapshot(nextSettings);
    const nextComputedVer = computeConfigVersion(configSnap);
    const voiceSelectionChanged =
      prevEngineId !== nextSettings.engineId ||
      prevVoiceId !== nextSettings.voiceId ||
      prevSampleRate !== nextSettings.sampleRate;

    if (!nextSettings.enabled) {
      // User turned DubCera OFF -> kill all background work & free memory immediately!
      this.pausedBookmark = null;
      this.stopPausedPrewarm();
      this.clearPauseGraceTimer();
      this.abortBackgroundWorkImmediately();
      this.audioQueue.stopImmediate();
      this.audioQueue.clearBlobCache();
      this.video.volume = this.originalUserVideoVolume;
      this.programmaticSetVideoRate(this.baseUserVideoRate);
      this.activeChunk = null;
      this.bufferingMessage = null;
      this.playbackState = exitDubBuffering(this.playbackState);
      this.statusBanner = 'Đã tắt lồng tiếng & ngắt chạy ngầm';
      this.emitSnapshot();
      return;
    }

    if ((prevTransSig !== nextTransSig || cacheWasInvalidated) && this.rawCues.length > 0) {
      this.pausedBookmark = null;
      this.playbackState = recordSeekInitiated(this.playbackState);
      this.abortBackgroundWorkImmediately();
      this.audioQueue.stopImmediate();
      this.audioQueue.clearBlobCache();
      this.detachVideoListeners();
      await this.initializeWithCues(this.rawCues);
      return;
    }

    if (voiceSelectionChanged || prevConfigVer !== nextComputedVer) {
      this.pausedBookmark = null;
      this.playbackState = recordSeekInitiated(this.playbackState);
      this.abortBackgroundWorkImmediately();
      this.audioQueue.stopImmediate();
      this.audioQueue.clearBlobCache();

      await this.verifyDiskCacheAndHealth();
      if (!this.video.paused) {
        this.hasPlayedInSession = true;
        this.clearPauseGraceTimer();
        const alignedMs = this.alignPlayheadToSentenceStart();
        this.triggerBackgroundWorkers();
        void this.coordinateAtPlayhead(alignedMs);
      } else {
        const builtinVariant = resolveBuiltinFallbackVoiceId(
          this.settings.engineId,
          this.settings.voiceId,
        );
        const builtinLabel = getBuiltinVoiceShortLabel(builtinVariant);
        this.statusBanner = this.useBuiltinTts
          ? this.settings.engineId !== BUILTIN_CLOUD_ENGINE_ID
            ? `Server VieNeu đang tắt — Sẽ phát bằng giọng ${builtinLabel}`
            : `Đã chọn giọng: ${builtinLabel} — Bấm Play để nghe`
          : `Đã chọn giọng: ${this.settings.voiceId} — Bấm Play để nghe`;
      }
    } else if (!prevEnabled && !this.video.paused) {
      this.hasPlayedInSession = true;
      this.clearPauseGraceTimer();
      const alignedMs = this.alignPlayheadToSentenceStart();
      this.triggerBackgroundWorkers();
      void this.coordinateAtPlayhead(alignedMs);
    } else if (!this.video.paused && !this.ttsDegradedSubtitleOnly) {
      this.video.volume = Math.max(0, Math.min(1, nextSettings.originalVideoVolumeRatio));
    }

    this.emitSnapshot();
  }

  public requestExplicitUserPause(): void {
    if (this.disposed) return;
    this.playbackLoopId += 1;
    this.playbackState = recordUserPauseIntent(this.playbackState);
    this.bufferingMessage = null;
    this.pausedBookmark = null;
    this.audioQueue.stopImmediate(false);
    if (!this.video.paused) {
      this.programmaticPauseVideo();
    }
    this.programmaticSetVideoRate(this.baseUserVideoRate);
    this.armPauseGraceWindow();
    this.statusBanner = 'Đã tạm dừng (đệm thêm 10s rồi tự ngắt)';
    this.emitSnapshot();
  }

  public async resumeAfterAutoplayBlock(): Promise<void> {
    if (this.disposed) return;
    this.hasPlayedInSession = true;
    this.clearPauseGraceTimer();
    this.playbackState = recordUserPlayIntent(this.playbackState);
    this.emitSnapshot();
    const alignedMs = this.alignPlayheadToSentenceStart();
    this.triggerBackgroundWorkers();
    await this.coordinateAtPlayhead(alignedMs);
  }

  /**
   * Terminates session immediately when user closes tab, switches lecture/video, or leaves page.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playbackLoopId += 1;
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
    this.clearPauseGraceTimer();
    this.stopPausedPrewarm();
    this.abortBackgroundWorkImmediately();
    this.detachVideoListeners();
    this.audioQueue.dispose();
    if (!this.useBuiltinTts) {
      this.ttsClient.releaseServerMemory();
    }
    this.segments = [];
    this.video.volume = this.originalUserVideoVolume;
  }

  private clearPauseGraceTimer(): void {
    this.pauseGraceDeadlineMs = 0;
    if (this.pauseGraceTimer) {
      clearTimeout(this.pauseGraceTimer);
      this.pauseGraceTimer = null;
    }
  }

  /**
   * Allows background translation/TTS to continue for at most 10 seconds after Pause,
   * then hard-stops all workers and aborts in-flight requests to save CPU & bandwidth.
   */
  private armPauseGraceWindow(): void {
    if (!this.hasPlayedInSession || !this.settings.enabled || this.disposed) {
      this.clearPauseGraceTimer();
      return;
    }

    this.clearPauseGraceTimer();
    this.pauseGraceDeadlineMs = performance.now() + PAUSE_GRACE_DURATION_MS;

    this.pauseGraceTimer = setTimeout(() => {
      this.pauseGraceTimer = null;
      this.pauseGraceDeadlineMs = 0;
      if (this.disposed) return;

      // Only cut off if still paused (and not actively buffering for an explicit Play intent)
      if (this.video.paused && !this.playbackState.isBuffering) {
        this.abortBackgroundWorkImmediately();
        this.audioQueue.clearBlobCache();
        this.statusBanner = 'Đã tạm dừng >10s — Đã ngắt chạy ngầm & giải phóng RAM đệm';
        this.emitSnapshot();
      }
    }, PAUSE_GRACE_DURATION_MS + 50);
  }

  private abortBackgroundWorkImmediately(): void {
    this.workerAbortController.abort();
    this.workerAbortController = new AbortController();
    this.ttsClient.abortActiveSessionRequests();
    this.builtinTtsClient.abortActiveSessionRequests();

    // Cleanly roll back any mid-flight transient statuses so pressing Play later retries cleanly
    for (const seg of this.segments) {
      if (seg.status === 'TRANSLATING') {
        seg.status = 'UNPROCESSED';
      } else if (seg.status === 'SYNTHESIZING') {
        seg.status = seg.translatedText ? 'TRANSLATED' : 'UNPROCESSED';
      }
    }
  }

  private stopPausedPrewarm(): void {
    this.prewarmActive = false;
    if (this.prewarmTimer) {
      clearInterval(this.prewarmTimer);
      this.prewarmTimer = null;
    }
  }

  private startPausedPrewarm(): void {
    this.stopPausedPrewarm();
    if (this.disposed || !this.settings.enabled || !this.video.paused || this.segments.length === 0) {
      return;
    }

    const startIdx = Math.max(
      0,
      resolveSegmentIndexAtVideoTime(this.segments, this.video.currentTime * 1000),
    );
    const targetEndIdx = Math.min(this.segments.length, startIdx + TTS_LOOKAHEAD_COUNT);
    const targetCount = Math.max(1, targetEndIdx - startIdx);

    const countReadyInWindow = (): number => {
      let count = 0;
      for (let i = startIdx; i < targetEndIdx; i++) {
        const seg = this.segments[i];
        if (seg && (this.isSegmentPlayable(seg) || seg.status === 'ERROR')) {
          count += 1;
        }
      }
      return count;
    };

    const initialReady = countReadyInWindow();
    if (initialReady >= targetCount) {
      this.statusBanner = `Sẵn sàng phát ngay (${initialReady}/${this.segments.length} câu từ cache) — Bấm Play`;
      this.emitSnapshot();
      return;
    }

    this.prewarmActive = true;
    this.statusBanner = `Đang chuẩn bị voice trước khi phát (${initialReady}/${targetCount})...`;
    this.emitSnapshot();
    this.triggerBackgroundWorkers();

    const startedAt = performance.now();
    this.prewarmTimer = setInterval(() => {
      if (this.disposed || !this.settings.enabled || !this.video.paused || !this.prewarmActive) {
        this.stopPausedPrewarm();
        return;
      }

      const readyNow = countReadyInWindow();
      const timedOut = performance.now() - startedAt > 25_000;
      if (readyNow >= targetCount || timedOut) {
        this.stopPausedPrewarm();
        this.statusBanner =
          readyNow > 0
            ? `Sẵn sàng phát ngay (${readyNow}/${this.segments.length} câu đã chuẩn bị voice) — Bấm Play`
            : `Sẵn sàng (${this.segments.length} câu) — Bấm Play để bắt đầu`;
        this.emitSnapshot();
        return;
      }

      this.statusBanner = `Đang chuẩn bị voice trước khi phát (${readyNow}/${targetCount})...`;
      this.triggerBackgroundWorkers();
      this.emitSnapshot();
    }, 450);
  }

  /**
   * Strict Gatekeeper: Returns true ONLY while actively playing, buffering for a Play request,
   * inside the bounded paused pre-warm window, or inside the 10-second post-Pause grace window!
   */
  private isBackgroundWorkAllowed(): boolean {
    if (this.disposed || !this.settings.enabled) return false;
    if (this.playbackState.isBuffering && this.playbackState.intent === 'PLAY') return true;
    if (!this.video.paused) return true;
    if (this.prewarmActive && this.video.paused) return true;
    if (this.pauseGraceDeadlineMs > 0 && performance.now() < this.pauseGraceDeadlineMs) {
      return true;
    }
    return false;
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
      this.ignorePauseEventUntilMs = performance.now() + 280;
      this.video.pause();
    }
  }

  private async programmaticPlayVideo(): Promise<boolean> {
    if (!this.video.paused) return true;
    this.ignorePlayEventUntilMs = performance.now() + 280;
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

  private programmaticSeekVideo(targetVideoMs: number): void {
    this.ignoreSeekEventsUntilMs = performance.now() + 420;
    this.video.currentTime = Math.max(0, targetVideoMs / 1000);
  }

  private programmaticSetVideoRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(2.0, Number(rate.toFixed(2))));
    if (Math.abs(this.video.playbackRate - clamped) < 0.01) return;
    this.ignoreRateChangeUntilMs = performance.now() + 200;
    this.video.playbackRate = clamped;
  }

  private alignPlayheadToSentenceStart(): number {
    const rawMs = this.video.currentTime * 1000;
    this.pendingSeekSnapRequired = false;
    const { segmentIndex, snapVideoTimeMs } = resolveSeekTargetWithSnap(this.segments, rawMs, 250);

    let effectiveMs = rawMs;
    if (snapVideoTimeMs !== null && Math.abs(rawMs - snapVideoTimeMs) > 200) {
      this.programmaticSeekVideo(snapVideoTimeMs);
      effectiveMs = snapVideoTimeMs;
    }

    if (segmentIndex >= 0) {
      this.playbackState = { ...this.playbackState, activeSegmentIndex: segmentIndex };
      this.updatePreviewChunkForSegment(segmentIndex);
    }

    return effectiveMs;
  }

  private updatePreviewChunkForSegment(segmentIndex: number): void {
    const seg = this.segments[segmentIndex];
    if (!seg) {
      this.activeChunk = null;
      return;
    }
    this.activeChunk = seg.displayChunks?.[0] ?? {
      chunkId: `${seg.segmentId}-preview`,
      text: seg.translatedText ?? seg.sourceText,
      sourceExcerpt: seg.translatedText ? seg.sourceText : undefined,
      weightRatio: 1,
    };
  }

  private updatePreviewChunkAtVideoMs(videoMs: number): void {
    const idx = resolveSegmentIndexAtVideoTime(this.segments, videoMs);
    if (idx >= 0) {
      this.playbackState = { ...this.playbackState, activeSegmentIndex: idx };
      this.updatePreviewChunkForSegment(idx);
    } else {
      this.activeChunk = null;
    }
    this.emitSnapshot();
  }

  private handleNativePlayEvent(): void {
    if (this.disposed || performance.now() < this.ignorePlayEventUntilMs) return;
    this.hasPlayedInSession = true;
    this.stopPausedPrewarm();
    this.clearPauseGraceTimer();
    this.playbackState = recordUserPlayIntent(this.playbackState);
    if (!this.settings.enabled) return;

    // Case 1: User simply paused mid-sentence and pressed Play WITHOUT seeking -> resume exact syllable!
    if (
      !this.pendingSeekSnapRequired &&
      this.pausedBookmark &&
      Math.abs(this.video.currentTime * 1000 - this.pausedBookmark.videoTimeAtPauseMs) <= 650
    ) {
      const resumeBookmark = this.pausedBookmark;
      this.pausedBookmark = null;
      this.triggerBackgroundWorkers();
      void this.coordinateAtPlayhead(this.video.currentTime * 1000, resumeBookmark);
      return;
    }

    // Case 2: User pressed Play right after a timeline seek (or initial start) -> snap to cue start!
    this.pausedBookmark = null;
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    void (async () => {
      if (this.settings.engineId !== BUILTIN_CLOUD_ENGINE_ID && this.useBuiltinTts) {
        await this.verifyDiskCacheAndHealth();
      }
      if (this.disposed || this.playbackState.intent !== 'PLAY') return;
      const alignedMs = this.alignPlayheadToSentenceStart();
      this.triggerBackgroundWorkers();
      await this.coordinateAtPlayhead(alignedMs);
    })();
  }

  private handleNativePauseEvent(): void {
    if (this.disposed || performance.now() < this.ignorePauseEventUntilMs) return;
    if (this.video.ended) {
      this.clearPauseGraceTimer();
      this.abortBackgroundWorkImmediately();
      return;
    }

    this.playbackLoopId += 1;
    this.playbackState = recordUserPauseIntent(this.playbackState);
    this.bufferingMessage = null;
    this.programmaticSetVideoRate(this.baseUserVideoRate);

    const captured = this.audioQueue.capturePauseAndStop();
    if (captured) {
      this.pausedBookmark = {
        ...captured,
        videoTimeAtPauseMs: this.video.currentTime * 1000,
      };
      this.statusBanner = `Tạm dừng tại câu ${captured.segmentIndex + 1}/${this.segments.length} (chạy đệm tối đa 10s)`;
    } else {
      this.pausedBookmark = null;
      this.statusBanner = 'Đã tạm dừng (chạy đệm tối đa 10s)';
    }

    // Keep workers alive for at most 10 seconds after Pause, then hard-stop!
    this.armPauseGraceWindow();
    this.emitSnapshot();
  }

  private handleNativeSeekingEvent(): void {
    if (this.disposed || performance.now() < this.ignoreSeekEventsUntilMs) return;
    if (!this.settings.enabled) return;

    if (!this.pendingSeekSnapRequired) {
      this.wasPlayingBeforeScrub = this.playbackState.intent === 'PLAY' || !this.video.paused;
    }

    this.pendingSeekSnapRequired = true;
    this.pausedBookmark = null;
    this.playbackLoopId += 1;
    this.playbackState = recordSeekInitiated(this.playbackState);
    this.prevAudioEndClockMs = 0;
    this.bufferingMessage = null;
    this.audioQueue.stopImmediate();
    this.programmaticSetVideoRate(this.baseUserVideoRate);

    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }

    const scrubMs = this.video.currentTime * 1000;
    const previewIdx = resolveSegmentIndexAtVideoTime(this.segments, scrubMs);
    if (previewIdx >= 0) {
      this.updatePreviewChunkForSegment(previewIdx);
      this.statusBanner = `Đang tua tới câu ${previewIdx + 1}/${this.segments.length}`;
    } else {
      this.activeChunk = null;
    }
    this.emitSnapshot();
  }

  private handleNativeSeekedEvent(): void {
    if (this.disposed || performance.now() < this.ignoreSeekEventsUntilMs) return;
    if (!this.settings.enabled) return;

    const capturedSession = this.playbackState.sessionId;
    if (this.seekDebounceTimer) clearTimeout(this.seekDebounceTimer);

    this.seekDebounceTimer = setTimeout(() => {
      this.seekDebounceTimer = null;
      if (this.disposed || capturedSession !== this.playbackState.sessionId) return;

      const alignedMs = this.alignPlayheadToSentenceStart();
      const idx = resolveSegmentIndexAtVideoTime(this.segments, alignedMs);

      if (!this.video.paused || (this.wasPlayingBeforeScrub && this.playbackState.intent === 'PLAY')) {
        this.wasPlayingBeforeScrub = false;
        this.hasPlayedInSession = true;
        this.clearPauseGraceTimer();
        this.playbackState = recordUserPlayIntent(this.playbackState);
        this.triggerBackgroundWorkers();
        void this.coordinateAtPlayhead(alignedMs);
      } else {
        this.wasPlayingBeforeScrub = false;
        // User scrubbed while Paused: only pre-prepare within 10s grace window if session was already active!
        if (this.hasPlayedInSession) {
          this.armPauseGraceWindow();
          this.triggerBackgroundWorkers();
        }
        if (idx >= 0) {
          this.statusBanner = `Đã căn về đầu câu ${idx + 1}/${this.segments.length} — Bấm Play để đọc trọn câu`;
        }
        this.emitSnapshot();
      }
    }, 160);
  }

  private handleNativeRateChangeEvent(): void {
    if (this.disposed || performance.now() < this.ignoreRateChangeUntilMs) return;
    this.baseUserVideoRate = this.video.playbackRate || 1.0;
  }

  private handleNativeTimeUpdate(): void {
    if (this.disposed || !this.settings.enabled) return;

    // Slide the 40s-60s lookahead window forward smoothly while the video is playing
    const now = performance.now();
    if (!this.video.paused && now - this.lastTimeUpdateWakeMs >= 2000) {
      this.lastTimeUpdateWakeMs = now;
      this.triggerBackgroundWorkers();
    }

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

  private getEffectiveSynthesisSnapshot() {
    if (this.useBuiltinTts) {
      const effectiveVoice = resolveBuiltinFallbackVoiceId(
        this.settings.engineId,
        this.settings.voiceId,
      );
      return toSynthesisConfigSnapshot({
        ...this.settings,
        engineId: BUILTIN_CLOUD_ENGINE_ID,
        voiceId: effectiveVoice,
        sampleRate: 24000,
      });
    }
    return toSynthesisConfigSnapshot(this.settings);
  }

  private refreshSegmentAudioKeysForCurrentMode(): void {
    const snap = this.getEffectiveSynthesisSnapshot();
    this.activeConfigVersion = computeConfigVersion(snap);
    for (const seg of this.segments) {
      seg.configVersion = this.activeConfigVersion;
      if (seg.translatedText) {
        seg.audioCacheKey = buildAudioCacheKey(seg.translatedText, snap);
        if (seg.status === 'READY') {
          seg.status = 'TRANSLATED';
          seg.audioDurationMs = undefined;
        }
      }
    }
  }

  private async verifyDiskCacheAndHealth(): Promise<void> {
    if (this.settings.engineId === BUILTIN_CLOUD_ENGINE_ID) {
      this.useBuiltinTts = true;
      this.ttsDegradedSubtitleOnly = false;
      this.refreshSegmentAudioKeysForCurrentMode();
    } else {
      try {
        await this.ttsClient.checkHealth(1500, true);
        this.useBuiltinTts = false;
        this.ttsDegradedSubtitleOnly = false;
        this.refreshSegmentAudioKeysForCurrentMode();
      } catch {
        // Local Python server is closed -> seamlessly fall back to Built-in Extension TTS (0 MB Python RAM!)
        this.useBuiltinTts = true;
        this.ttsDegradedSubtitleOnly = false;
        this.refreshSegmentAudioKeysForCurrentMode();
      }
    }

    const keysToCheck = this.segments
      .map((s) => s.audioCacheKey)
      .filter((k): k is string => Boolean(k));

    if (keysToCheck.length === 0) return;

    try {
      if (this.useBuiltinTts) {
        const validMap = await this.builtinTtsClient.verifyCachedKeys(
          keysToCheck,
          this.settings.cacheInvalidatedAtMs,
        );
        for (const seg of this.segments) {
          if (seg.audioCacheKey) {
            const hit = validMap[seg.audioCacheKey.toLowerCase()];
            if (hit) {
              seg.audioDurationMs = hit.audioDurationMs;
              seg.status = 'READY';
            }
          }
        }
      } else {
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
      }
    } catch {
      // Keep status as TRANSLATED so worker synthesizes on demand
    }
  }

  private getTranslationProvider(): TranslationProvider {
    if (this.settings.translationProvider !== 'free-web' && this.settings.llmApiKey.trim()) {
      return new LlmApiTranslationProvider({
        provider: this.settings.translationProvider,
        endpointUrl: this.settings.llmEndpointUrl,
        apiKey: this.settings.llmApiKey,
        model: this.settings.llmModel,
        sessionTag: this.sessionTag,
      });
    }
    return new FreeWebTranslationProvider(this.sessionTag);
  }

  private isSegmentPlayable(seg: SpeechSegment): boolean {
    if (this.ttsDegradedSubtitleOnly) {
      return Boolean(seg.translatedText);
    }
    return seg.status === 'READY' && seg.configVersion === this.activeConfigVersion;
  }

  private triggerBackgroundWorkers(): void {
    if (!this.isBackgroundWorkAllowed()) return;
    void this.pumpTranslationQueue();
    void this.pumpTtsQueue();
  }

  /**
   * Producer Loop: Translates ONLY within a tight 60s / 10-segment rolling window ahead of playhead,
   * and stops immediately if video is paused > 10s, disabled, or closed!
   */
  private async pumpTranslationQueue(): Promise<void> {
    if (this.translationLoopRunning || !this.isBackgroundWorkAllowed()) return;
    this.translationLoopRunning = true;

    try {
      while (this.isBackgroundWorkAllowed()) {
        const signal = this.workerAbortController.signal;
        const playheadMs = this.video.currentTime * 1000;
        const isActivelyPlaying = !this.video.paused;
        const queue = buildPreemptiveQueue(this.segments, playheadMs, this.activeConfigVersion, {
          urgentWindowVideoMs: 25_000,
          urgentMinCount: 3,
          maxLookaheadVideoMs: isActivelyPlaying
            ? Number.MAX_SAFE_INTEGER
            : TRANSLATE_LOOKAHEAD_MS,
          maxLookaheadCount: isActivelyPlaying
            ? this.segments.length
            : TRANSLATE_LOOKAHEAD_COUNT,
          includeBackfill: false,
        });

        const untranslatedTask = queue.find(
          (t) =>
            !this.segments[t.segmentIndex]?.translatedText &&
            this.segments[t.segmentIndex]?.status !== 'TRANSLATING',
        );
        if (!untranslatedTask) break;

        const startIdx = untranslatedTask.segmentIndex;
        const batchSize = untranslatedTask.tier === 'P0_URGENT' ? 4 : 6;
        const batchIndices: number[] = [];

        for (let i = startIdx; i < Math.min(this.segments.length, startIdx + batchSize); i++) {
          const s = this.segments[i]!;
          if (!s.translatedText && s.status !== 'TRANSLATING') {
            batchIndices.push(i);
          }
        }
        if (batchIndices.length === 0) break;

        const firstIdx = batchIndices[0]!;
        const contextBefore: string[] = [];
        if (firstIdx >= 3) contextBefore.push(this.segments[firstIdx - 3]!.sourceText);
        if (firstIdx >= 2) contextBefore.push(this.segments[firstIdx - 2]!.sourceText);
        if (firstIdx >= 1) contextBefore.push(this.segments[firstIdx - 1]!.sourceText);

        for (const idx of batchIndices) {
          this.segments[idx]!.status = 'TRANSLATING';
        }
        this.emitSnapshot();

        try {
          const provider = this.getTranslationProvider();
          const pageTitle = typeof document !== 'undefined' ? document.title.replace(/\s*-\s*YouTube$/i, '').trim() : '';
          const translatedItems = await provider.translateBatch(
            {
              sourceLang: 'auto',
              targetLang: 'vi',
              videoTitle: pageTitle || undefined,
              contextBefore,
              items: batchIndices.map((idx) => {
                const segItem = this.segments[idx]!;
                return {
                  segmentId: segItem.segmentId,
                  sourceText: segItem.sourceText,
                  durationMs: Math.max(800, segItem.endMs - segItem.startMs),
                };
              }),
            },
            signal,
          );

          if (this.disposed || signal.aborted) {
            for (const idx of batchIndices) {
              const seg = this.segments[idx];
              if (seg && !seg.translatedText) {
                seg.status = 'UNPROCESSED';
              }
            }
            break;
          }

          const configSnap = this.getEffectiveSynthesisSnapshot();
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

              if (this.video.paused && this.playbackState.activeSegmentIndex === seg.segmentIndex) {
                this.updatePreviewChunkForSegment(seg.segmentIndex);
              }
            }
          }

          await this.persistCurrentManifest();
          this.emitSnapshot();
          void this.pumpTtsQueue();
        } catch (err) {
          if (this.disposed || signal.aborted || !this.isBackgroundWorkAllowed()) {
            for (const idx of batchIndices) {
              const seg = this.segments[idx];
              if (seg && !seg.translatedText) {
                seg.status = 'UNPROCESSED';
              }
            }
            break;
          }
          for (const idx of batchIndices) {
            const seg = this.segments[idx];
            if (seg) {
              seg.status = 'ERROR';
              seg.errorMessage = err instanceof Error ? err.message : 'Lỗi dịch';
            }
          }
          this.emitSnapshot();
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    } finally {
      this.translationLoopRunning = false;
    }
  }

  /**
   * Consumer Loop: Synthesizes ONLY within a tight 40s / 6-segment rolling window ahead of playhead,
   * and stops immediately if video is paused > 10s, disabled, or closed!
   */
  private async pumpTtsQueue(): Promise<void> {
    if (this.ttsLoopRunning || this.ttsDegradedSubtitleOnly || !this.isBackgroundWorkAllowed()) {
      return;
    }
    this.ttsLoopRunning = true;

    try {
      while (!this.ttsDegradedSubtitleOnly && this.isBackgroundWorkAllowed()) {
        const signal = this.workerAbortController.signal;
        const playheadMs = this.video.currentTime * 1000;
        const isActivelyPlaying = !this.video.paused;
        const queue = buildPreemptiveQueue(this.segments, playheadMs, this.activeConfigVersion, {
          urgentWindowVideoMs: 25_000,
          urgentMinCount: 2,
          maxLookaheadVideoMs: isActivelyPlaying ? Number.MAX_SAFE_INTEGER : TTS_LOOKAHEAD_MS,
          maxLookaheadCount: isActivelyPlaying ? this.segments.length : TTS_LOOKAHEAD_COUNT,
          includeBackfill: false,
        });

        const nextTtsTask = queue.find((t) => {
          const s = this.segments[t.segmentIndex];
          return Boolean(
            s &&
              s.translatedText &&
              s.audioCacheKey &&
              s.status !== 'READY' &&
              s.status !== 'SYNTHESIZING' &&
              s.status !== 'ERROR',
          );
        });

        if (!nextTtsTask) break;

        const targetSeg = this.segments[nextTtsTask.segmentIndex]!;
        const capturedCfgVersion = this.activeConfigVersion;
        targetSeg.status = 'SYNTHESIZING';
        this.emitSnapshot();

        try {
          if (this.useBuiltinTts) {
            const voiceVariant = resolveBuiltinFallbackVoiceId(
              this.settings.engineId,
              this.settings.voiceId,
            );
            const builtinRes = await this.builtinTtsClient.synthesizeAndCache({
              audioCacheKey: targetSeg.audioCacheKey!,
              text: targetSeg.translatedText!,
              voiceVariant,
              minValidTimestampMs: this.settings.cacheInvalidatedAtMs,
              signal,
            });

            if (this.disposed || signal.aborted) {
              URL.revokeObjectURL(builtinRes.blobUrl);
              if (targetSeg.status === 'SYNTHESIZING') {
                targetSeg.status = 'TRANSLATED';
              }
              break;
            }

            if (capturedCfgVersion === this.activeConfigVersion) {
              targetSeg.audioDurationMs = builtinRes.audioDurationMs;
              targetSeg.status = 'READY';

              if (
                nextTtsTask.tier === 'P0_URGENT' &&
                this.isBackgroundWorkAllowed() &&
                !this.audioQueue.hasPreloaded(targetSeg.audioCacheKey!)
              ) {
                this.audioQueue.storePreloadedBlobUrl(targetSeg.audioCacheKey!, builtinRes.blobUrl);
              } else {
                URL.revokeObjectURL(builtinRes.blobUrl);
              }

              await this.persistCurrentManifest();
              this.emitSnapshot();
            } else {
              URL.revokeObjectURL(builtinRes.blobUrl);
            }
          } else {
            const synthRes = await this.ttsClient.synthesize({
              audioCacheKey: targetSeg.audioCacheKey!,
              text: toSpokenVietnameseTtsText(targetSeg.translatedText!) || targetSeg.translatedText!,
              voiceId: this.settings.voiceId,
              engineId: this.settings.engineId,
              sampleRate: this.settings.sampleRate,
              signal,
            });

            if (this.disposed || signal.aborted) {
              if (targetSeg.status === 'SYNTHESIZING') {
                targetSeg.status = 'TRANSLATED';
              }
              break;
            }

            if (capturedCfgVersion === this.activeConfigVersion) {
              targetSeg.audioDurationMs = synthRes.audioDurationMs;
              targetSeg.status = 'READY';

              if (
                nextTtsTask.tier === 'P0_URGENT' &&
                this.isBackgroundWorkAllowed() &&
                !this.audioQueue.hasPreloaded(targetSeg.audioCacheKey!)
              ) {
                const blobUrl = await this.ttsClient.fetchAudioBlobUrl(targetSeg.audioCacheKey!, signal);
                this.audioQueue.storePreloadedBlobUrl(targetSeg.audioCacheKey!, blobUrl);
              }

              await this.persistCurrentManifest();
              this.emitSnapshot();
            }
          }
        } catch {
          if (this.disposed || signal.aborted || !this.isBackgroundWorkAllowed()) {
            if (targetSeg.status === 'SYNTHESIZING') {
              targetSeg.status = 'TRANSLATED';
            }
            break;
          }
          if (!this.useBuiltinTts) {
            try {
              await this.ttsClient.checkHealth(1500);
              targetSeg.status = 'ERROR';
              targetSeg.errorMessage = 'Lỗi tạo âm thanh câu này';
            } catch {
              // Local Python stopped mid-session -> seamlessly switch to Built-in Extension TTS!
              this.useBuiltinTts = true;
              this.refreshSegmentAudioKeysForCurrentMode();
              this.statusBanner = 'Đã tự động chuyển sang Giọng đọc tích hợp sẵn trên Extension';
            }
          } else {
            targetSeg.status = 'ERROR';
            targetSeg.errorMessage = 'Lỗi kết nối giọng đọc trực tuyến';
          }
          this.emitSnapshot();
        }
      }
    } finally {
      this.ttsLoopRunning = false;
    }
  }

  private async coordinateAtPlayhead(
    targetVideoMs: number,
    resumeBookmark?: StoredPauseBookmark,
  ): Promise<void> {
    if (this.disposed || !this.settings.enabled || this.segments.length === 0) return;

    const myLoopId = ++this.playbackLoopId;
    const activeSession = this.playbackState.sessionId;

    const startIdx = resumeBookmark
      ? resumeBookmark.segmentIndex
      : resolveSegmentIndexAtVideoTime(this.segments, targetVideoMs);
    if (startIdx === -1) return;

    const firstSeg = this.segments[startIdx]!;
    if (!resumeBookmark && firstSeg.startMs - targetVideoMs > 5000 && !this.isSegmentPlayable(firstSeg)) {
      const waitVideoMs = firstSeg.startMs - targetVideoMs - 1500;
      const waitWallMs = Math.max(200, waitVideoMs / Math.max(0.5, this.video.playbackRate));
      this.triggerBackgroundWorkers();
      await new Promise((r) => setTimeout(r, waitWallMs));
      if (this.disposed || myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) {
        return;
      }
    }

    // Fast startup gate: release as soon as first sentence (>= 3.2s) or 2 short sentences are ready!
    const requiredIndices = getRequiredBufferIndices(this.segments, startIdx, 1, 3200, 2);
    const allReadyImmediately = requiredIndices.every((idx) =>
      this.isSegmentPlayable(this.segments[idx]!),
    );

    if (!allReadyImmediately) {
      const { nextState, snapshot } = enterDubBuffering(this.playbackState);
      this.playbackState = nextState;
      this.programmaticPauseVideo();
      this.triggerBackgroundWorkers();

      const waitStartedMs = performance.now();
      while (true) {
        if (this.disposed || myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) {
          return;
        }
        if (this.playbackState.intent !== 'PLAY') return;

        const readyInWindow = requiredIndices.filter((idx) =>
          this.isSegmentPlayable(this.segments[idx]!),
        ).length;
        const errored = requiredIndices.some((idx) => this.segments[idx]!.status === 'ERROR');
        if (errored || readyInWindow >= requiredIndices.length) break;

        this.bufferingMessage = `Đang dịch & chuẩn bị giọng đọc... (${readyInWindow}/${requiredIndices.length})`;
        this.statusBanner = this.bufferingMessage;
        this.emitSnapshot();

        this.triggerBackgroundWorkers();

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

    this.video.volume = Math.max(0, Math.min(1, this.settings.originalVideoVolumeRatio));
    const activeBuiltinVariant = resolveBuiltinFallbackVoiceId(
      this.settings.engineId,
      this.settings.voiceId,
    );
    const activeBuiltinLabel = getBuiltinVoiceShortLabel(activeBuiltinVariant);
    this.statusBanner = this.useBuiltinTts
      ? this.settings.engineId !== BUILTIN_CLOUD_ENGINE_ID
        ? `Server VieNeu đang tắt — Đang đọc tạm giọng ${activeBuiltinLabel}`
        : `Đang phát giọng: ${activeBuiltinLabel} (Không cần Server)`
      : `Đang phát giọng: ${this.settings.voiceId}`;
    this.emitSnapshot();

    for (let idx = startIdx; idx < this.segments.length; idx++) {
      if (this.disposed || myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) {
        return;
      }
      if (this.playbackState.intent !== 'PLAY') return;

      const seg = this.segments[idx]!;
      const prevSeg = idx > startIdx ? this.segments[idx - 1] : undefined;
      const isResumingBookmarkedSeg =
        resumeBookmark !== undefined &&
        idx === resumeBookmark.segmentIndex &&
        seg.audioCacheKey === resumeBookmark.audioCacheKey;
      const isContinuousFromPrev = Boolean(
        !isResumingBookmarkedSeg && prevSeg?.continuesImmediately && this.prevAudioEndClockMs > 0,
      );

      this.triggerBackgroundWorkers();

      if (!isResumingBookmarkedSeg) {
        const earlyLeadInVideoMs = isContinuousFromPrev ? 420 : 80;
        while (true) {
          if (this.disposed || myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) {
            return;
          }
          if (this.playbackState.intent !== 'PLAY') return;
          const nowVideoMs = this.video.currentTime * 1000;
          const deltaVideoMs = seg.startMs - nowVideoMs;
          if (deltaVideoMs <= earlyLeadInVideoMs) break;
          await new Promise((r) =>
            setTimeout(
              r,
              Math.min(100, (deltaVideoMs - earlyLeadInVideoMs + 25) / Math.max(0.5, this.video.playbackRate)),
            ),
          );
        }
      }

      if (!this.isSegmentPlayable(seg) && seg.status !== 'ERROR') {
        await this.coordinateAtPlayhead(seg.startMs);
        return;
      }

      if (seg.status === 'ERROR' || !seg.audioCacheKey || !seg.audioDurationMs) {
        this.activeChunk = seg.displayChunks?.[0] ?? {
          chunkId: `${seg.segmentId}-fallback`,
          text: seg.translatedText ?? seg.sourceText,
          weightRatio: 1,
        };
        this.statusBanner = 'Một câu thiếu âm thanh — Đang hiển thị phụ đề';
        this.emitSnapshot();
        continue;
      }

      let effectiveSpeechRate: number;
      let startOffsetSec = 0;

      if (isResumingBookmarkedSeg && resumeBookmark) {
        effectiveSpeechRate = resumeBookmark.effectiveSpeechRate;
        startOffsetSec = resumeBookmark.resumeOffsetSec;
      } else {
        const drift = predictLookaheadDrift({
          nowClockMs: performance.now(),
          currentVideoTimeMs: this.video.currentTime * 1000,
          userVideoRate: this.baseUserVideoRate,
          prevAudioEndClockMs: this.prevAudioEndClockMs,
          upcomingSegments: this.segments.slice(idx, idx + 5),
          syncMode: this.settings.syncMode,
          minEffectiveSpeechRate: this.settings.minEffectiveSpeechRate,
          maxEffectiveSpeechRate: this.settings.maxEffectiveSpeechRate,
        });

        if (this.settings.syncMode === 'LEARNING_HOLD_VIDEO') {
          this.programmaticSetVideoRate(this.baseUserVideoRate * drift.recommendedVideoRateMultiplier);
        } else {
          this.programmaticSetVideoRate(this.baseUserVideoRate);
        }

        const currentEffectiveVideoRate = Math.max(0.5, this.video.playbackRate || 1.0);
        const schedule = planSegmentDualClock({
          nowClockMs: performance.now(),
          currentVideoTimeMs: this.video.currentTime * 1000,
          videoRate: currentEffectiveVideoRate,
          prevAudioEndClockMs: this.prevAudioEndClockMs,
          segmentStartVideoMs: seg.startMs,
          segmentEndVideoMs: seg.endMs,
          nextSegmentStartVideoMs: seg.nextSegmentStartMs,
          audioDurationMs: seg.audioDurationMs,
          minEffectiveSpeechRate: this.settings.minEffectiveSpeechRate,
          maxEffectiveSpeechRate: this.settings.maxEffectiveSpeechRate,
          flowProfile: seg.flowProfile,
          syllableCount: countVietnameseSyllables(seg.translatedText),
          allowEarlyLeadInClockMs: isContinuousFromPrev ? 420 / currentEffectiveVideoRate : 0,
          minBreathGapClockMs: isContinuousFromPrev ? 160 : 60,
        });

        const waitBeforeStartMs = Math.max(0, schedule.actualStartClockMs - performance.now());
        if (waitBeforeStartMs > 15) {
          await new Promise((r) => setTimeout(r, waitBeforeStartMs));
        }
        if (this.disposed || myLoopId !== this.playbackLoopId || activeSession !== this.playbackState.sessionId) {
          return;
        }
        effectiveSpeechRate = schedule.effectiveSpeechRate;
      }

      let blobUrl = this.audioQueue.getBlobUrl(seg.audioCacheKey);
      if (!blobUrl) {
        try {
          if (this.useBuiltinTts) {
            blobUrl =
              (await this.builtinTtsClient.getCachedBlobUrl(
                seg.audioCacheKey,
                this.settings.cacheInvalidatedAtMs,
              )) ?? undefined;
            if (!blobUrl) {
              const fresh = await this.builtinTtsClient.synthesizeAndCache({
                audioCacheKey: seg.audioCacheKey,
                text: seg.translatedText!,
                voiceVariant: resolveBuiltinFallbackVoiceId(
                  this.settings.engineId,
                  this.settings.voiceId,
                ),
                minValidTimestampMs: this.settings.cacheInvalidatedAtMs,
                signal: this.workerAbortController.signal,
              });
              blobUrl = fresh.blobUrl;
            }
          } else {
            blobUrl = await this.ttsClient.fetchAudioBlobUrl(
              seg.audioCacheKey,
              this.workerAbortController.signal,
            );
          }
          this.audioQueue.storePreloadedBlobUrl(seg.audioCacheKey, blobUrl);
        } catch {
          continue;
        }
      }

      this.playbackState = { ...this.playbackState, activeSegmentIndex: idx };
      if (!isResumingBookmarkedSeg) {
        this.activeChunk = seg.displayChunks?.[0] ?? null;
      }
      this.emitSnapshot();

      try {
        await this.audioQueue.playSegment({
          segmentIndex: idx,
          audioCacheKey: seg.audioCacheKey,
          blobUrl,
          effectiveSpeechRate,
          startOffsetSec,
        });
      } catch {
        // Interrupted or transient decode error
      }

      if (
        this.disposed ||
        myLoopId !== this.playbackLoopId ||
        activeSession !== this.playbackState.sessionId ||
        this.playbackState.intent !== 'PLAY'
      ) {
        return;
      }

      this.prevAudioEndClockMs = performance.now();

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

  private persistCurrentManifest(): Promise<void> {
    if (!this.videoKey || this.disposed) return Promise.resolve();
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
    }
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      if (!this.videoKey || this.disposed) return;
      void saveVideoManifest({
        videoKey: this.videoKey,
        platform: this.platform,
        canonicalVideoId: this.canonicalVideoId,
        subtitleHash: this.subtitleHash,
        targetLang: 'vi',
        activeConfigVersion: this.activeConfigVersion,
        updatedAtMs: Date.now(),
        segments: toPersistedSegments(this.segments),
      });
    }, 350);
    return Promise.resolve();
  }

  private emitSnapshot(): void {
    if (this.disposed) return;
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
      segments: this.segments,
    });
  }
}
