export interface KalturaCaptionTrack {
  url: string;
  languageCode: string;
  language: string;
  label: string;
  isDefault: boolean;
}

export interface KalturaLessonMetadata {
  entryId: string;
  title: string;
  tracks: KalturaCaptionTrack[];
}

function isLikelySubtitleUrl(url: string): boolean {
  return Boolean(url) && !/(?:sprite|thumb|storyboard|chapter)/i.test(url);
}

function parsePlaybackCaptions(raw: unknown): KalturaCaptionTrack[] {
  if (!Array.isArray(raw)) return [];
  const out: KalturaCaptionTrack[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const webVttUrl = typeof rec.webVttUrl === 'string' ? rec.webVttUrl.trim() : '';
    const fallbackUrl = typeof rec.url === 'string' ? rec.url.trim() : '';
    const chosenUrl = isLikelySubtitleUrl(webVttUrl)
      ? webVttUrl
      : isLikelySubtitleUrl(fallbackUrl)
        ? fallbackUrl
        : '';
    if (!chosenUrl) continue;

    const languageCode = (
      typeof rec.languageCode === 'string'
        ? rec.languageCode
        : typeof rec.language === 'string'
          ? rec.language
          : ''
    )
      .trim()
      .toLowerCase();
    const language = typeof rec.language === 'string' ? rec.language.trim() : languageCode;
    const label = typeof rec.label === 'string' ? rec.label.trim() : language || languageCode;
    const isDefault = Boolean(rec.isDefault);

    out.push({
      url: chosenUrl,
      languageCode,
      language,
      label,
      isDefault,
    });
  }

  return out;
}

/**
 * Extracts Kaltura `entryId`, lesson `title`, and `playbackCaptions` from a Kaltura
 * `api_v3/service/multirequest` JSON response (typically an array of sub-responses).
 */
export function extractKalturaLessonFromMultirequest(payload: unknown): KalturaLessonMetadata | null {
  if (!payload || typeof payload !== 'object') return null;
  const items = Array.isArray(payload) ? payload : [payload];

  let entryId = '';
  let title = '';
  let tracks: KalturaCaptionTrack[] = [];

  for (const part of items) {
    if (!part || typeof part !== 'object') continue;
    const obj = part as Record<string, unknown>;

    // 1. baseEntry.list response: { objects: [{ id, name, ... }] }
    if (Array.isArray(obj.objects)) {
      for (const entry of obj.objects) {
        if (!entry || typeof entry !== 'object') continue;
        const eRec = entry as Record<string, unknown>;
        if (!entryId && typeof eRec.id === 'string' && eRec.id.trim()) {
          entryId = eRec.id.trim();
        }
        if (!title && typeof eRec.name === 'string' && eRec.name.trim()) {
          title = eRec.name.trim();
        }
      }
    }

    // 2. Direct entry object: { id, name }
    if (!entryId && typeof obj.id === 'string' && /^[\da-zA-Z]+_[\da-zA-Z]+$/.test(obj.id.trim())) {
      entryId = obj.id.trim();
    }
    if (!title && typeof obj.name === 'string' && obj.name.trim()) {
      title = obj.name.trim();
    }

    // 3. baseEntry.getPlaybackContext response: { playbackCaptions: [...] }
    if (Array.isArray(obj.playbackCaptions)) {
      const parsed = parsePlaybackCaptions(obj.playbackCaptions);
      if (parsed.length > 0) {
        tracks = parsed;
      }
    }
  }

  if (!entryId && tracks.length === 0) return null;
  return { entryId, title, tracks };
}

/**
 * Picks the best source caption track for DubCera (prefers English, then non-Vietnamese).
 */
export function pickBestKalturaCaptionTrack(
  tracks: ReadonlyArray<KalturaCaptionTrack>,
): KalturaCaptionTrack | null {
  if (tracks.length === 0) return null;

  const isEnglish = (t: KalturaCaptionTrack) =>
    t.languageCode === 'en' ||
    t.languageCode.startsWith('en-') ||
    t.languageCode.startsWith('en_') ||
    t.language.toLowerCase().startsWith('english') ||
    t.label.toLowerCase().startsWith('english');

  const enDefault = tracks.find((t) => isEnglish(t) && t.isDefault);
  if (enDefault) return enDefault;

  const enAny = tracks.find(isEnglish);
  if (enAny) return enAny;

  const nonVi = tracks.find(
    (t) =>
      !t.languageCode.startsWith('vi') && !t.language.toLowerCase().startsWith('vietnamese'),
  );
  return nonVi ?? tracks[0] ?? null;
}
