from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from dubcera_tts.audio_validator import inspect_wav_file
from dubcera_tts.config import ServiceConfig
from dubcera_tts.main import create_app


def make_test_config(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        host="127.0.0.1",
        port=8765,
        auth_token="test-secret-token-12345",
        dev_sandbox_enabled=True,
        allowed_extension_ids=("abcdefghijklmnopabcdefghijklmnop",),
        cache_dir=tmp_path / "cache",
        models_dir=tmp_path / "models",
        cache_max_bytes=10 * 1024 * 1024,
        max_text_chars=300,
        max_cpu_threads=2,
        hardware_profile="auto",
    )


@pytest.mark.asyncio
async def test_security_blocks_unauthorized_origin_and_missing_token(tmp_path: Path) -> None:
    cfg = make_test_config(tmp_path)
    app = create_app(cfg)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        # 1. Evil website origin must be blocked with 403
        evil_resp = await client.post(
            "/v1/cache/verify",
            json={"cacheKeys": []},
            headers={
                "Origin": "https://malicious-site.example.com",
                "X-DubCera-Token": cfg.auth_token,
            },
        )
        assert evil_resp.status_code == 403

        # 2. Allowed extension origin WITHOUT token must be blocked with 401
        no_tok_resp = await client.post(
            "/v1/cache/verify",
            json={"cacheKeys": []},
            headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"},
        )
        assert no_tok_resp.status_code == 401


@pytest.mark.asyncio
async def test_atomic_synthesis_cache_verify_and_corrupt_wav_eviction(tmp_path: Path) -> None:
    cfg = make_test_config(tmp_path)
    app = create_app(cfg)
    headers = {
        "Origin": "http://localhost:3000",
        "X-DubCera-Token": cfg.auth_token,
    }
    key = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        # Synthesize fresh WAV
        resp1 = await client.post(
            "/v1/synthesize",
            headers=headers,
            json={
                "audioCacheKey": key,
                "text": "Đầu tiên chúng ta tạo một GameObject mới trong Unity.",
                "voiceId": "mock-vi-cadence",
                "engineId": "mock-tone",
                "sampleRate": 24000,
            },
        )
        assert resp1.status_code == 200
        body1 = resp1.json()
        assert body1["cacheHit"] is False
        assert body1["audioDurationMs"] >= 1500

        # Second call hits validated disk cache immediately
        resp2 = await client.post(
            "/v1/synthesize",
            headers=headers,
            json={
                "audioCacheKey": key,
                "text": "Đầu tiên chúng ta tạo một GameObject mới trong Unity.",
                "voiceId": "mock-vi-cadence",
                "engineId": "mock-tone",
                "sampleRate": 24000,
            },
        )
        assert resp2.status_code == 200
        assert resp2.json()["cacheHit"] is True

        # Stream audio bytes and confirm valid RIFF header
        audio_resp = await client.get(f"/v1/audio/{key}", headers=headers)
        assert audio_resp.status_code == 200
        assert audio_resp.content[:4] == b"RIFF"

        # Corrupt the WAV file to 50 garbage bytes (> 44 bytes check in README Section 3.3!)
        corrupt_path = cfg.cache_dir / f"{key}.wav"
        corrupt_path.write_bytes(b"X" * 64)
        assert inspect_wav_file(corrupt_path).valid is False

        # /v1/cache/verify MUST reject & evict the corrupted file instead of reporting READY
        verify_resp = await client.post(
            "/v1/cache/verify",
            headers=headers,
            json={"cacheKeys": [key]},
        )
        assert verify_resp.status_code == 200
        assert key not in verify_resp.json()["validItems"]
        assert not corrupt_path.exists()


@pytest.mark.asyncio
async def test_singleflight_deduplicates_concurrent_identical_keys(tmp_path: Path) -> None:
    cfg = make_test_config(tmp_path)
    app = create_app(cfg)
    headers = {"X-DubCera-Token": cfg.auth_token}
    shared_key = "ff00112233445566778899aabbccddeeff001122"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765") as client:
        tasks = [
            client.post(
                "/v1/synthesize",
                headers=headers,
                json={
                    "audioCacheKey": shared_key,
                    "text": "Kiểm tra năm luồng gọi trùng khóa cache cùng một thời điểm.",
                    "voiceId": "mock-vi-cadence",
                    "engineId": "mock-tone",
                    "sampleRate": 24000,
                },
            )
            for _ in range(5)
        ]
        responses = await asyncio.gather(*tasks)
        for r in responses:
            assert r.status_code == 200
            assert r.json()["audioDurationMs"] > 1000
        # Exactly 1 leader had cacheHit=False, the followers either joined singleflight or hit cache
        leaders = [r for r in responses if r.json()["cacheHit"] is False]
        assert len(leaders) == 1
