import { describe, expect, it } from 'vitest';
import {
  extractKalturaLessonFromMultirequest,
  pickBestKalturaCaptionTrack,
} from '../src/adapters/gnomon/kalturaCaptionParser';

describe('kalturaCaptionParser', () => {
  it('extracts entryId, title, and playbackCaptions from Kaltura multirequest response', () => {
    const sampleResponse = [
      { ks: 'redacted' },
      {
        objects: [
          {
            id: '1_kp7f84n0',
            name: '01 - UE5 Setup & Light Actor Basics',
          },
        ],
      },
      {
        playbackCaptions: [
          {
            languageCode: 'es',
            language: 'Spanish',
            label: 'Spanish',
            isDefault: false,
            webVttUrl:
              'https://cfvod.kaltura.com/api_v3/index.php/service/caption_captionasset/action/serveWebVTT/captionAssetId/1_es/captions.vtt',
          },
          {
            languageCode: 'en',
            language: 'English',
            label: 'English',
            isDefault: true,
            webVttUrl:
              'https://cfvod.kaltura.com/api_v3/index.php/service/caption_captionasset/action/serveWebVTT/captionAssetId/1_en/captions.vtt',
          },
        ],
      },
    ];

    const parsed = extractKalturaLessonFromMultirequest(sampleResponse);
    expect(parsed).not.toBeNull();
    expect(parsed?.entryId).toBe('1_kp7f84n0');
    expect(parsed?.title).toBe('01 - UE5 Setup & Light Actor Basics');
    expect(parsed?.tracks).toHaveLength(2);

    const best = pickBestKalturaCaptionTrack(parsed!.tracks);
    expect(best?.languageCode).toBe('en');
    expect(best?.url).toContain('captionAssetId/1_en/captions.vtt');
  });

  it('returns null when payload has no entryId and no captions', () => {
    expect(extractKalturaLessonFromMultirequest([{ status: 'ok' }])).toBeNull();
    expect(pickBestKalturaCaptionTrack([])).toBeNull();
  });
});
