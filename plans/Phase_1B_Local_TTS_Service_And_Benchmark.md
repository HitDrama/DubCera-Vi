# Phase 1B — Local TTS Service, Bảo Mật Loopback & Benchmark Phần Cứng (`services/tts-local`)

> **Phụ thuộc:** Chạy song song hoặc ngay sau Phase 1A  
> **Đầu ra:** Dịch vụ Python `3.12` quản lý bằng `uv` chạy trên `http://127.0.0.1:8765`, có xác thực bảo mật, `Singleflight` chống gọi trùng, Cache WAV ổ cứng nguyên tử, và báo cáo số đo tốc độ thực tế trên máy `i3-12100F + RX 6800 XT`.

---

## 1. Mục tiêu của Phase 1B

Xây dựng hậu phương tổng hợp giọng nói tiếng Việt ổn định, an toàn, không rò rỉ bộ nhớ, và **đo kiểm thực tế trên phần cứng của máy phát triển** trước khi khóa cấu hình mặc định cho chế độ `GPU` và `CPU Eco`.

---

## 2. Danh sách File sẽ khởi tạo

```text
services/tts-local/
├─ pyproject.toml                   # Quản lý bằng uv (FastAPI, Uvicorn, Pydantic, ONNX Runtime...)
├─ .env.example                     # Cấu hình mẫu (PORT, CACHE_MAX_GB, HARDWARE_PROFILE...)
├─ README.md                        # Lệnh chạy server & chạy benchmark
├─ scripts/
│  └─ benchmark_hardware.py         # Đo TTFB, RTF, CPU/RAM trên bộ 20 câu lập trình/Unity
├─ src/
│  └─ dubcera_tts/
│     ├─ __init__.py
│     ├─ config.py                  # Đọc cấu hình, số luồng CPU an toàn max(1, physical_cores - 1)
│     ├─ security.py                # Kiểm tra Origin, X-DubCera-Token, giới hạn độ dài văn bản
│     ├─ audio_validator.py         # Đọc RIFF/WAVE header, kiểm tra giải mã PCM, đo audioDurationMs thật
│     ├─ cache_store.py             # Atomic write (.tmp -> .wav), .meta.json, LRU eviction
│     ├─ singleflight.py            # Gộp các request đồng thời có cùng audioCacheKey vào 1 tác vụ
│     ├─ schemas.py                 # Request/Response contracts khớp với @dubcera/core
│     ├─ main.py                    # FastAPI app + lifecycle quản lý worker
│     └─ engines/
│        ├─ base.py                 # Abstract TTSEngine interface
│        ├─ vieneu_onnx.py          # Engine chính: VieNeu-TTS v3 (ONNX Runtime CPU / CUDA nếu có)
│        ├─ light_onnx.py           # Engine nhẹ cho CPU Eco (Piper / Sherpa-ONNX vi_VN)
│        ├─ dml_experimental.py     # Nhánh thử nghiệm ONNX DirectML cho GPU AMD trên Windows
│        └─ edge_optional.py        # Fallback online tùy chọn (0% tải CPU khi người dùng bật)
└─ tests/
   ├─ test_security.py
   ├─ test_cache_and_validator.py
   └─ test_singleflight.py
```

---

## 3. Đặc tả API Hợp đồng (`127.0.0.1:8765`)

Tất cả các endpoint (trừ `/v1/health` cơ bản) đều yêu cầu header `X-DubCera-Token` hợp lệ và `Origin` nằm trong danh sách cho phép:

### 3.1. `GET /v1/health`
Trả về trạng thái server, danh sách giọng khả dụng và profile phần cứng đang kích hoạt:
```json
{
  "status": "ok",
  "activeProfile": "cpu_eco_or_vieneu_onnx",
  "availableEngines": ["vieneu-onnx", "piper-vi-int8"],
  "availableVoices": [
    { "voiceId": "vieneu-nam-mien-bac", "engineId": "vieneu-onnx", "sampleRate": 24000 }
  ]
}
```

### 3.2. `POST /v1/cache/verify`
Khi người dùng F5 trang hoặc mở lại video cũ, Extension gửi danh sách `audioCacheKey[]` xuống để đối chiếu nhanh trên ổ đĩa:
- **Input:** `{ "cacheKeys": ["a1b2...", "c3d4..."] }`
- **Output:** Chỉ trả về những key **thực sự tồn tại file `.wav` hợp lệ trên đĩa** kèm `audioDurationMs` đọc từ `.meta.json`. Nếu file `.wav` bị xóa tay hoặc hỏng header, tự động dọn rác và báo miss để Extension cho tạo lại (`Invariant I5`).

