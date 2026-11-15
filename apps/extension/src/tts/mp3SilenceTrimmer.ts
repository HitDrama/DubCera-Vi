import {
  applyBuiltinVoiceVariantPcm,
  encodeMonoPcm16Wav,
  type BuiltinVoiceVariantId,
} from './voiceTimbreProcessor';

export interface Mp3FrameDescriptor {
  offset: number;
  length: number;
  samplesPerFrame: number;
  sampleRate: number;
  durationMs: number;
}

const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLERATES_MPEG1 = [44100, 48000, 32000, 0];
const SAMPLERATES_MPEG2 = [22050, 24000, 16000, 0];
const SAMPLERATES_MPEG25 = [11025, 12000, 8000, 0];

/**
 * Parses exact MPEG Layer III frame boundaries so MP3 buffers can be sliced losslessly
 * without re-encoding or introducing boundary clicks.
 */
export function parseMp3Frames(bytes: Uint8Array): Mp3FrameDescriptor[] {
  const frames: Mp3FrameDescriptor[] = [];
  let pos = 0;

  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    const id3Size =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    pos = 10 + id3Size;
  }

  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff || (bytes[pos + 1]! & 0xe0) !== 0xe0) {
      pos += 1;
      continue;
    }

    const b1 = bytes[pos + 1]!;
    const b2 = bytes[pos + 2]!;
    const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (b1 >> 1) & 0x03;   // 1 = Layer III
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;

    if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      pos += 1;
      continue;
    }

    const isMpeg1 = versionBits === 3;
    const bitrateKbps = isMpeg1 ? BITRATES_MPEG1_L3[bitrateIdx]! : BITRATES_MPEG2_L3[bitrateIdx]!;
    const sampleRate =
      versionBits === 3
        ? SAMPLERATES_MPEG1[srIdx]!
        : versionBits === 2
          ? SAMPLERATES_MPEG2[srIdx]!
          : SAMPLERATES_MPEG25[srIdx]!;

    if (!bitrateKbps || !sampleRate) {
      pos += 1;
      continue;
    }

    const samplesPerFrame = isMpeg1 ? 1152 : 576;
    const coeff = isMpeg1 ? 144_000 : 72_000;
    const frameLength = Math.floor((coeff * bitrateKbps) / sampleRate) + padding;

    if (frameLength < 24 || pos + frameLength > bytes.length) {
      break;
    }

    frames.push({
      offset: pos,
      length: frameLength,
      samplesPerFrame,
      sampleRate,
      durationMs: (samplesPerFrame * 1000) / sampleRate,
    });

    pos += frameLength;
  }

  return frames;
}

