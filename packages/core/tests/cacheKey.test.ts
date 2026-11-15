import { describe, expect, it } from 'vitest';
import {
  buildAudioCacheKey,
  computeConfigVersion,
  sha256Hex,
  type SynthesisConfigSnapshot,
} from '../src/index';

async function webCryptoSha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('SHA-256 & CacheKeyBuilder Integrity (Invariant I5)', () => {
  const baseConfig: SynthesisConfigSnapshot = {
    targetLang: 'vi',
    voiceId: 'vieneu-nam-bac',
    engineId: 'vieneu-onnx',
    modelVersion: 'v3.0',
    sampleRate: 24000,
    styleOrPitchConfig: 'neutral',
    pauseConfig: 'default',
  };

  it('matches standard WebCrypto SHA-256 byte-for-byte on Vietnamese UTF-8 strings', async () => {
    const samples = [
      '',
      'Xin chào thế giới!',
      'Đầu tiên, chúng ta gắn thành phần Rigidbody2D vào GameObject người chơi để kiểm tra va chạm.',
      'A'.repeat(200),
    ];

    for (const s of samples) {
      const expected = await webCryptoSha256Hex(s);
      expect(sha256Hex(s)).toBe(expected);
    }
  });

  it('produces distinct cache keys when Vietnamese tone marks, voiceId, or synthesis parameters change', () => {
    const key1 = buildAudioCacheKey('Tạo một đối tượng mới.', baseConfig);
    const keyToneChanged = buildAudioCacheKey('Tạo một đối tượng mời.', baseConfig);
    const keyVoiceChanged = buildAudioCacheKey('Tạo một đối tượng mới.', {
      ...baseConfig,
      voiceId: 'vieneu-nu-nam',
    });
    const keyRateChanged = buildAudioCacheKey('Tạo một đối tượng mới.', {
      ...baseConfig,
      sampleRate: 48000,
    });

    expect(key1).not.toBe(keyToneChanged);
    expect(key1).not.toBe(keyVoiceChanged);
    expect(key1).not.toBe(keyRateChanged);

    // Identical after NFC + whitespace normalization
    const keyNormalizedMatch = buildAudioCacheKey('  Tạo   một đối tượng mới. \n', baseConfig);
    expect(keyNormalizedMatch).toBe(key1);

    expect(computeConfigVersion(baseConfig)).not.toBe(
      computeConfigVersion({ ...baseConfig, modelVersion: 'v3.1' }),
    );
  });
});
