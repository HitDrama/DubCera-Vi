from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np

from ..schemas import VoiceInfo


@dataclass(frozen=True)
class SynthesisOutput:
    samples: np.ndarray
    sample_rate: int
    engine_id: str


class TTSEngine(ABC):
    @property
    @abstractmethod
    def engine_id(self) -> str: ...

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def list_voices(self) -> list[VoiceInfo]: ...

    @abstractmethod
    async def synthesize(self, text: str, voice_id: str, sample_rate: int) -> SynthesisOutput: ...
