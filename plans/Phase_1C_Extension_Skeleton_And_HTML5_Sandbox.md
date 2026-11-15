# Phase 1C — Khung Extension, Lưu Trữ IndexedDB & HTML5 Video Sandbox (`apps/extension`)

> **Phụ thuộc:** Phase 1A (`@dubcera/core`) và Phase 1B (`services/tts-local`)  
> **Đầu ra:** Chrome Extension chạy được trên trình duyệt kèm trang **HTML5 Video Sandbox** tích hợp sẵn, vận hành trọn vẹn luồng **Xem + Tua `Pause-Buffer-Resume` + Lưu Cache bền vững + Hiện Sub 1–2 dòng & Phát Voice tiếng Việt**.

---

## 1. Mục tiêu của Phase 1C

Chứng minh toàn bộ hệ thống chạy mượt từ đầu đến cuối trên một trình phát `<video>` chuẩn HTML5 (nạp được bất kỳ video dài 30–60 phút + file `.vtt`/`.srt` thực tế) trước khi xử lý các đặc thù DOM riêng của YouTube và Udemy.

---

## 2. Danh sách File sẽ khởi tạo

```text
apps/extension/
├─ package.json
├─ tsconfig.json
├─ wxt.config.ts                    # Cấu hình Manifest V3, quyền storage + host 127.0.0.1
├─ entrypoints/
│  ├─ background.ts                 # Cầu nối gọi tới 127.0.0.1:8765 + quản lý Token & Settings
│  ├─ content.ts                    # Content script kích hoạt trên các trang video được hỗ trợ
│  ├─ popup/                        # Giao diện điều khiển nhanh của Extension
│  │  ├─ index.html
│  │  ├─ main.tsx
│  │  └─ App.tsx
│  └─ sandbox/                      # Trang thử nghiệm HTML5 Video độc lập
│     ├─ index.html
│     ├─ main.tsx
│     └─ SandboxPlayer.tsx
└─ src/
   ├─ storage/
   │  ├─ manifestDb.ts              # IndexedDB lưu VideoManifest & bản dịch từng câu
   │  └─ settingsStore.ts           # Lưu cấu hình giọng đọc, profile phần cứng, API dịch, kiểu Sub
   ├─ translation/
   │  ├─ batchTranslator.ts         # Chia lô dịch (3-4 câu cho P0 khẩn cấp, 12-16 câu cho P1 nền)
   │  ├─ freeWebProvider.ts         # Provider dịch nhanh mặc định không cần key
   │  └─ llmApiProvider.ts          # Provider chuẩn OpenAI / Gemini giữ chuẩn thuật ngữ Unity/Code
   ├─ tts/
   │  └─ localTtsClient.ts          # Gọi /v1/cache/verify, /v1/synthesize, preload AudioBuffer
   ├─ coordinator/
   │  ├─ syncCoordinator.ts         # Ghép PlaybackIntentMachine + DualClockPlanner + Buffer Gate
   │  └─ singleAudioQueue.ts        # Phát tuần tự 1 luồng duy nhất (preservesPitch = true), giải phóng RAM
   ├─ ui/
   │  ├─ shadowMount.ts             # Gắn UI cách ly CSS bằng Shadow DOM đè lên khung video
   │  ├─ SubtitleOverlay.tsx        # Hiển thị DisplayChunk 1-2 dòng (Việt / Song ngữ / Tắt)
   │  └─ BufferingBadge.tsx         # Hiện trạng thái đang nạp câu mồi + nút [Tạm dừng] rõ ràng
   └─ adapters/
      ├─ types.ts                   # Interface VideoPlatformAdapter dùng chung
      └─ html5SandboxAdapter.ts     # Adapter chuẩn cho thẻ <video> trên trang Sandbox
```

---

## 3. Luồng vận hành chi tiết sẽ ghép nối trong Phase 1C

### 3.1. Khởi tạo & Khôi phục Cache (`Hydration`)
1. Khi bật lồng tiếng cho một video: tạo `videoKey = sha256(platform + videoId + subtitleHash + targetLang)`.
2. Đọc `manifestDb.ts` (`IndexedDB`):
   - Nếu đã từng mở video này trước đó: nạp lại ngay toàn bộ `translatedText` của các câu đã dịch (không cần dịch lại!).
   - Thu thập tất cả `audioCacheKey` của các câu khớp `activeConfigVersion` hiện tại, gửi 1 request duy nhất `POST /v1/cache/verify` xuống `tts-local`.
   - Những câu nào ổ cứng xác nhận còn WAV hợp lệ → chuyển thẳng sang `READY`.