function getOfflineAudioConstructor(): typeof OfflineAudioContext | null {
  if (typeof OfflineAudioContext !== 'undefined') return OfflineAudioContext;
  const wk = (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
    .webkitOfflineAudioContext;
  return wk ?? null;
}

async function decodeAndAnalyzeChunk(
  chunk: Uint8Array,
  frames: Mp3FrameDescriptor[],
  isLastChunk: boolean,
): Promise<{
  slicedMp3: Uint8Array;
  trimmedPcm: Float32Array | null;
  sampleRate: number;
  durationMs: number;
}> {
  const OfflineCtx = getOfflineAudioConstructor();
  const targetSr = frames[0]?.sampleRate || 24000;

  if (!OfflineCtx || frames.length < 4) {
    const totalMs = frames.reduce((acc, f) => acc + f.durationMs, 0);
    return {
      slicedMp3: chunk,
      trimmedPcm: null,
      sampleRate: targetSr,
      durationMs: totalMs > 0 ? totalMs : Math.max(250, Math.round(chunk.byteLength / 8)),
    };
  }

  const ctx = new OfflineCtx(1, 1, targetSr);
  const copyBuf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
  const decoded = await ctx.decodeAudioData(copyBuf);
  const pcm = decoded.getChannelData(0);
  const spf = frames[0]!.samplesPerFrame;

  let firstActive = -1;
  let lastActive = -1;

  for (let i = 0; i < frames.length; i++) {
    const startSample = i * spf;
    const endSample = Math.min(pcm.length, startSample + spf);
    if (startSample >= endSample) break;

    let sumSq = 0;
    for (let s = startSample; s < endSample; s++) {
      const v = pcm[s]!;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / (endSample - startSample));
    if (rms > 0.0022) {
      if (firstActive === -1) firstActive = i;
      lastActive = i;
    }
  }

  if (firstActive === -1 || lastActive === -1 || lastActive < firstActive) {
    const totalMs = frames.reduce((acc, f) => acc + f.durationMs, 0);
    return {
      slicedMp3: chunk,
      trimmedPcm: new Float32Array(pcm),
      sampleRate: decoded.sampleRate,
      durationMs: totalMs,
    };
  }

  const startIdx = Math.max(0, firstActive - 1);
  const tailPadFrames = isLastChunk ? 2 : 4;
  const endIdxExclusive = Math.min(frames.length, lastActive + 1 + tailPadFrames);

  const byteStart = frames[startIdx]!.offset;
  const lastFrame = frames[endIdxExclusive - 1]!;
  const byteEnd = lastFrame.offset + lastFrame.length;

  const pcmStart = Math.min(pcm.length, startIdx * spf);
  const pcmEnd = Math.min(pcm.length, endIdxExclusive * spf);
  const trimmedPcm = pcm.slice(pcmStart, pcmEnd);

  let durationMs = 0;
  for (let i = startIdx; i < endIdxExclusive; i++) {
    durationMs += frames[i]!.durationMs;
  }

  return {
    slicedMp3: chunk.subarray(byteStart, byteEnd),
    trimmedPcm,
    sampleRate: decoded.sampleRate,
    durationMs,
  };
}

/**
 * Trims ~115ms leading silence and ~860ms trailing dead silence from Google TTS chunks,
 * and applies zero-server Male/Female WSOLA vocal timbre processing when a non-default
 * Built-in voice (`vi-male-lecture`, `vi-male-warm`, `vi-female-bright`) is selected.
 */
export async function trimAndMergeMp3Chunks(
  chunks: Uint8Array[],
  variant: BuiltinVoiceVariantId = 'vi-standard',
): Promise<{
  audioBytes: Uint8Array;
  mimeType: string;
  audioDurationMs: number;
}> {
  if (chunks.length === 0) {
    return { audioBytes: new Uint8Array(0), mimeType: 'audio/mpeg', audioDurationMs: 250 };
  }

  const trimmedMp3Parts: Uint8Array[] = [];
  const trimmedPcmParts: Float32Array[] = [];
  let totalMp3Bytes = 0;
  let totalPcmSamples = 0;
  let detectedSr = 24000;
  let totalDurationMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const frames = parseMp3Frames(chunk);

    if (frames.length >= 4) {
      try {
        const res = await decodeAndAnalyzeChunk(chunk, frames, isLast);
        trimmedMp3Parts.push(res.slicedMp3);
        totalMp3Bytes += res.slicedMp3.byteLength;
        totalDurationMs += res.durationMs;
        detectedSr = res.sampleRate;
        if (res.trimmedPcm) {
          trimmedPcmParts.push(res.trimmedPcm);
          totalPcmSamples += res.trimmedPcm.length;
        }
        continue;
      } catch {
        const fallbackMs = frames.reduce((acc, f) => acc + f.durationMs, 0);
        trimmedMp3Parts.push(chunk);
        totalMp3Bytes += chunk.byteLength;
        totalDurationMs += fallbackMs;
        continue;
      }
    }

    trimmedMp3Parts.push(chunk);
    totalMp3Bytes += chunk.byteLength;
    totalDurationMs += Math.max(200, Math.round(chunk.byteLength / 8));
  }

  // Zero-Server Male / Bright Female Timbre Transformation via WSOLA + Formant EQ
  if (variant !== 'vi-standard' && trimmedPcmParts.length > 0 && totalPcmSamples > 0) {
    const combinedPcm = new Float32Array(totalPcmSamples);
    let sampleOffset = 0;
    for (const p of trimmedPcmParts) {
      combinedPcm.set(p, sampleOffset);
      sampleOffset += p.length;
    }

    const transformedPcm = await applyBuiltinVoiceVariantPcm(combinedPcm, detectedSr, variant);
    const wavBytes = encodeMonoPcm16Wav(transformedPcm, detectedSr);
    const exactMs = Math.max(220, Math.round((transformedPcm.length * 1000) / detectedSr));

    return {
      audioBytes: wavBytes,
      mimeType: 'audio/wav',
      audioDurationMs: exactMs,
    };
  }

  const mergedMp3 = new Uint8Array(totalMp3Bytes);
  let offset = 0;
  for (const part of trimmedMp3Parts) {
    mergedMp3.set(part, offset);
    offset += part.byteLength;
  }

  return {
    audioBytes: mergedMp3,
    mimeType: 'audio/mpeg',
    audioDurationMs: Math.max(220, Math.round(totalDurationMs)),
  };
}
