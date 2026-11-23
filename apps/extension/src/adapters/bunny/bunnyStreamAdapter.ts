import { parseVtt, type SubtitleCue } from '@dubcera/core';

export interface RawTrackCueLike {
  id?: string;
  startTime: number;
  endTime: number;
  text?: string;
}

export interface BunnyCueExtractionResult {
  cues: SubtitleCue[];
  source: 'vtt-track' | 'text-track-cues' | 'none';
  language: string | null;
}

/**
 * Extracts a stable, session-independent canonical video ID from a Bunny Stream
 * embed/play URL (e.g. `https://iframe.mediadelivery.net/embed/289162/<guid>`).
 * Never returns `blob:` URLs or query-string tokens.
 */
export function parseBunnyEmbedVideoId(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr);
    if (parsed.hostname.toLowerCase() !== 'iframe.mediadelivery.net') {
      return null;
    }
    const match = parsed.pathname.match(/^\/(?:embed|play)\/([^/]+)\/([^/]+)/i);
    if (match?.[1] && match?.[2]) {
      return `${match[1]}/${match[2]}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function isBunnyEmbedUrl(urlStr: string): boolean {
  return parseBunnyEmbedVideoId(urlStr) !== null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function cleanCueText(raw: string): string {
  const stripped = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r?\n+/g, ' ');
  return decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes raw `TextTrackCueList` items into ordered, deduplicated, non-empty `SubtitleCue[]`.
 */
export function normalizeTextTrackCues(rawCues: ArrayLike<RawTrackCueLike>): SubtitleCue[] {
  const collected: SubtitleCue[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawCues.length; i++) {
    const item = rawCues[i];
    if (!item || typeof item.text !== 'string') continue;

    const cleaned = cleanCueText(item.text);
    if (!cleaned) continue;

    const startMs = Math.max(0, Math.round(item.startTime * 1000));
    const endMs = Math.max(startMs, Math.round(item.endTime * 1000));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    const dedupeKey = `${startMs}|${endMs}|${cleaned}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    collected.push({
      cueId: item.id && item.id.trim() ? item.id.trim() : `bunny-cue-${collected.length}`,
      startMs,
      endMs,
      rawText: cleaned,
    });
  }

  collected.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return collected;
}

function isEnglishLang(lang: string | null | undefined, label?: string | null): boolean {
  const normLang = (lang ?? '').trim().toLowerCase();
  if (normLang === 'en' || normLang.startsWith('en-') || normLang.startsWith('en_')) {
    return true;
  }
  const normLabel = (label ?? '').trim().toLowerCase();
  return normLabel === 'english' || normLabel.startsWith('english ');
}

function selectEnglishTrackElement(video: HTMLVideoElement): HTMLTrackElement | null {
  const trackEls = Array.from(video.querySelectorAll('track')).filter((el) => {
    const kind = (el.getAttribute('kind') ?? '').toLowerCase();
    const src = el.getAttribute('src') ?? '';
    if (kind === 'metadata' || kind === 'chapters') return false;
    if (/(?:sprite|thumb|storyboard)/i.test(src)) return false;
    return Boolean(src);
  });

  const enTrack = trackEls.find((el) =>
    isEnglishLang(el.getAttribute('srclang'), el.getAttribute('label')),
  );
  return enTrack ?? null;
}

function selectEnglishTextTrack(video: HTMLVideoElement): TextTrack | null {
  const tracks = Array.from(video.textTracks ?? []).filter(
    (t) => t.kind === 'captions' || t.kind === 'subtitles',
  );
  if (tracks.length === 0) return null;

  const enTrack = tracks.find((t) => isEnglishLang(t.language, t.label));
  return enTrack ?? null;
}

async function waitForTrackCues(
  track: TextTrack,
  timeoutMs: number,
): Promise<TextTrackCueList | null> {
  if (track.cues && track.cues.length > 0) {
    return track.cues;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    if (track.cues && track.cues.length > 0) {
      return track.cues;
    }
  }
  return track.cues && track.cues.length > 0 ? track.cues : null;
}

/**
 * Extracts all English cues with timestamps from a Bunny Stream `<video id="main-video">`.
 *
 * Strategy:
 * 1. Prefer fetching the English `<track kind="captions" srclang="en" src="...vtt">` directly
 *    (does not touch `track.mode`, preserves user's CC display state, works immediately at 00:00 paused).
 * 2. Fallback to reading `video.textTracks` English track (`mode = 'hidden'` while loading,
 *    restoring original `track.mode` afterward so user preference is preserved).
 *
 * Never uses `.plyr__caption` DOM text as a source.
 */
export async function extractBunnyEnglishCues(
  video: HTMLVideoElement,
  fetchVtt: (url: string) => Promise<string | null>,
  waitTimeoutMs = 3500,
): Promise<BunnyCueExtractionResult> {
  // 1. Direct VTT fetch from English <track> element (fastest & completely non-invasive)
  const enTrackEl = selectEnglishTrackElement(video);
  const trackSrc = enTrackEl?.getAttribute('src');
  if (trackSrc) {
    try {
      const vttText = await fetchVtt(trackSrc);
      if (vttText) {
        const parsed = parseVtt(vttText);
        if (parsed.length > 0) {
          return {
            cues: parsed,
            source: 'vtt-track',
            language: enTrackEl?.getAttribute('srclang') ?? 'en',
          };
        }
      }
    } catch {
      // Fall through to TextTrack.cues API
    }
  }

  // 2. Fallback: read from video.textTracks English track
  const enTextTrack = selectEnglishTextTrack(video);
  if (!enTextTrack) {
    return { cues: [], source: 'none', language: null };
  }

  const originalMode = enTextTrack.mode;
  try {
    if (originalMode === 'disabled') {
      enTextTrack.mode = 'hidden';
    }
    const cueList = await waitForTrackCues(enTextTrack, waitTimeoutMs);
    if (!cueList || cueList.length === 0) {
      return { cues: [], source: 'none', language: enTextTrack.language || 'en' };
    }

    const normalized = normalizeTextTrackCues(cueList as unknown as ArrayLike<RawTrackCueLike>);
    return {
      cues: normalized,
      source: normalized.length > 0 ? 'text-track-cues' : 'none',
      language: enTextTrack.language || 'en',
    };
  } finally {
    // Restore original CC visibility preference (e.g. if user had CC disabled or showing)
    try {
      if (enTextTrack.mode !== originalMode) {
        enTextTrack.mode = originalMode;
      }
    } catch {
      // Ignore if track was detached
    }
  }
}