### 3.2. Dịch Ngữ Cảnh 2 Tốc Độ (`Urgent Mini-Batch` vs `Background Batch`)
- **Khi vừa bấm Play hoặc vừa Tua vào vùng chưa dịch (`Tier P0`):**
  - Chỉ cắt lô nhỏ **`2–3 câu` ngay tại con trỏ phát** gửi đi dịch trước để có chữ tiếng Việt trong `< 0.6 – 1.0s`, đẩy ngay sang `tts-local` tạo giọng câu `[k, k+1]`.
- **Khi video đã chạy ổn định (`Tier P1`):**
  - Gom lô **`12–16 câu` liên tiếp** kèm `2 câu trước` làm ngữ cảnh chỉ-đọc + `Glossary` chuyên ngành để bản dịch mạch lạc và tiết kiệm số lượt gọi.
  - Dịch xong câu nào ghi ngay vào `IndexedDB` câu đó.

### 3.3. Điều phối `Buffer Gate` & `SingleAudioQueue`
- Khi ở vị trí `playhead` chưa đủ cửa sổ mồi (`[k, k+1]` chưa `READY`):
  1. `syncCoordinator` ghi nhận `(capturedSession, capturedRevision)`, đặt `isBuffering = true`, gọi `video.pause()` (chỉ khi `!video.paused`), hiện `BufferingBadge` kèm nút `[Tạm dừng]`.
  2. Khi `[k, k+1]` báo `READY` và đã preload buffer âm thanh xong: kiểm tra đủ 4 điều kiện (`sessionId` khớp, `userActionRevision` khớp, `intent === 'PLAY'`, cửa sổ `READY`) → bọc `await video.play()` trong `try/catch`. Nếu trình duyệt chặn autoplay, hiện nút `"Bấm để tiếp tục phát"`.
- Khi đang phát (`PLAYING_SYNCED`):
  - Giảm âm lượng gốc của `<video>` xuống mức nền người dùng chọn (mặc định `10–15%`, không tắt câm 0% hoàn toàn trừ khi người dùng muốn để vẫn nghe được tiếng click chuột/hiệu ứng trong bài giảng).
  - Phát tuần tự từng segment với `playbackRate = effectiveSpeechRate` và `preservesPitch = true`.
  - Cập nhật `SubtitleOverlay` chuyển từng `DisplayChunk` (1–2 dòng) khớp theo thời gian phát thực tế của câu đang đọc.

---

## 4. Kịch bản Nghiệm thu Thực Tế trên Trang Sandbox

Bạn sẽ mở trực tiếp trang Sandbox của Extension trên Chrome, nạp 1 file video dài + 1 file `.vtt`/`.srt` bài giảng tiếng Anh và kiểm tra 7 thao tác thực tế:

- [ ] **Test 1 (Khởi phát):** Bấm bật DubCera → dừng đệm ~1.5–2.5s → tự chạy video, tiếng Anh nhỏ xuống nền, giọng Việt đọc rõ kèm phụ đề gọn 1–2 dòng không che giữa màn hình.
- [ ] **Test 2 (Tua nhảy cóc vùng mới):** Kéo thanh tua từ phút `01:00` tới phút `25:00` → tiếng cũ ngắt tức thì, video tự dừng hiện `"Đang chuẩn bị lồng tiếng..."`, xong 2 câu tự chạy tiếp đọc trọn từ đầu câu tại phút `25:00`.
- [ ] **Test 3 (Bấm Dừng trong lúc đang nạp):** Tua tới phút `40:00`, ngay lúc đang hiện `"Đang chuẩn bị lồng tiếng..."` thì bấm Pause → nạp xong hệ thống **đứng yên**, tuyệt đối không tự chạy lại.
- [ ] **Test 4 (Tua lại vùng cũ & F5 trang):** Tua ngược về phút `01:00` hoặc bấm `F5` tải lại trang rồi bấm Play → phát lồng tiếng ngay từ Cache, không phải dịch/gen lại.
- [ ] **Test 5 (Tua spam liên tục):** Kéo chuột rà qua lại 10 vị trí trong 2 giây → không đè 2 giọng lên nhau, không văng lỗi.
- [ ] **Test 6 (Đổi tốc độ video `1.0×` → `1.25×` → `1.5×`):** Lịch phát tự tính lại mượt mà, giọng đọc không bị méo tiếng hay vọt tốc độ quá trần.
- [ ] **Test 7 (Đổi giọng đọc giữa chừng):** Chuyển sang giọng khác trong Popup → các câu đang chạy bằng giọng cũ không ghi đè hỏng lịch phát của giọng mới.
