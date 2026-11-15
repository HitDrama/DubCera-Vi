import { describe, expect, it } from 'vitest';
import {
  groupCuesIntoSegments,
  parseSrt,
  parseVtt,
  selectActiveDisplayChunk,
  splitIntoDisplayChunks,
} from '../src/index';

describe('Subtitle Parsers, Sentence Grouper & DisplayChunk Splitter', () => {
  it('merges mid-sentence VTT cues into a single coherent SpeechSegment while preserving cue IDs', () => {
    const sampleVtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000 align:start position:0%
First, we need to create

2
00:00:03.100 --> 00:00:05.000
a new <c.colorE5E5E5>GameObject</c> and

3
00:00:05.120 --> 00:00:07.200
add a Particle System.

4
00:00:08.500 --> 00:00:10.000
[Music]

5
00:00:10.200 --> 00:00:13.000
Now press Play in the Editor!
`;

    const cues = parseVtt(sampleVtt);
    expect(cues).toHaveLength(4); // [Music] filtered out
    const segments = groupCuesIntoSegments(cues);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.sourceText).toBe(
      'First, we need to create a new GameObject and add a Particle System.',
    );
    expect(segments[0]?.sourceCueIds).toEqual(['1', '2', '3']);
    expect(segments[0]?.startMs).toBe(1000);
    expect(segments[0]?.endMs).toBe(7200);
    expect(segments[0]?.nextSegmentStartMs).toBe(10200);

    expect(segments[1]?.sourceText).toBe('Now press Play in the Editor!');
  });

  it('deduplicates YouTube-style rolling auto-captions cleanly', () => {
    const rollingVtt = `WEBVTT

00:00:01.000 --> 00:00:02.500
welcome to unity

00:00:02.400 --> 00:00:04.500
welcome to unity shader graph tutorial.
`;
    const cues = parseVtt(rollingVtt);
    const segments = groupCuesIntoSegments(cues);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.sourceText).toBe('welcome to unity shader graph tutorial.');
  });

  it('parses SRT timestamps with comma milliseconds accurately', () => {
    const srt = `1
00:01:02,250 --> 00:01:05,750
Let's inspect the Rigidbody2D component.
`;
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.startMs).toBe(62_250);
    expect(cues[0]?.endMs).toBe(65_750);
  });

  it('parses Udemy-style compact VTT without blank line after WEBVTT header', () => {
    const udemyCompactVtt = `WEBVTT
00:00.120 --> 00:03.400
Shader Graph have a lot of purpose and
00:03.400 --> 00:06.800
it can create an amount of amazing effects.
`;
    const cues = parseVtt(udemyCompactVtt);
    expect(cues).toHaveLength(2);
    const segments = groupCuesIntoSegments(cues);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.sourceText).toBe(
      'Shader Graph have a lot of purpose and it can create an amount of amazing effects.',
    );
  });

  it('splits a 46-word Vietnamese translation into compact 1-2 line DisplayChunks without losing any words', () => {
    const longVi =
      'Trong bài học hôm nay, chúng ta sẽ tìm hiểu cách cấu hình thành phần Rigidbody2D trong Unity, sau đó kết hợp với Collider để xử lý va chạm vật lý một cách mượt mà, chính xác và không làm giảm tốc độ khung hình của trò chơi.';

    const chunks = splitIntoDisplayChunks('seg-0', longVi, undefined, { maxWordsPerChunk: 16 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(16);
      expect(wordCount).toBeGreaterThanOrEqual(4);
    }

    // Reconstruct exact words to guarantee 0 dropped words (Invariant I1)
    const reconstructed = chunks.map((c) => c.text).join(' ');
    expect(reconstructed).toBe(longVi);

    const weightSum = chunks.reduce((sum, c) => sum + c.weightRatio, 0);
    expect(weightSum).toBeCloseTo(1.0, 5);

    expect(selectActiveDisplayChunk(chunks, 0)?.chunkId).toBe('seg-0-c0');
    expect(selectActiveDisplayChunk(chunks, 0.99)?.chunkId).toBe(
      chunks[chunks.length - 1]?.chunkId,
    );
  });
});
