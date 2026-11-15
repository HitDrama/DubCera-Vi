from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import time
from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse

from . import __version__
from .cache_store import AtomicAudioCacheStore, CachedAudioRecord
from .config import ServiceConfig
from .engines.registry import EngineRegistry
from .schemas import (
    CacheClearResponse,
    CacheVerifyRequest,
    CacheVerifyResponse,
    HealthResponse,
    SynthesizeRequest,
    SynthesizeResponse,
    VerifiedAudioItem,
)
from .security import is_origin_allowed, verify_request_security
from .singleflight import SingleflightGroup


def create_app(custom_config: ServiceConfig | None = None) -> FastAPI:
    config = custom_config or ServiceConfig.from_env()
    cache_store = AtomicAudioCacheStore(
        cache_dir=config.cache_dir,
        max_bytes=config.cache_max_bytes,
        ttl_seconds=config.cache_ttl_seconds,
    )
    registry = EngineRegistry(config=config)
    singleflight = SingleflightGroup[CachedAudioRecord]()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        cache_store.enforce_quota()

        async def _periodic_cache_reaper() -> None:
            while True:
                await asyncio.sleep(600)
                try:
                    await asyncio.to_thread(cache_store.enforce_quota)
                except Exception:
                    pass

        reaper_task = asyncio.create_task(_periodic_cache_reaper())
        try:
            yield
        finally:
            reaper_task.cancel()
            try:
                await reaper_task
            except asyncio.CancelledError:
                pass

    app = FastAPI(
        title="DubCera Local TTS Service",
        version=__version__,
        docs_url="/docs" if config.dev_sandbox_enabled else None,
        redoc_url=None,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def strict_cors_middleware(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method == "OPTIONS":
            if origin and is_origin_allowed(origin, config):
                return Response(
                    status_code=204,
                    headers={
                        "Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, X-DubCera-Token",
                        "Access-Control-Max-Age": "600",
                    },
                )
            return Response(status_code=403, content="Forbidden Origin")

        response = await call_next(request)
        if origin and is_origin_allowed(origin, config):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response

    @app.get("/v1/health", response_model=HealthResponse)
    async def get_health(request: Request) -> HealthResponse:
        origin = request.headers.get("origin")
        if origin and not is_origin_allowed(origin, config):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden Origin")

        return HealthResponse(
            status="ok",
            version=__version__,
            activeProfile=config.hardware_profile,
            safeCpuThreads=config.max_cpu_threads,
            availableEngines=registry.available_engine_ids(),
            availableVoices=registry.list_all_voices(),
        )

    @app.post("/v1/cache/verify", response_model=CacheVerifyResponse)
    async def verify_cache(payload: CacheVerifyRequest, request: Request) -> CacheVerifyResponse:
        verify_request_security(request, config)
        verified_map = cache_store.verify_many(payload.cacheKeys)
        return CacheVerifyResponse(
            validItems={
                key: VerifiedAudioItem(
                    audioCacheKey=rec.cache_key,
                    audioDurationMs=rec.duration_ms,
                    sampleRate=rec.sample_rate,
                    audioUrl=f"/v1/audio/{rec.cache_key}",
                )
                for key, rec in verified_map.items()
            }
        )

    @app.post("/v1/cache/clear", response_model=CacheClearResponse)
    async def clear_cache(request: Request) -> CacheClearResponse:
        verify_request_security(request, config)
        deleted_count, freed_bytes = cache_store.clear_all()
        return CacheClearResponse(deletedCount=deleted_count, freedBytes=freed_bytes)

    @app.post("/v1/synthesize", response_model=SynthesizeResponse)
    async def synthesize_speech(payload: SynthesizeRequest, request: Request) -> SynthesizeResponse:
        verify_request_security(request, config)

        cleaned_text = payload.text.strip()
        if not cleaned_text:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text must not be empty.")
        if len(cleaned_text) > config.max_text_chars:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Text length {len(cleaned_text)} exceeds limit {config.max_text_chars}.",
            )

        t0 = time.perf_counter()
        cache_key = payload.audioCacheKey.lower()

        # 1. Fast disk cache lookup with header + decode verification
        cached = cache_store.get_valid(cache_key)
        if cached is not None:
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            return SynthesizeResponse(
                audioCacheKey=cached.cache_key,
                cacheHit=True,
                audioDurationMs=cached.duration_ms,
                sampleRate=cached.sample_rate,
                engineUsed=cached.engine_id,
                synthesisElapsedMs=elapsed_ms,
                audioUrl=f"/v1/audio/{cached.cache_key}",
            )

        # 2. Singleflight deduplicated synthesis (aborts early if client already closed session/tab)
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="Client disconnected before synthesis")

        async def _produce() -> CachedAudioRecord:
            again = cache_store.get_valid(cache_key)
            if again is not None:
                return again
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client disconnected")
            out = await registry.synthesize(
                engine_id=payload.engineId,
                text=cleaned_text,
                voice_id=payload.voiceId,
                sample_rate=payload.sampleRate,
            )
            return cache_store.put_pcm_samples(
                key=cache_key,
                samples=out.samples,
                sample_rate=out.sample_rate,
                engine_id=out.engine_id,
                voice_id=payload.voiceId,
            )

        record, shared = await singleflight.do(cache_key, _produce)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        return SynthesizeResponse(
            audioCacheKey=record.cache_key,
            cacheHit=shared,
            audioDurationMs=record.duration_ms,
            sampleRate=record.sample_rate,
            engineUsed=record.engine_id,
            synthesisElapsedMs=elapsed_ms,
            audioUrl=f"/v1/audio/{record.cache_key}",
        )

    @app.get("/v1/audio/{audio_cache_key}")
    async def stream_cached_audio(audio_cache_key: str, request: Request):
        verify_request_security(request, config)
        if not audio_cache_key.isalnum():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cache key")

        rec = cache_store.get_valid(audio_cache_key.lower())
        if rec is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio artifact not found or invalid")

        return FileResponse(
            path=rec.wav_path,
            media_type="audio/wav",
            headers={"Cache-Control": "private, max-age=86400"},
        )

    return app


app = create_app()


def run_cli() -> None:
    import uvicorn

    cfg = ServiceConfig.from_env()
    uvicorn.run("dubcera_tts.main:app", host=cfg.host, port=cfg.port, reload=False)


if __name__ == "__main__":
    run_cli()
