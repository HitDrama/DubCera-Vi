from __future__ import annotations

from ..config import ServiceConfig
from ..schemas import VoiceInfo
from .base import SynthesisOutput, TTSEngine
from .edge_hybrid import EdgeHybridEngine
from .mock_tone import DeterministicToneEngine
from .sherpa_piper import SherpaPiperEngine
from .vieneu_onnx import VieNeuOnnxEngine


class EngineRegistry:
    def __init__(self, config: ServiceConfig) -> None:
        self._config = config
        self._engines: dict[str, TTSEngine] = {}

        candidates: list[TTSEngine] = [
            VieNeuOnnxEngine(max_cpu_threads=config.max_cpu_threads, mode="v3turbo", precision="int8"),
            VieNeuOnnxEngine(max_cpu_threads=config.max_cpu_threads, mode="v3nano"),
            SherpaPiperEngine(models_dir=config.models_dir, max_cpu_threads=config.max_cpu_threads, execution_provider="cpu"),
            SherpaPiperEngine(models_dir=config.models_dir, max_cpu_threads=config.max_cpu_threads, execution_provider="directml"),
            EdgeHybridEngine(),
            DeterministicToneEngine(),
        ]
        for eng in candidates:
            if eng.is_available():
                self._engines[eng.engine_id] = eng

    def available_engine_ids(self) -> list[str]:
        return list(self._engines.keys())

    def list_all_voices(self) -> list[VoiceInfo]:
        voices: list[VoiceInfo] = []
        for eng in self._engines.values():
            voices.extend(eng.list_voices())
        return voices

    def resolve_engine(self, requested_engine_id: str) -> TTSEngine:
        if requested_engine_id in self._engines:
            return self._engines[requested_engine_id]
        for fallback_id in ("vieneu-onnx", "vieneu-nano", "piper-vi-eco", "edge-hybrid", "mock-tone"):
            if fallback_id in self._engines:
                return self._engines[fallback_id]
        raise RuntimeError("No TTS engine available")

    async def synthesize(self, engine_id: str, text: str, voice_id: str, sample_rate: int) -> SynthesisOutput:
        engine = self.resolve_engine(engine_id)
        return await engine.synthesize(text=text, voice_id=voice_id, sample_rate=sample_rate)

    async def unload_idle_models(self, max_idle_seconds: float = 60.0) -> int:
        unloaded = 0
        for eng in self._engines.values():
            if await eng.unload_if_idle(max_idle_seconds):
                unloaded += 1
        return unloaded
