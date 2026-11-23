import { describe, expect, it } from 'vitest';
import {
  cleanCueText,
  isBunnyEmbedUrl,
  normalizeTextTrackCues,
  parseBunnyEmbedVideoId,
} from '../src/adapters/bunny/bunnyStreamAdapter';

describe('bunnyStreamAdapter', () => {
  it('parses stable canonical IDs from Bunny Stream embed/play URLs without query tokens', () => {
    expect(
      parseBunnyEmbedVideoId(
        'https://iframe.mediadelivery.net/embed/289162/45b6af10-cb33-4c94-b070-1ae93b402995?autoplay=true&preload=true',
      ),
    ).toBe('289162/45b6af10-cb33-4c94-b070-1ae93b402995');

    expect(
      parseBunnyEmbedVideoId(
        'https://iframe.mediadelivery.net/play/289162/a552f8ce-de40-4f36-b8e9-6e7b075f57ea',
      ),
    ).toBe('289162/a552f8ce-de40-4f36-b8e9-6e7b075f57ea');

    expect(isBunnyEmbedUrl('https://www.youtube-nocookie.com/embed/AdXF8BHZawY')).toBe(false);
    expect(isBunnyEmbedUrl('blob:https://iframe.mediadelivery.net/1234')).toBe(false);
    expect(parseBunnyEmbedVideoId('')).toBeNull();
  });

  it('cleans HTML tags, line breaks, and HTML entities from cue text', () => {
    expect(cleanCueText('<i>So in this &amp; next</i>\nvideo we&#39;re going to &lt;blockout&gt;')).toBe(
      "So in this & next video we're going to <blockout>",
    );
  });

  it('normalizes, sorts, deduplicates, and filters empty TextTrack cues', () => {
    const cues = normalizeTextTrackCues([
      { startTime: 2.45, endTime: 4.1, text: 'creating the blockout.' },
      { startTime: 0.33, endTime: 2.45, text: "So in this video we're going to be" },
      { startTime: 0.33, endTime: 2.45, text: "So in this video we're going to be" }, // duplicate
      { startTime: 5.0, endTime: 6.0, text: '   \n  ' }, // empty
    ]);

    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      cueId: 'bunny-cue-1',
      startMs: 330,
      endMs: 2450,
      rawText: "So in this video we're going to be",
    });
    expect(cues[1]).toEqual({
      cueId: 'bunny-cue-0',
      startMs: 2450,
      endMs: 4100,
      rawText: 'creating the blockout.',
    });
  });
});
