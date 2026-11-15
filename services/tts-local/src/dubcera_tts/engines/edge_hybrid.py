from __future__ import annotations

import importlib.util

import miniaudio
import numpy as np

from ..schemas import VoiceInfo
from .base import SynthesisOutput, TTSEngine


class EdgeHybridEngine(TTSEngine):
    """
    Optional zero-CPU hybrid TTS provider using Microsoft Edge Neural voices (`vi-VN-HoaiMyNeural`, `vi-VN-NamMinhNeural`).
    Decodes streamed MP3 bytes in-memory via `miniaudio` straight into canonical 24kHz PCM16 WAV so
    local caching, RIFF validation, and exact duration measurement work identically to local ONNX models.
    """

    @property
    def engine_id(self) -> str:
        return "edge-hybrid"

    def is_available(self) -> bool:
        return importlib.util.find_spec("edge_tts") is not None

    def list_voices(self) -> list[VoiceInfo]:
        if not self.is_available():
            return []
        return [
            VoiceInfo(
                voiceId="vi-VN-NamMinhNeural",
                displayName="Nam Minh Neural (0% tải CPU - Siêu nhanh)",
                engineId=self.engine_id,
                sampleRate=24000,
                tier="hybrid_cloud",
            ),
            VoiceInfo(
                voiceId="vi-VN-HoaiMyNeural",
                displayName="Hoài My Neural (0% tải CPU - Siêu nhanh)",
                engineId=self.engine_id,
                sampleRate=24000,
                tier="hybrid_cloud",
            ),
        ]

    async def synthesize(self, text: str, voice_id: str, sample_rate: int = 24000) -> SynthesisOutput:
        import edge_tts

        selected_voice = voice_id if voice_id in ("vi-VN-NamMinhNeural", "vi-VN-HoaiMyNeural") else "vi-VN-NamMinhNeural"
        communicate = edge_tts.Communicate(text=text, voice=selected_voice)

        mp3_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                mp3_chunks.append(chunk["data"])

        if not mp3_chunks:
            raise RuntimeError("Edge-TTS returned empty audio stream")

        mp3_bytes = b"".join(mp3_chunks)
        target_sr = max(16000, int(sample_rate or 24000))
        decoded = miniaudio.decode(
            mp3_bytes,
            output_format=miniaudio.SampleFormat.SIGNED16,
            nchannels=1,
            sample_rate=target_sr,
        )
        samples = np.frombuffer(decoded.samples, dtype=np.int16).astype(np.float32) / 32768.0
        return SynthesisOutput(samples=samples, sample_rate=decoded.sample_rate, engine_id=self.engine_id)
