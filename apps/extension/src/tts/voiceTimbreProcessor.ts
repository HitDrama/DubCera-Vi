export type BuiltinVoiceVariantId =
  | 'vi-standard'
  | 'vi-male-lecture'
  | 'vi-male-warm'
  | 'vi-female-bright';

interface VoiceTimbrePreset {
  pitchFactor: number;
  mudCutHz: number;
  mudCutGainDb: number;
  presenceHz: number;
  presenceGainDb: number;
  airShelfGainDb: number;
}

const TIMBRE_PRESETS: Record<Exclude<BuiltinVoiceVariantId, 'vi-standard'>, VoiceTimbrePreset> = {
  'vi-male-lecture': {
    pitchFactor: 0.80, // ~ -3.86 semitones -> crisp baritone lecturer (~168 Hz)
    mudCutHz: 360,
    mudCutGainDb: -2.8,
    presenceHz: 2950,
    presenceGainDb: 3.6,
    airShelfGainDb: 2.0,
  },
  'vi-male-warm': {
    pitchFactor: 0.75, // ~ -4.98 semitones -> deep warm narrator (~156 Hz)
    mudCutHz: 340,
    mudCutGainDb: -3.2,
    presenceHz: 2800,
    presenceGainDb: 3.8,
    airShelfGainDb: 2.2,
  },
  'vi-female-bright': {
    pitchFactor: 1.08, // ~ +1.33 semitones -> bright youthful female
    mudCutHz: 420,
    mudCutGainDb: -1.2,
    presenceHz: 3400,
    presenceGainDb: 1.8,
    airShelfGainDb: 1.5,
  },
};

export function getBuiltinVoiceShortLabel(variant: BuiltinVoiceVariantId): string {
  switch (variant) {
    case 'vi-male-lecture':
      return 'Nam Trầm Bài Giảng';
    case 'vi-male-warm':
      return 'Nam Ấm Kể Chuyện';
    case 'vi-female-bright':
      return 'Nữ Thanh Trẻ Trung';
    case 'vi-standard':
    default:
      return 'Nữ Tự Nhiên';
  }
}

export function resolveBuiltinFallbackVoiceId(
  engineId: string,
  voiceId: string,
): BuiltinVoiceVariantId {
  if (engineId === 'builtin-cloud-vi') {
    if (
      voiceId === 'vi-male-lecture' ||
      voiceId === 'vi-male-warm' ||
      voiceId === 'vi-female-bright' ||
      voiceId === 'vi-standard'
    ) {
      return voiceId;
    }
    return 'vi-standard';
  }

  // If user selected a Local VieNeu voice while tts-local server is off, preserve Male vs Female gender!
  const vLower = voiceId.toLowerCase();
  const isMaleLocalVoice =
    vLower.includes('quân') ||
    vLower.includes('khôi') ||
    vLower.includes('adam') ||
    vLower.includes('đăng') ||
    vLower.includes('minh') ||
    vLower.includes('sơn') ||
    vLower.includes('trí') ||
    vLower.includes('dũng');

  return isMaleLocalVoice ? 'vi-male-lecture' : 'vi-standard';
}

/**
 * Time-domain Pitch-Synchronous Waveform Similarity Overlap-Add (WSOLA).
 * Scales duration by `alpha` without altering pitch or introducing phase-vocoder metallic artifacts.
 */
