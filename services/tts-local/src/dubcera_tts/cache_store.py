from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .audio_validator import inspect_wav_file, write_pcm16_wav


@dataclass(frozen=True)
class CachedAudioRecord:
    cache_key: str
    wav_path: Path
    duration_ms: int
    sample_rate: int
    engine_id: str
    voice_id: str


class AtomicAudioCacheStore:
    """
    Manages SHA-256 keyed 1.0x original WAV artifacts on local disk:
    - Atomic writes (.tmp.wav -> os.replace -> .wav + .meta.json)
    - Strict header & decode verification on lookup (automatically evicts corrupt files)
    - LRU disk quota enforcement so long 120-minute courses never fill disk unboundedly
    """

    def __init__(self, cache_dir: Path, max_bytes: int) -> None:
        self.cache_dir = cache_dir
        self.max_bytes = max_bytes
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _wav_path(self, key: str) -> Path:
        return self.cache_dir / f"{key.lower()}.wav"

    def _meta_path(self, key: str) -> Path:
        return self.cache_dir / f"{key.lower()}.meta.json"

    def get_valid(self, key: str) -> CachedAudioRecord | None:
        clean_key = key.lower()
        wav_path = self._wav_path(clean_key)
        meta_path = self._meta_path(clean_key)

        if not wav_path.is_file():
            return None

        inspection = inspect_wav_file(wav_path)
        if not inspection.valid:
            self.evict(clean_key)
            return None

        engine_id = "unknown"
        voice_id = "unknown"
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                engine_id = str(meta.get("engineId", "unknown"))
                voice_id = str(meta.get("voiceId", "unknown"))
            except (OSError, ValueError):
                pass

        # Touch mtime for LRU tracking (best-effort)
        try:
            now = time.time()
            os.utime(wav_path, (now, now))
        except OSError:
            pass

        return CachedAudioRecord(
            cache_key=clean_key,
            wav_path=wav_path,
            duration_ms=inspection.duration_ms,
            sample_rate=inspection.sample_rate,
            engine_id=engine_id,
            voice_id=voice_id,
        )

    def verify_many(self, keys: list[str]) -> dict[str, CachedAudioRecord]:
        valid: dict[str, CachedAudioRecord] = {}
        for key in keys:
            if not key or not key.isalnum():
                continue
            rec = self.get_valid(key)
            if rec is not None:
                valid[key.lower()] = rec
        return valid

    def put_pcm_samples(
        self,
        key: str,
        samples: np.ndarray,
        sample_rate: int,
        engine_id: str,
        voice_id: str,
    ) -> CachedAudioRecord:
        clean_key = key.lower()
        tmp_id = uuid.uuid4().hex[:10]
        tmp_wav = self.cache_dir / f"{clean_key}.{tmp_id}.tmp.wav"
        tmp_meta = self.cache_dir / f"{clean_key}.{tmp_id}.tmp.meta.json"
        final_wav = self._wav_path(clean_key)
        final_meta = self._meta_path(clean_key)

        try:
            write_pcm16_wav(tmp_wav, samples, sample_rate)
            inspection = inspect_wav_file(tmp_wav)
            if not inspection.valid:
                raise RuntimeError(f"Synthesized audio failed integrity check: {inspection.reason}")

            meta_payload = {
                "audioCacheKey": clean_key,
                "durationMs": inspection.duration_ms,
                "sampleRate": inspection.sample_rate,
                "engineId": engine_id,
                "voiceId": voice_id,
                "createdAt": int(time.time() * 1000),
            }
            tmp_meta.write_text(json.dumps(meta_payload, ensure_ascii=False), encoding="utf-8")

            os.replace(tmp_wav, final_wav)
            os.replace(tmp_meta, final_meta)
        finally:
            if tmp_wav.exists():
                tmp_wav.unlink(missing_ok=True)
            if tmp_meta.exists():
                tmp_meta.unlink(missing_ok=True)

        self.enforce_quota()

        return CachedAudioRecord(
            cache_key=clean_key,
            wav_path=final_wav,
            duration_ms=inspection.duration_ms,
            sample_rate=inspection.sample_rate,
            engine_id=engine_id,
            voice_id=voice_id,
        )

    def evict(self, key: str) -> None:
        clean_key = key.lower()
        self._wav_path(clean_key).unlink(missing_ok=True)
        self._meta_path(clean_key).unlink(missing_ok=True)

    def enforce_quota(self) -> int:
        """Evicts oldest-accessed WAV artifacts if total cache size exceeds max_bytes."""
        wav_files = []
        total_bytes = 0
        for p in self.cache_dir.glob("*.wav"):
            if p.name.endswith(".tmp.wav"):
                continue
            try:
                st = p.stat()
                total_bytes += st.st_size
                wav_files.append((st.st_mtime, st.st_size, p.stem))
            except OSError:
                continue

        if total_bytes <= self.max_bytes:
            return 0

        wav_files.sort(key=lambda item: item[0])  # Oldest mtime first
        evicted = 0
        for _, size, stem in wav_files:
            if total_bytes <= self.max_bytes:
                break
            self.evict(stem)
            total_bytes -= size
            evicted += 1
        return evicted
