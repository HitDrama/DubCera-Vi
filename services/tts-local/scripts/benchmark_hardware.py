from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path

from dubcera_tts.audio_validator import inspect_wav_file, write_pcm16_wav
from dubcera_tts.config import ServiceConfig
from dubcera_tts.engines.registry import EngineRegistry

BENCHMARK_SENTENCES = [
    "Xin chào các bạn, chào mừng đến với khóa học lập trình game trong Unity.",
    "Đầu tiên, chúng ta cần tạo một GameObject mới trong cửa sổ Hierarchy và đặt tên cho nó là Player.",
    "Tiếp theo, hãy gắn thành phần Rigidbody2D và BoxCollider2D để nhân vật có thể tương tác vật lý chính xác.",
    "Lưu ý rằng các phép tính vật lý nên được đặt bên trong hàm FixedUpdate thay vì hàm Update thông thường.",
    "Khi hai vật thể chạm nhau, sự kiện OnCollisionEnter hoặc OnTriggerEnter sẽ tự động được kích hoạt.",
    "Chúng ta có thể dùng SerializeField để chỉnh sửa tốc độ di chuyển trực tiếp ngay trên thanh Inspector.",
    "Để tối ưu hiệu năng cho cảnh lớn, bạn nên tái sử dụng Prefab thông qua kỹ thuật Object Pooling.",
    "Bây giờ hãy mở Shader Graph để tạo hiệu ứng phát sáng mượt mà cho Particle System của vũ khí.",
]


async def benchmark_engine(registry: EngineRegistry, engine_id: str, voice_id: str, out_dir: Path) -> None:
    print(f"\n=== Benchmarking Engine: {engine_id} | Voice: {voice_id} ===")
    out_dir.mkdir(parents=True, exist_ok=True)

    # Warmup call
    t_warm = time.perf_counter()
    warm_out = await registry.synthesize(engine_id, "Kiểm tra khởi động hệ thống.", voice_id, 24000)
    warmup_ms = (time.perf_counter() - t_warm) * 1000.0
    print(f"Warmup latency: {warmup_ms:.1f} ms (Sample rate: {warm_out.sample_rate} Hz)")

    total_synth_sec = 0.0
    total_audio_sec = 0.0
    first_sentence_ms = 0.0

    for idx, sentence in enumerate(BENCHMARK_SENTENCES):
        t0 = time.perf_counter()
        result = await registry.synthesize(engine_id, sentence, voice_id, warm_out.sample_rate)
        elapsed_sec = time.perf_counter() - t0

        if idx == 0:
            first_sentence_ms = elapsed_sec * 1000.0

        digest = hashlib.sha256(f"{engine_id}:{voice_id}:{sentence}".encode("utf-8")).hexdigest()[:12]
        wav_path = out_dir / f"sample_{engine_id}_{idx:02d}_{digest}.wav"
        write_pcm16_wav(wav_path, result.samples, result.sample_rate)
        inspection = inspect_wav_file(wav_path)
        if not inspection.valid:
            raise RuntimeError(f"Invalid benchmark WAV generated: {inspection.reason}")

        audio_sec = inspection.duration_ms / 1000.0
        total_synth_sec += elapsed_sec
        total_audio_sec += audio_sec
        print(
            f"  [{idx + 1:02d}/{len(BENCHMARK_SENTENCES)}] "
            f"gen={elapsed_sec * 1000.0:6.1f}ms | audio={audio_sec:5.2f}s | RTF={elapsed_sec / audio_sec:.3f}x"
        )

    avg_rtf = total_synth_sec / max(0.001, total_audio_sec)
    est_60min_video_min = (45.0 * avg_rtf)  # ~45 minutes of active speech in a 60-min lecture
    print(f"--> Summary [{engine_id}]:")
    print(f"    First-Sentence Latency : {first_sentence_ms:.1f} ms")
    print(f"    Total Audio Generated  : {total_audio_sec:.2f} s in {total_synth_sec:.2f} s")
    print(f"    Measured Average RTF   : {avg_rtf:.3f}x ({1.0 / max(1e-6, avg_rtf):.1f}x faster than real-time)")
    print(f"    Est. 60-min Video Batch: ~{est_60min_video_min:.1f} minutes (sequential 1-worker)")


async def main() -> None:
    cfg = ServiceConfig.from_env()
    registry = EngineRegistry(cfg)
    bench_dir = cfg.cache_dir / "benchmark_samples"

    print(f"Safe CPU Threads configured: {cfg.max_cpu_threads}")
    print(f"Detected Available Engines : {registry.available_engine_ids()}")

    seen_engines: set[str] = set()
    for voice in registry.list_all_voices():
        if voice.engineId in seen_engines or voice.engineId == "edge-hybrid":
            continue
        seen_engines.add(voice.engineId)
        try:
            await benchmark_engine(registry, voice.engineId, voice.voiceId, bench_dir)
        except Exception as exc:
            print(f"  [!] Skipped {voice.engineId} ({voice.voiceId}): {exc}")


if __name__ == "__main__":
    asyncio.run(main())
