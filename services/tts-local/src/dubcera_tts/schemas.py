from __future__ import annotations

from pydantic import BaseModel, Field


class VoiceInfo(BaseModel):
    voiceId: str
    displayName: str
    engineId: str
    sampleRate: int
    tier: str  # "local_high" | "local_eco" | "hybrid_cloud" | "mock"


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    activeProfile: str
    safeCpuThreads: int
    availableEngines: list[str]
    availableVoices: list[VoiceInfo]


class CacheVerifyRequest(BaseModel):
    cacheKeys: list[str] = Field(default_factory=list, max_length=2500)


class VerifiedAudioItem(BaseModel):
    audioCacheKey: str
    audioDurationMs: int
    sampleRate: int
    audioUrl: str


class CacheVerifyResponse(BaseModel):
    validItems: dict[str, VerifiedAudioItem]


class CacheClearResponse(BaseModel):
    deletedCount: int
    freedBytes: int


class SynthesizeRequest(BaseModel):
    audioCacheKey: str = Field(min_length=16, max_length=128, pattern=r"^[a-fA-F0-9]+$")
    text: str = Field(min_length=1, max_length=2000)
    targetLang: str = "vi"
    voiceId: str
    engineId: str
    modelVersion: str = "v1"
    sampleRate: int = 24000
    styleOrPitchConfig: str = "default"
    pauseConfig: str = "default"


class SynthesizeResponse(BaseModel):
    audioCacheKey: str
    cacheHit: bool
    audioDurationMs: int
    sampleRate: int
    engineUsed: str
    synthesisElapsedMs: int
    audioUrl: str
