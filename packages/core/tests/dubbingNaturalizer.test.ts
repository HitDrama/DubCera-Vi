import { describe, expect, it } from 'vitest';
import {
  cleanSourceForTranslation,
  groupCuesIntoSegments,
  polishTranslatedVietnamese,
  toSpokenVietnameseTtsText,
} from '../src';

describe('Dubbing Naturalizer & ASR Clause Grouping', () => {
  it('cleans ASR fillers, stutters, and disambiguates UI properties before NMT', () => {
    const raw =
      'so uh we we are going to check Use Gravity on our player GameObject';
    const cleaned = cleanSourceForTranslation(raw);
    expect(cleaned).toBe(
      'So we are going to tick "Use Gravity" on our Player GameObject',
    );
  });

  it('polishes literal NMT calques into natural spoken Vietnamese lecture phrasing', () => {
    const rawVi =
      'Vì vậy, chúng ta hãy tiếp tục và kiểm tra Sử dụng Gravity trong Thanh tra trên GameObject trình phát của chúng tôi, hãy kiểm tra nó.';
    const src =
      'So let us go ahead and check Use Gravity in the Inspector on our player GameObject, let us check it out.';

    const polished = polishTranslatedVietnamese(rawVi, src);
    expect(polished).toContain('trong cửa sổ Inspector');
    expect(polished).toContain('Player GameObject');
    expect(polished).toContain('của chúng ta');
    expect(polished).not.toContain('tiếp tục và');
    expect(polished).toContain('hãy cùng xem thử nhé.');
  });

  it('generates phonetically clear Vietnamese TTS script without mutating subtitle display text', () => {
    const displaySubtitle =
      'Trong Unity 3D, hãy gắn script C# vào GameObject có Rigidbody2D để gọi API ở mức 60fps với hệ số 1.5 (100%).';
    const spoken = toSpokenVietnameseTtsText(displaySubtitle);

    expect(spoken).toContain('ba đê');
    expect(spoken).toContain('xi thăng');
    expect(spoken).toContain('Game Object');
    expect(spoken).toContain('Rigid body hai đê');
    expect(spoken).toContain('A P I');
    expect(spoken).toContain('60 ép pê ét');
    expect(spoken).toContain('1 chấm 5');
    expect(spoken).toContain('100 phần trăm');
  });

  it('splits unpunctuated YouTube ASR auto-captions at discourse markers and never severs dangling prepositions', () => {
    const asrCues = [
      { cueId: '1', startMs: 0, endMs: 2200, rawText: 'welcome back to the channel guys today we' },
      { cueId: '2', startMs: 2200, endMs: 4900, rawText: 'are going to build a third person controller in' },
      { cueId: '3', startMs: 4900, endMs: 6200, rawText: 'the unity engine' },
      { cueId: '4', startMs: 6250, endMs: 8800, rawText: 'so first let us create a new script inside our project' },
    ];

    const segments = groupCuesIntoSegments(asrCues);
    expect(segments.length).toBe(2);
    // Cue 2 ended with dangling "in" -> Cue 3 ("the unity engine") MUST stay attached before splitting at "so first..."!
    expect(segments[0]!.sourceText).toBe(
      'welcome back to the channel guys today we are going to build a third person controller in the unity engine',
    );
    expect(segments[1]!.sourceText).toBe(
      'so first let us create a new script inside our project',
    );
  });
});
