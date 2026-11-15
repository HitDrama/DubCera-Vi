from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import numpy as np

from ..schemas import VoiceInfo
from .base import SynthesisOutput, TTSEngine


class SherpaPiperEngine(TTSEngine):
    """
    Lightweight local VITS/Piper ONNX engine via `sherpa-onnx` for:
    - `CPU Eco` mode (low-spec CPU-only laptops, RTF ~0.05x)
    - Experimental `DirectML` GPU mode on Windows (e.g. AMD Radeon RX 6800 XT) when `provider="directml"`
    """

    def __init__(self, models_dir: Path, max_cpu_threads: int, execution_provider: str = "cpu") -> None:
        self._models_dir = models_dir / "piper-vi"
        self._max_cpu_threads = max_cpu_threads
        self._provider = execution_provider  # "cpu" or "directml"
        self._tts = None
        self._lock = asyncio.Lock()

    @property
    def engine_id(self) -> str:
        return "piper-dml" if self._provider == "directml" else "piper-vi-eco"

    def _find_model_bundle(self) -> tuple[Path, Path, Path] | None:
        if not self._models_dir.is_dir():
            return None
        onnx_files = [p for p in self._models_dir.glob("*.onnx")]
        tokens_file = self._models_dir / "tokens.txt"
        espeak_dir = self._models_dir / "espeak-ng-data"
        if onnx_files and tokens_file.is_file() and espeak_dir.is_dir():
            return onnx_files[0], tokens_file, espeak_dir
        return None

    def is_available(self) -> bool:
        return importlib.util.find_spec("sherpa_onnx") is not None and self._find_model_bundle() is not None

    def list_voices(self) -> list[VoiceInfo]:
        if not self.is_available():
            return []
        tier = "local_high" if self._provider == "directml" else "local_eco"
        label_suffix = "DirectML GPU" if self._provider == "directml" else "CPU Eco Siêu nhẹ"
        return [
            VoiceInfo(
                voiceId=f"{self.engine_id}-default",
                displayName=f"Piper Tiếng Việt ({label_suffix})",
                engineId=self.engine_id,
                sampleRate=22050,
                tier=tier,
            )
        ]

    async def _ensure_loaded(self):
        if self._tts is not None:
            return self._tts
        async with self._lock:
            if self._tts is not None:
                return self._tts
            bundle = self._find_model_bundle()
            if bundle is None:
                raise RuntimeError(f"Piper Vietnamese ONNX bundle not found in {self._models_dir}")
            onnx_path, tokens_path, espeak_dir = bundle

            def _load():
                import sherpa_onnx  # type: ignore

                cfg = sherpa_onnx.OfflineTtsConfig(
                    model=sherpa_onnx.OfflineTtsModelConfig(
                        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                            model=str(onnx_path),
                            tokens=str(tokens_path),
                            data_dir=str(espeak_dir),
                        ),
                        provider=self._provider,
                        num_threads=1 if self._provider == "directml" else self._max_cpu_threads,
                    )
                )
                return sherpa_onnx.OfflineTts(cfg)

            self._tts = await asyncio.to_thread(_load)
            return self._tts

    async def synthesize(self, text: str, voice_id: str, sample_rate: int = 22050) -> SynthesisOutput:
        tts = await self._ensure_loaded()
        # Note: ONNX Runtime DirectML requires serialized Run() per session
        async with self._lock:
            def _gen() -> tuple[np.ndarray, int]:
                audio = tts.generate(text, sid=0, speed=1.0)
                arr = np.asarray(audio.samples, dtype=np.float32)
                return arr, int(audio.sample_rate)

            samples, sr = await asyncio.to_thread(_gen)
            return SynthesisOutput(samples=samples, sample_rate=sr, engine_id=self.engine_id)