export function wsolaTimeScale(input: Float32Array, alpha: number, sampleRate = 24000): Float32Array {
  if (input.length < 1200 || Math.abs(alpha - 1.0) < 0.01) {
    return input;
  }

  const winSize = Math.round(sampleRate * 0.025); // 25ms Hann window (600 samples @ 24kHz)
  const hopS = Math.round(sampleRate * 0.010);    // 10ms synthesis hop (240 samples @ 24kHz)
  const hopA = Math.max(1, Math.round(hopS / alpha));
  const searchRadius = Math.round(sampleRate * 0.0055); // +-5.5ms pitch period lock

  const hann = new Float32Array(winSize);
  for (let i = 0; i < winSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winSize - 1)));
  }

  const expectedOutLen = Math.max(winSize, Math.round(input.length * alpha) + winSize);
  const out = new Float32Array(expectedOutLen);
  const norm = new Float32Array(expectedOutLen);

  for (let i = 0; i < winSize && i < input.length; i++) {
    const w = hann[i]!;
    out[i] = input[i]! * w;
    norm[i] = w;
  }

  let inPos = 0;
  let outPos = 0;
  const corrLen = Math.min(hopS, winSize >> 1);

  while (outPos + hopS + winSize < expectedOutLen && inPos + hopA + winSize < input.length) {
    outPos += hopS;
    const idealIn = inPos + hopA;
    const lo = Math.max(0, idealIn - searchRadius);
    const hi = Math.min(input.length - winSize, idealIn + searchRadius);

    let bestCand = idealIn;
    let bestScore = -1e30;

    // Step by 2 samples for fast coarse pitch-period alignment, then refine +-1 sample
    for (let cand = lo; cand <= hi; cand += 2) {
      let dot = 0;
      let energy = 1e-9;
      for (let k = 0; k < corrLen; k += 2) {
        const a = out[outPos + k]!;
        const b = input[cand + k]!;
        dot += a * b;
        energy += b * b;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        bestCand = cand;
      }
    }

    inPos = Math.max(0, Math.min(input.length - winSize, bestCand));

    for (let i = 0; i < winSize; i++) {
      const w = hann[i]!;
      out[outPos + i]! += input[inPos + i]! * w;
      norm[outPos + i]! += w;
    }
  }

  const finalLen = Math.min(expectedOutLen, outPos + winSize);
  const result = new Float32Array(finalLen);
  for (let i = 0; i < finalLen; i++) {
    const w = norm[i]!;
    result[i] = w > 1e-4 ? out[i]! / w : out[i]!;
  }
  return result;
}

/**
 * 4-point Hermite cubic interpolation resampler.
 * Stepping by `step = pitchFactor` shifts pitch by `pitchFactor` while restoring exact 1.00x tempo.
 */
export function resampleHermite(input: Float32Array, step: number): Float32Array {
  if (input.length < 4 || Math.abs(step - 1.0) < 0.005) {
    return input;
  }
  const outLen = Math.max(1, Math.floor((input.length - 2) / step));
  const out = new Float32Array(outLen);
  const maxIdx = input.length - 1;

  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const idx = Math.floor(pos);
    const frac = pos - idx;

    const y0 = input[Math.max(0, idx - 1)]!;
    const y1 = input[Math.min(maxIdx, idx)]!;
    const y2 = input[Math.min(maxIdx, idx + 1)]!;
    const y3 = input[Math.min(maxIdx, idx + 2)]!;

    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);

    out[i] = ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
  return out;
}

export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }
  const gain = peak > 0.85 ? 0.85 / peak : peak > 0.02 && peak < 0.45 ? Math.min(1.8, 0.65 / peak) : 1.0;

  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let byteOffset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]! * gain));
    view.setInt16(byteOffset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    byteOffset += 2;
  }

  return new Uint8Array(buf);
}

/**
 * Applies zero-server vocal timbre transformation (WSOLA pitch shift at exact 1.00x tempo
 * + vocal-tract formant EQ) inside OfflineAudioContext.
 */
export async function applyBuiltinVoiceVariantPcm(
  cleanPcm: Float32Array,
  sampleRate: number,
  variant: Exclude<BuiltinVoiceVariantId, 'vi-standard'>,
): Promise<Float32Array> {
  const preset = TIMBRE_PRESETS[variant];
  const stretched = wsolaTimeScale(cleanPcm, preset.pitchFactor, sampleRate);
  const pitched = resampleHermite(stretched, preset.pitchFactor);

  const OfflineCtx =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : typeof (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
            .webkitOfflineAudioContext !== 'undefined'
        ? (globalThis as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
            .webkitOfflineAudioContext
        : null;

  if (!OfflineCtx || pitched.length === 0) {
    return pitched;
  }

  try {
    const ctx = new OfflineCtx(1, pitched.length, sampleRate);
    const srcBuf = ctx.createBuffer(1, pitched.length, sampleRate);
    srcBuf.getChannelData(0).set(pitched);

    const srcNode = ctx.createBufferSource();
    srcNode.buffer = srcBuf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 75;

    const mudCut = ctx.createBiquadFilter();
    mudCut.type = 'peaking';
    mudCut.frequency.value = preset.mudCutHz;
    mudCut.Q.value = 1.15;
    mudCut.gain.value = preset.mudCutGainDb;

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = preset.presenceHz;
    presence.Q.value = 1.0;
    presence.gain.value = preset.presenceGainDb;

    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 6200;
    air.gain.value = preset.airShelfGainDb;

    srcNode.connect(hp);
    hp.connect(mudCut);
    mudCut.connect(presence);
    presence.connect(air);
    air.connect(ctx.destination);

    srcNode.start(0);
    const rendered = await ctx.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } catch {
    return pitched;
  }
}
