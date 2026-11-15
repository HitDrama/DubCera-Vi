import { describe, expect, it } from 'vitest';
import {
  applyBuiltinVoiceVariantPcm,
  encodeMonoPcm16Wav,
  getBuiltinVoiceShortLabel,
  resampleHermite,
  resolveBuiltinFallbackVoiceId,
  wsolaTimeScale,
} from '../src/tts/voiceTimbreProcessor';

describe('voiceTimbreProcessor', () => {
  it('resolves standalone builtin voice variants accurately without overwriting to vi-standard', () => {
    expect(resolveBuiltinFallbackVoiceId('builtin-cloud-vi', 'vi-standard')).toBe('vi-standard');
    expect(resolveBuiltinFallbackVoiceId('builtin-cloud-vi', 'vi-male-lecture')).toBe(
      'vi-male-lecture',
    );
    expect(resolveBuiltinFallbackVoiceId('builtin-cloud-vi', 'vi-male-warm')).toBe('vi-male-warm');
    expect(resolveBuiltinFallbackVoiceId('builtin-cloud-vi', 'vi-female-bright')).toBe(
      'vi-female-bright',
    );
    expect(getBuiltinVoiceShortLabel('vi-male-lecture')).toBe('Nam Trầm Bài Giảng');
  });

  it('preserves Male vs Female gender when falling back from offline VieNeu voices', () => {
    expect(resolveBuiltinFallbackVoiceId('vieneu-nano', 'Minh Quân')).toBe('vi-male-lecture');
    expect(resolveBuiltinFallbackVoiceId('vieneu-nano', 'Anh Khôi')).toBe('vi-male-lecture');
    expect(resolveBuiltinFallbackVoiceId('vieneu-nano', 'Adam')).toBe('vi-male-lecture');
    expect(resolveBuiltinFallbackVoiceId('vieneu-onnx', 'Hải Đăng')).toBe('vi-male-lecture');
    expect(resolveBuiltinFallbackVoiceId('vieneu-onnx', 'Thiện Minh')).toBe('vi-male-lecture');
    expect(resolveBuiltinFallbackVoiceId('vieneu-nano', 'Trúc Ly')).toBe('vi-standard');
    expect(resolveBuiltinFallbackVoiceId('vieneu-onnx', 'Thùy Dung')).toBe('vi-standard');
  });

  it('shifts pitch down via WSOLA + Hermite resampling while preserving exact 1.00x tempo', async () => {
    const sampleRate = 24000;
    const durationSec = 1.2;
    const totalSamples = Math.round(sampleRate * durationSec);
    const input = new Float32Array(totalSamples);
    const f0 = 210; // Female fundamental ~210 Hz
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      input[i] = 0.5 * Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(2 * Math.PI * 2 * f0 * t);
    }

    const stretched = wsolaTimeScale(input, 0.8, sampleRate);
    const pitched = resampleHermite(stretched, 0.8);
    const ratio = pitched.length / input.length;
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);

    const processed = await applyBuiltinVoiceVariantPcm(input, sampleRate, 'vi-male-lecture');
    expect(processed.length / input.length).toBeGreaterThan(0.97);
    expect(processed.length / input.length).toBeLessThan(1.03);
  });

  it('encodes valid 44-byte RIFF/WAVE mono 16-bit PCM header and payload', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 0.25]);
    const wav = encodeMonoPcm16Wav(pcm, 24000);
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    const ascii = String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!);
    const waveTag = String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!);
    expect(ascii).toBe('RIFF');
    expect(waveTag).toBe('WAVE');
  });
});