### 3.3. `POST /v1/synthesize`
Tổng hợp giọng đọc tiếng Việt (hoặc trả ngay kết quả từ Cache / `Singleflight` nếu đang chạy):
- **Input:**
  ```json
  {
    "audioCacheKey": "sha256_hex_from_core",
    "text": "Đầu tiên, chúng ta cần tạo một GameObject mới và gắn Particle System vào đó.",
    "voiceId": "vieneu-nam-mien-bac",
    "engineId": "vieneu-onnx",
    "modelVersion": "v3",
    "sampleRate": 24000,
    "styleOrPitchConfig": "default",
    "pauseConfig": "default"
  }
  ```
- **Quy trình xử lý bên trong:**
  1. Kiểm tra độ dài `len(text) <= 1000` ký tự.
  2. Kiểm tra `AtomicDiskCache`: nếu trúng cache hợp lệ → trả về ngay `{ cacheHit: true, audioDurationMs, audioUrl }`.
  3. Kiểm tra `Singleflight`: nếu một request khác cùng `audioCacheKey` đang tổng hợp dở → `await` chung kết quả đó, không gọi model lần 2.
  4. Đẩy vào worker của engine tương ứng → nhận mảng mẫu PCM gốc ở tốc độ `1.0×` (tuyệt đối không cắt đuôi PCM).
  5. Ghi xuống file tạm `<key>.<uuid>.tmp.wav`, kiểm tra lại bằng `audio_validator.py` (RIFF header chuẩn, số mẫu > 0, `durationMs > 50ms`), sau đó đổi tên nguyên tử (`os.replace`) sang `<key>.wav` và ghi `<key>.meta.json`.
  6. Trả về `{ cacheHit: false, audioDurationMs, sampleRate, audioUrl: "/v1/audio/<key>" }`.

### 3.4. `GET /v1/audio/{audio_cache_key}`
Phục vụ luồng byte `audio/wav` từ đĩa cục bộ với header cache nội bộ cho `AudioContext` / `HTMLAudioElement` của Extension.

---

## 4. Kịch bản Đo Benchmark Thực Tế (`scripts/benchmark_hardware.py`)

Trước khi ghép vào Extension, chạy trực tiếp script này trên máy phát triển (`Intel Core i3-12100F` + `AMD Radeon RX 6800 XT`):
- **Bộ dữ liệu đo:** 20 câu phụ đề bài giảng Unity / C# thực tế (có pha trộn từ tiếng Anh chuyên ngành như `GameObject`, `Transform`, `MonoBehaviour`, `Rigidbody`, `async/await`), tổng thời lượng đọc khoảng `~2.5 – 3 phút`.
- **Các cấu hình đem ra đọ trực tiếp:**
  1. `VieNeu-TTS v3` chạy `ONNX Runtime CPU` (với `intra_op_num_threads = 6` trên 8 luồng logic để chừa sức cho Chrome).
  2. Thử nghiệm `ONNX Runtime DirectML` trên `RX 6800 XT` (1 session và 2 sessions tuần tự) với các model ONNX tương thích.
  3. `Piper / Sherpa-ONNX vi_VN (INT8)` cho profile `CPU Eco` máy yếu.
- **Chỉ số xuất ra báo cáo:**
  - `Warmup time` (thời gian nạp model lần đầu).
  - `TTFB / First-Sentence Latency` (số giây tạo xong câu đầu tiên khi vừa bấm Play hoặc vừa Tua).
  - `RTF` (`Tổng thời gian tính toán / Tổng thời lượng WAV sinh ra`) → quy đổi ra thời gian thực tế cho video 60 phút.
  - Đỉnh `RAM` và `% CPU` tiêu thụ.
  - Xuất mẫu file `.wav` ra thư mục tạm để nghe kiểm tra chất lượng phát âm từ tiếng Anh xen tiếng Việt.

---

## 5. Tiêu chí Nghiệm thu Phase 1B

- [ ] Server chỉ lắng nghe trên `127.0.0.1:8765`; gọi thử từ origin lạ hoặc thiếu `X-DubCera-Token` bị chặn `403` / `401` ngay lập tức.
- [ ] Bắn đồng thời 5 request giống hệt nhau vào `/v1/synthesize` chỉ kích hoạt đúng **1 lần** suy luận TTS nhờ `Singleflight`.
- [ ] File WAV hỏng hoặc dài 44 byte rỗng bị `audio_validator.py` từ chối và tự động xóa khỏi cache.
- [ ] Có bảng kết quả benchmark thật trên máy để chốt thông số mặc định cho `GPU` và `CPU Eco`.
