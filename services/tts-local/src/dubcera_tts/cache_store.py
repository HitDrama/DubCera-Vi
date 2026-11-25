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
    - Strict 1-day (86,400s) hard TTL from creation time (reads NEVER extend TTL)
    - Strict 5.0 GB hard disk cap across all .wav + .meta.json files (evicts immediately when exceeded)
    """

    def __init__(self, cache_dir: Path, max_bytes: int, ttl_seconds: int = 86_400) -> None:
        self.cache_dir = cache_dir
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_seconds
        self._last_access_map: dict[str, float] = {}
        # Keys belonging to the currently playing video are protected from LRU quota eviction
        self._protected_until_map: dict[str, float] = {}
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # Immediately sweep expired (>1 day) and over-quota (>5 GB) files on startup
        self.enforce_quota()

    def protect_keys(self, keys: list[str], ttl_sec: float = 4 * 3600.0) -> None:
        deadline = time.time() + ttl_sec
        for key in keys:
            if key and key.isalnum():
                self._protected_until_map[key.lower()] = deadline

    def _is_protected(self, clean_key: str, now: float) -> bool:
        until = self._protected_until_map.get(clean_key)
        if until is None:
            return False
        if until <= now:
            self._protected_until_map.pop(clean_key, None)
            return False
        return True

    def _wav_path(self, key: str) -> Path:
        return self.cache_dir / f"{key.lower()}.wav"

    def _meta_path(self, key: str) -> Path:
        return self.cache_dir / f"{key.lower()}.meta.json"

    def _read_meta_dict(self, meta_path: Path) -> dict[str, object]:
        if not meta_path.is_file():
            return {}
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _resolve_created_epoch_sec(self, wav_stat: os.stat_result, meta: dict[str, object]) -> float:
        candidates = [wav_stat.st_mtime, wav_stat.st_ctime]
        raw_created_ms = meta.get("createdAt")
        if isinstance(raw_created_ms, (int, float)) and raw_created_ms > 0:
            candidates.append(float(raw_created_ms) / 1000.0)
        return min(candidates)

    def get_valid(self, key: str) -> CachedAudioRecord | None:
        clean_key = key.lower()
        wav_path = self._wav_path(clean_key)
        meta_path = self._meta_path(clean_key)

        if not wav_path.is_file():
            if meta_path.is_file():
                meta_path.unlink(missing_ok=True)
            return None

        meta = self._read_meta_dict(meta_path)
        now = time.time()
        try:
            st = wav_path.stat()
            created_sec = self._resolve_created_epoch_sec(st, meta)
            if now - created_sec >= self.ttl_seconds:
                self.evict(clean_key)
                return None
        except OSError:
            return None

        inspection = inspect_wav_file(wav_path)
        if not inspection.valid:
            self.evict(clean_key)
            return None

        engine_id = str(meta.get("engineId", "unknown"))
        voice_id = str(meta.get("voiceId", "unknown"))

        # Track LRU access strictly in-memory so file creation/mtime TTL is never artificially extended
        self._last_access_map[clean_key] = now
        self._protected_until_map[clean_key] = now + 4 * 3600.0

        return CachedAudioRecord(
            cache_key=clean_key,
            wav_path=wav_path,
            duration_ms=inspection.duration_ms,
            sample_rate=inspection.sample_rate,
            engine_id=engine_id,
            voice_id=voice_id,
        )

    def verify_many(self, keys: list[str]) -> dict[str, CachedAudioRecord]:
        self.protect_keys(keys)
        self.enforce_quota()
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
        now_sec = time.time()

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
                "createdAt": int(now_sec * 1000),
            }
            tmp_meta.write_text(json.dumps(meta_payload, ensure_ascii=False), encoding="utf-8")

            os.replace(tmp_wav, final_wav)
            os.replace(tmp_meta, final_meta)
            self._last_access_map[clean_key] = now_sec
            self._protected_until_map[clean_key] = now_sec + 4 * 3600.0
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
        self._last_access_map.pop(clean_key, None)
        self._protected_until_map.pop(clean_key, None)
        self._wav_path(clean_key).unlink(missing_ok=True)
        self._meta_path(clean_key).unlink(missing_ok=True)

    def clear_all(self) -> tuple[int, int]:
        """Deletes all cached WAV + metadata artifacts immediately. Returns (deleted_wav_count, freed_bytes)."""
        deleted_wavs = 0
        freed_bytes = 0
        self._last_access_map.clear()
        self._protected_until_map.clear()

        for p in list(self.cache_dir.iterdir()):
            if not p.is_file():
                continue
            if p.name.endswith(".wav") or p.name.endswith(".meta.json"):
                try:
                    size = p.stat().st_size
                    is_final_wav = p.name.endswith(".wav") and not p.name.endswith(".tmp.wav")
                    p.unlink(missing_ok=True)
                    freed_bytes += size
                    if is_final_wav:
                        deleted_wavs += 1
                except OSError:
                    continue

        return deleted_wavs, freed_bytes

    def enforce_quota(self) -> int:
        """
        Strictly deletes:
        1. Stale temporary files (> 5 minutes old) and orphaned .meta.json files.
        2. Every cached entry older than `ttl_seconds` (default 86,400s = 1 day from creation).
        3. Oldest LRU entries immediately whenever total directory size (.wav + .meta.json) > `max_bytes` (default 5.0 GB).
        """
        now = time.time()
        evicted = 0

        # 1. Clean up stale temp files & orphaned metadata
        for item in list(self.cache_dir.iterdir()):
            if not item.is_file():
                continue
            if ".tmp." in item.name:
                try:
                    if now - item.stat().st_mtime > 300:
                        item.unlink(missing_ok=True)
                except OSError:
                    pass
            elif item.name.endswith(".meta.json"):
                stem_key = item.name[: -len(".meta.json")]
                if not (self.cache_dir / f"{stem_key}.wav").is_file():
                    item.unlink(missing_ok=True)

        # 2. Enforce strict 1-day creation TTL & measure exact total bytes (.wav + .meta.json)
        active_entries: list[tuple[float, float, int, str]] = []
        total_bytes = 0

        for wav_file in list(self.cache_dir.glob("*.wav")):
            if wav_file.name.endswith(".tmp.wav"):
                continue
            stem_key = wav_file.stem.lower()
            meta_file = self._meta_path(stem_key)

            try:
                wav_stat = wav_file.stat()
                meta = self._read_meta_dict(meta_file)
                created_sec = self._resolve_created_epoch_sec(wav_stat, meta)

                if now - created_sec >= self.ttl_seconds:
                    self.evict(stem_key)
                    evicted += 1
                    continue

                entry_bytes = wav_stat.st_size
                if meta_file.is_file():
                    try:
                        entry_bytes += meta_file.stat().st_size
                    except OSError:
                        pass

                last_access_sec = self._last_access_map.get(stem_key, created_sec)
                total_bytes += entry_bytes
                active_entries.append((last_access_sec, created_sec, entry_bytes, stem_key))
            except OSError:
                continue

        # 3. Hard 5 GB cap:
        #    Pass 1: evict oldest UNPROTECTED entries first so the currently playing video is spared.
        #    Pass 2: only if still over hard cap after all other videos are evicted, evict oldest protected entries.
        if total_bytes <= self.max_bytes:
            return evicted

        unprotected = [e for e in active_entries if not self._is_protected(e[3], now)]
        protected = [e for e in active_entries if self._is_protected(e[3], now)]

        unprotected.sort(key=lambda entry: (entry[0], entry[1]))
        for _, _, entry_bytes, stem_key in unprotected:
            if total_bytes <= self.max_bytes:
                break
            self.evict(stem_key)
            total_bytes -= entry_bytes
            evicted += 1

        if total_bytes > self.max_bytes:
            protected.sort(key=lambda entry: (entry[0], entry[1]))
            for _, _, entry_bytes, stem_key in protected:
                if total_bytes <= self.max_bytes:
                    break
                self.evict(stem_key)
                total_bytes -= entry_bytes
                evicted += 1

        return evicted
