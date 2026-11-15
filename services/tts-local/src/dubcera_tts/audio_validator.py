from __future__ import annotations

import math
import struct
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class WavInspectionResult:
    valid: bool
    duration_ms: int
    sample_rate: int
    channels: int
    sample_width_bytes: int
    num_frames: int
    reason: str = ""


def write_pcm16_wav(target_path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """
    Writes mono or stereo float/int numpy samples to a canonical 16-bit PCM RIFF/WAVE file
    without clipping or truncating trailing samples (Invariant I2).
    """
    arr = np.asarray(samples)
    if arr.ndim > 1:
        arr = arr.mean(axis=-1)

    if np.issubdtype(arr.dtype, np.floating):
        clipped = np.clip(arr, -1.0, 1.0)
        pcm16 = (clipped * 32767.0).astype(np.int16)
    elif arr.dtype == np.int16:
        pcm16 = arr
    else:
        pcm16 = arr.astype(np.int16)

    target_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())


def inspect_wav_file(path: Path, min_duration_ms: int = 50) -> WavInspectionResult:
    """
    Strictly validates a WAV file beyond mere '> 44 bytes' checks (README Section 3.3 & Invariant I5):
    1. Verifies file exists and RIFF/WAVE magic header is intact.
    2. Parses wave parameters (channels, sample width, sample rate, frame count).
    3. Confirms physical file size covers declared PCM payload bytes (catches truncated writes).
    4. Confirms real decoded duration >= min_duration_ms.
    """
    if not path.is_file():
        return WavInspectionResult(False, 0, 0, 0, 0, 0, "File does not exist")

    try:
        stat_size = path.stat().st_size
        if stat_size <= 44:
            return WavInspectionResult(False, 0, 0, 0, 0, 0, f"File too small ({stat_size} bytes)")

        with path.open("rb") as raw_f:
            header = raw_f.read(12)
            if len(header) < 12:
                return WavInspectionResult(False, 0, 0, 0, 0, 0, "Incomplete RIFF header")
            riff, declared_riff_size, wave_tag = struct.unpack("<4sI4s", header)
            if riff != b"RIFF" or wave_tag != b"WAVE":
                return WavInspectionResult(False, 0, 0, 0, 0, 0, "Invalid RIFF/WAVE magic bytes")
            if stat_size < min(declared_riff_size + 8, 46):
                return WavInspectionResult(False, 0, 0, 0, 0, 0, "Truncated RIFF container")

        with wave.open(str(path), "rb") as wf:
            channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            sample_rate = wf.getframerate()
            num_frames = wf.getnframes()

            if channels < 1 or sample_width < 1 or sample_rate < 8000 or num_frames <= 0:
                return WavInspectionResult(False, 0, sample_rate, channels, sample_width, num_frames, "Invalid PCM parameters")

            expected_pcm_bytes = num_frames * channels * sample_width
            if stat_size < 44 + expected_pcm_bytes:
                return WavInspectionResult(
                    False,
                    0,
                    sample_rate,
                    channels,
                    sample_width,
                    num_frames,
                    f"Truncated PCM frames (have {stat_size}B, need >= {44 + expected_pcm_bytes}B)",
                )

            # Read final frame to guarantee full stream readability
            if num_frames > 1:
                wf.setpos(num_frames - 1)
            last_frame = wf.readframes(1)
            if len(last_frame) != channels * sample_width:
                return WavInspectionResult(False, 0, sample_rate, channels, sample_width, num_frames, "Unreadable trailing frame")

            duration_ms = int(math.ceil((num_frames / float(sample_rate)) * 1000.0))
            if duration_ms < min_duration_ms:
                return WavInspectionResult(
                    False,
                    duration_ms,
                    sample_rate,
                    channels,
                    sample_width,
                    num_frames,
                    f"Audio duration {duration_ms}ms below minimum {min_duration_ms}ms",
                )

            return WavInspectionResult(
                valid=True,
                duration_ms=duration_ms,
                sample_rate=sample_rate,
                channels=channels,
                sample_width_bytes=sample_width,
                num_frames=num_frames,
            )
    except (wave.Error, OSError, EOFError, struct.error) as exc:
        return WavInspectionResult(False, 0, 0, 0, 0, 0, f"WAV decode error: {exc}")
