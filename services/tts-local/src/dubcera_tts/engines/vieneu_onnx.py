from __future__ import annotations

import asyncio
import importlib.util
import tempfile
import wave
from pathlib import Path

import numpy as np

from ..schemas import VoiceInfo
from .base import SynthesisOutput, TTSEngine


class VieNeuOnnxEngine(TTSEngine):
    """
    Official VieNeu-TTS v3 adapter supporting:
    - `mode="v3turbo"` (48kHz, strong En-Vi code-switching for Unity/coding tutorials, CUDA or ONNX INT8/FP32)
    - `mode="v3nano"` (24kHz, 48M ultra-light flow model specifically built for CPU Eco / weak laptops)
    """

    def __init__(self, max_cpu_threads: int, mode: str = "v3turbo", precision: str = "int8") -> None:
        self._max_cpu_threads = max_cpu_threads
        self._mode = mode  # "v3turbo" or "v3nano"
        self._precision = precision
        self._instance = None
        self._init_lock = asyncio.Lock()
        self._infer_lock = asyncio.Lock()

    @property
    def engine_id(self) -> str:
        return "vieneu-nano" if self._mode == "v3nano" else "vieneu-onnx"

    def is_available(self) -> bool:
        return importlib.util.find_spec("vieneu") is not None

    def list_voices(self) -> list[VoiceInfo]:
        if not self.is_available():
            return []
        if self._mode == "v3nano":
            return [
                VoiceInfo(
                    voiceId="Hải Đăng",
                    displayName="VieNeu Nano - Hải Đăng (CPU Eco · Nhẹ & Nhanh)",
                    engineId=self.engine_id,
                    sampleRate=24000,
                    tier="local_eco",
                ),
                VoiceInfo(
                    voiceId="Trúc Ly",
                    displayName="VieNeu Nano - Trúc Ly (CPU Eco · Nữ Bắc)",
                    engineId=self.engine_id,
                    sampleRate=24000,
                    tier="local_eco",
                ),
            ]

        return [
            VoiceInfo(
                voiceId="Hải Đăng",
                displayName="VieNeu v3 Turbo - Hải Đăng (48kHz · Chuẩn Anh-Việt)",
                engineId=self.engine_id,
                sampleRate=48000,
                tier="local_high",
            ),
            VoiceInfo(
                voiceId="Trúc Ly",
                displayName="VieNeu v3 Turbo - Trúc Ly (48kHz · Nữ Bắc tự nhiên)",
                engineId=self.engine_id,
                sampleRate=48000,
                tier="local_high",
            ),
            VoiceInfo(
                voiceId="Thiện Minh",
                displayName="VieNeu v3 Turbo - Thiện Minh (48kHz · Kể chuyện/Bài giảng)",
                engineId=self.engine_id,
                sampleRate=48000,
                tier="local_high",
            ),
            VoiceInfo(
                voiceId="Thùy Dung",
                displayName="VieNeu v3 Turbo - Thùy Dung (48kHz · Nữ miền Nam)",
                engineId=self.engine_id,
                sampleRate=48000,
                tier="local_high",
            ),
        ]

    async def _ensure_loaded(self):
        if self._instance is not None:
            return self._instance
        async with self._init_lock:
            if self._instance is not None:
                return self._instance

            def _load():
                from vieneu import Vieneu  # type: ignore

                if self._mode == "v3nano":
                    return Vieneu(mode="v3nano", threads=self._max_cpu_threads)

                try:
                    return Vieneu(
                        mode="v3turbo",
                        precision=self._precision,
                        threads=self._max_cpu_threads,
                    )
                except Exception:
                    return Vieneu(mode="v3turbo", threads=self._max_cpu_threads)

            self._instance = await asyncio.to_thread(_load)
            return self._instance

    async def synthesize(self, text: str, voice_id: str, sample_rate: int = 48000) -> SynthesisOutput:
        tts = await self._ensure_loaded()
        native_sr = int(getattr(tts, "sample_rate", 24000 if self._mode == "v3nano" else 48000))

        async with self._infer_lock:
            def _run_sync() -> tuple[np.ndarray, int]:
                voice_arg = None if voice_id in ("", "default", "vieneu-default") else voice_id
                try:
                    if voice_arg:
                        audio_obj = tts.infer(text=text, voice=voice_arg)
                    else:
                        audio_obj = tts.infer(text=text)
                except Exception:
                    audio_obj = tts.infer(text=text)

                if isinstance(audio_obj, np.ndarray):
                    return audio_obj.astype(np.float32), native_sr

                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_path = Path(tmp.name)
                try:
                    tts.save(audio_obj, str(tmp_path))
                    with wave.open(str(tmp_path), "rb") as wf:
                        sr = wf.getframerate()
                        n_channels = wf.getnchannels()
                        sampwidth = wf.getsampwidth()
                        raw = wf.readframes(wf.getnframes())
                    if sampwidth == 2:
                        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    elif sampwidth == 4:
                        arr = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
                    else:
                        arr = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
                    if n_channels > 1:
                        arr = arr.reshape(-1, n_channels).mean(axis=-1)
                    return arr, sr
                finally:
                    tmp_path.unlink(missing_ok=True)

            samples, detected_sr = await asyncio.to_thread(_run_sync)
            return SynthesisOutput(samples=samples, sample_rate=detected_sr, engine_id=self.engine_id)
