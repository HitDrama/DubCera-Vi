from __future__ import annotations

import numpy as np

from ..schemas import VoiceInfo
from .base import SynthesisOutput, TTSEngine


class DeterministicToneEngine(TTSEngine):
    """
    Fast, zero-network, deterministic syllabic tone generator (~210ms per Vietnamese syllable/word).
    Used for automated integration tests and instant sandbox verification when offline without weights.
    """

    @property
    def engine_id(self) -> str:
        return "mock-tone"

    def is_available(self) -> bool:
        return True

    def list_voices(self) -> list[VoiceInfo]:
        return [
            VoiceInfo(
                voiceId="mock-vi-cadence",
                displayName="DubCera Test Tone (Offline Dev)",
                engineId=self.engine_id,
                sampleRate=24000,
                tier="mock",
            )
        ]

    async def synthesize(self, text: str, voice_id: str, sample_rate: int = 24000) -> SynthesisOutput:
        sr = max(16000, int(sample_rate or 24000))
        words = [w for w in text.strip().split() if w]
        word_count = max(1, len(words))

        # Approximate natural Vietnamese speaking cadence (~4.4 syllables/sec => ~225ms/word)
        duration_sec = max(0.35, word_count * 0.22)
        total_samples = int(sr * duration_sec)
        t = np.linspace(0.0, duration_sec, total_samples, endpoint=False, dtype=np.float32)

        # Gentle fundamental voice-band envelope with syllable modulation so ear hears clear cadence
        base_freq = 185.0 if "nam" in voice_id.lower() else 230.0
        syllable_env = 0.55 + 0.45 * np.sin(2.0 * np.pi * 4.4 * t)
        carrier = 0.22 * np.sin(2.0 * np.pi * base_freq * t) + 0.08 * np.sin(2.0 * np.pi * (base_freq * 2.0) * t)
        samples = (carrier * syllable_env).astype(np.float32)

        # Smooth 15ms fade-in / fade-out to prevent audio clicks
        fade_len = min(int(sr * 0.015), total_samples // 4)
        if fade_len > 0:
            fade = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
            samples[:fade_len] *= fade
            samples[-fade_len:] *= fade[::-1]

        return SynthesisOutput(samples=samples, sample_rate=sr, engine_id=self.engine_id)
