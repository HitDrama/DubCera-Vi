from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def compute_safe_cpu_threads() -> int:
    logical = os.cpu_count() or 4
    # Match physical core count (~logical // 2 on SMT CPUs like 4C/8T i3-12100F) so browser & OS stay responsive
    if logical <= 2:
        return 1
    if logical <= 4:
        return max(2, logical - 1)
    return min(6, max(2, logical // 2))


@dataclass(frozen=True)
class ServiceConfig:
    host: str
    port: int
    auth_token: str
    dev_sandbox_enabled: bool
    allowed_extension_ids: tuple[str, ...]
    cache_dir: Path
    models_dir: Path
    cache_max_bytes: int
    cache_ttl_seconds: int
    max_text_chars: int
    max_cpu_threads: int
    hardware_profile: str  # "auto" | "gpu_turbo" | "cpu_eco" | "cloud_hybrid"

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> ServiceConfig:
        root = base_dir or Path(__file__).resolve().parents[2]
        host = os.getenv("DUBCERA_HOST", "127.0.0.1").strip()
        # Hard invariant: strictly loopback only
        if host not in ("127.0.0.1", "localhost"):
            raise ValueError(f"Refusing non-loopback bind host '{host}'. Must be 127.0.0.1.")

        port = int(os.getenv("DUBCERA_PORT", "8765"))
        auth_token = os.getenv("DUBCERA_TOKEN", "dubcera-local-dev-token").strip()
        if len(auth_token) < 8:
            raise ValueError("DUBCERA_TOKEN must be at least 8 characters long.")

        dev_sandbox = os.getenv("DUBCERA_DEV_SANDBOX", "1").strip() in ("1", "true", "yes")
        raw_ext_ids = os.getenv("DUBCERA_ALLOWED_EXTENSION_IDS", "").strip()
        ext_ids = tuple(x.strip() for x in raw_ext_ids.split(",") if x.strip())

        cache_dir = Path(os.getenv("DUBCERA_CACHE_DIR", str(root / "cache")))
        models_dir = Path(os.getenv("DUBCERA_MODELS_DIR", str(root / "models")))
        cache_max_gb = float(os.getenv("DUBCERA_CACHE_MAX_GB", "5.0"))
        cache_ttl_hours = float(os.getenv("DUBCERA_CACHE_TTL_HOURS", "24.0"))
        max_text_chars = int(os.getenv("DUBCERA_MAX_TEXT_CHARS", "1000"))
        hardware_profile = os.getenv("DUBCERA_HARDWARE_PROFILE", "auto").strip().lower()

        return cls(
            host="127.0.0.1",
            port=port,
            auth_token=auth_token,
            dev_sandbox_enabled=dev_sandbox,
            allowed_extension_ids=ext_ids,
            cache_dir=cache_dir,
            models_dir=models_dir,
            cache_max_bytes=int(cache_max_gb * (1024**3)),
            cache_ttl_seconds=max(60, int(cache_ttl_hours * 3600)),
            max_text_chars=max_text_chars,
            max_cpu_threads=compute_safe_cpu_threads(),
            hardware_profile=hardware_profile,
        )
