# Phase 1A — Core Domain, Thuật Toán Đồng Bộ & Unit Tests (`packages/core`)

> **Phụ thuộc:** Không có (Khởi tạo đầu tiên)  
> **Đầu ra:** Package `@dubcera/core` viết bằng TypeScript strict, chạy độc lập không cần trình duyệt, đi kèm bộ Unit Tests `Vitest` kiểm chứng toàn bộ thuật toán lõi.

---

## 1. Mục tiêu của Phase 1A

Tách toàn bộ phần "não bộ" dễ phát sinh bug nhất (ghép câu phụ đề, chia dòng hiển thị, quy đổi 2 đồng hồ `videoTimeMs` ↔ `audioClockMs`, dự báo trễ nhìn trước 3–5 câu, máy trạng thái `PlaybackIntent`, và băm khóa cache `SHA-256`) ra khỏi DOM của Chrome/YouTube để kiểm thử tự động 100% các ca biên trước khi gắn giao diện.

---

## 2. Danh sách File sẽ khởi tạo

```text
d:\New-project\DubCera\
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ packages/
   └─ core/
      ├─ package.json
      ├─ tsconfig.json
      ├─ vitest.config.ts
      ├─ src/
      │  ├─ index.ts
      │  ├─ contracts/
      │  │  ├─ subtitle.ts          # SubtitleCue, SpeechSegment, DisplayChunk
      │  │  ├─ playback.ts          # PlaybackIntent, PlaybackState, SpeedPlan
      │  │  └─ cache.ts             # SynthesisConfigSnapshot, VideoManifestRecord
      │  ├─ subtitles/
      │  │  ├─ vttParser.ts         # Parse chuẩn WebVTT (xử lý cue settings, HTML tags, timestamps)
      │  │  ├─ srtParser.ts         # Parse chuẩn SubRip (.srt)
      │  │  ├─ sentenceGrouper.ts   # Gom các cue rời thành SpeechSegment hoàn chỉnh
      │  │  └─ displayChunker.ts    # Tách translatedText dài thành DisplayChunk 1-2 dòng
      │  ├─ cache/
      │  │  └─ cacheKey.ts          # Chuẩn hóa text tiếng Việt + SHA-256 key builder
      │  ├─ sync/
      │  │  ├─ dualClockPlanner.ts  # Quy đổi videoTimeMs <-> audioClockMs + tính effectiveSpeechRate
      │  │  └─ driftPredictor.ts    # Nhìn trước 3-5 câu dự báo độ lệch tích lũy & đề xuất hành động
      │  ├─ state/
      │  │  ├─ playbackMachine.ts   # Quản lý PLAY/PAUSE intent, sessionId, userActionRevision
      │  │  └─ priorityQueue.ts     # Hàng đợi 2 tầng P0 (Urgent quanh playhead) & P1 (Background)
      │  └─ translation/
      │     ├─ types.ts             # Interface TranslationProvider dùng chung
      │     └─ glossary.ts          # Bộ từ khóa giữ nguyên khi dịch (Unity, C#, JS, lập trình)
      └─ tests/
         ├─ subtitles.test.ts
         ├─ displayChunker.test.ts
         ├─ dualClockPlanner.test.ts
         ├─ playbackMachine.test.ts
         ├─ priorityQueue.test.ts
         └─ cacheKey.test.ts
```

---

## 3. Đặc tả chi tiết từng Module trong `packages/core`

### 3.1. `vttParser.ts` & `srtParser.ts`
- Chuẩn hóa mọi dạng timestamp (`00:01:02.340`, `01:02.340`, `00:01:02,340`) về số nguyên `milliseconds` (`startMs`, `endMs` thuộc hệ `videoTimeMs`).
- Loại bỏ thẻ định dạng rác (`<c>`, `<i>`, `<b>`, VTT positioning `align:start position:0%`), gộp các dòng trùng lặp kiểu rolling captions của YouTube auto-caption nếu có.
- Bỏ qua các cue rỗng hoặc cue chỉ chứa ký hiệu âm nhạc/tiếng động (`[Music]`, `[Applause]`).

### 3.2. `sentenceGrouper.ts` (Gom `SubtitleCue[]` → `SpeechSegment[]`)
- **Quy tắc gom câu bảo thủ, tự nhiên:**
  - Nối các cue liên tiếp nếu cue trước **chưa kết thúc bằng dấu ngắt câu mạnh** (`.`, `?`, `!`, `:`) **VÀ** khoảng nghỉ tới cue sau `gapMs <= 600ms`.
  - **Ngắt cưỡng bức an toàn:** Không để một `SpeechSegment` vượt quá `maxDurationMs = 16_000ms` hoặc `maxWords = 50` (ưu tiên cắt tại dấu `,`, `;` hoặc liên từ `and`, `but`, `because`, `so`, `which`) để câu đầu tiên khi vừa tua tới không mất quá lâu để tạo TTS.
  - Ngắt ngay nếu phát hiện dấu hiệu đổi người nói (`- `, `>> `, `[Speaker]`).
  - Luôn bảo toàn mảng `sourceCueIds`, `startMs = firstCue.startMs`, `endMs = lastCue.endMs`, và gán `nextSegmentStartMs`.

### 3.3. `displayChunker.ts` (Tách `SpeechSegment.translatedText` → `DisplayChunk[]`)
- Nhận văn bản tiếng Việt đã dịch của một `SpeechSegment`.
- Nếu câu ngắn (`<= 18 từ`): giữ nguyên 1 `DisplayChunk` (`weightRatio = 1.0`).
- Nếu câu dài (`> 18 từ`): chia thành các cụm `10–18 từ` (tối đa 2 dòng ngắn trên màn hình video), ưu tiên cắt tại dấu `,`, `;`, `—` hoặc từ nối tiếng Việt (`nhưng`, `vì vậy`, `sau đó`, `để`, `khi`).
- Tính `weightRatio` cho từng chunk tỷ lệ với `số_âm_tiết + trọng_số_dấu_ngắt` (tổng bằng `1.0`) để `SubtitleOverlay` chuyển dòng mượt theo tiến độ phát thực tế của file audio câu đó.

### 3.4. `dualClockPlanner.ts` & `driftPredictor.ts`
- **Hàm quy đổi cốt lõi:**
  - Đầu vào: `nowClockMs`, `currentVideoTimeMs`, `videoRate`, `prevAudioEndClockMs`, `segment`, `lookaheadSegments[]`, `mode: 'LEARNING_HOLD_VIDEO' | 'STRICT_VIDEO_SPEED'`.
  - Tính `targetStartClockMs = nowClockMs + (segment.startMs - currentVideoTimeMs) / videoRate`.
  - Tính `actualStartClockMs = Math.max(targetStartClockMs, prevAudioEndClockMs + 60)`.
  - Tính cửa sổ khả dụng có mượn khoảng nghỉ sau câu (giới hạn `maxSilenceBorrowVideoMs = 2500ms`, chặn cứng tại `nextSegmentStartMs`).
  - Tính `effectiveSpeechRate` làm tròn bậc `0.05×`, kẹp trong `[1.0, maxEffectiveSpeechRate]` — trả về giá trị duy nhất để gắn vào bộ phát âm thanh (cấm nhân thêm `videoRate`).
- **Dự báo nhìn trước `3–5 câu` (`driftPredictor.ts`):**
  - Chạy mô phỏng tuần tự `3–5` segment tiếp theo đã có `audioDurationMs`.
  - Phân loại mức can thiệp theo độ trễ tích lũy dự kiến (`0–300ms`: giữ `1.0×`; `300–800ms`: tăng tốc đọc nhẹ; `800–1500ms`: tăng kịch trần cho phép + gợi ý hạ `videoRate` xuống `0.85×–0.90×` ở chế độ học tập; `> 1500ms`: yêu cầu giữ nhịp video ngắn tại ranh giới câu).

### 3.5. `playbackMachine.ts` & `priorityQueue.ts`
- Pure reducer / state machine cho `PlaybackState`:
  - `userPlay()`, `userPause()`, `seekStart()`, `seekSettle(targetVideoMs)`, `enterBuffering()`, `canAutoResume(capturedSession, capturedRevision)`, `onAutoplayRejected()`.
  - Quy tắc tìm segment khi tua (`resolveSegmentAtSeek`): với mọi `seekVideoMs` thỏa `seg.startMs <= seekVideoMs < seg.endMs`, trả về đúng `seg` đó để phát lại từ đầu câu (bảo toàn 100% lời đọc).
- `priorityQueue.ts`:
  - Phân loại danh sách segment chưa `READY` thành `P0_URGENT` (`[seekIdx .. seekIdx + 4]` hoặc trong vòng `30s` trước mặt) và `P1_BACKGROUND` (phần từ sau cửa sổ `P0` tới cuối video, rồi mới vòng lại phần đầu trước `playhead`).

---

## 4. Bộ Ca Kiểm Thử Bắt Buộc (`Vitest`)

1. **Ghép câu & Chia Sub:** 3 cue VTT bị cắt giữa câu tiếng Anh (`"First, we need to create"` + `"a new GameObject"` + `"in Unity."`) phải gom thành đúng 1 `SpeechSegment`; câu tiếng Việt dài 48 từ phải tách thành 3 `DisplayChunk` không làm mất bất kỳ chữ nào và `sum(weightRatio) === 1`.
2. **Không chồng giọng (`I3`):** Khi câu 1 kết thúc ở `audioClock = 5200ms` mà mốc câu 2 ở `4800ms`, câu 2 bắt buộc xếp lịch phát tại `5260ms`.
3. **Đổi tốc độ video `1.5×` (`I4`):** Video chạy `1.5×`, câu tiếng Việt dài `5000ms`, khung video `4000ms` → `effectiveSpeechRate` bị khóa đúng ở trần `1.35×` (không bao giờ vọt lên `1.875×` hay bị nhân đôi thành `2.025×`), và cờ báo thiếu thời gian bật đúng.
4. **An toàn Pause khi đang Buffering (`I8`):** Vào `enterBuffering()` ở `(session=2, rev=5)` → người dùng bấm Pause (`intent='PAUSE', rev=6`) → khi TTS tải xong gọi `canAutoResume(2, 5)` bắt buộc trả về `false`.
5. **Tua giữa câu (`I1`):** Câu kéo dài `10_000ms -> 16_000ms`, tua vào `15_200ms` (90% câu) vẫn chọn đúng câu đó phát từ đầu; tua vào `16_000ms` mới sang câu kế tiếp.
6. **Toàn vẹn Cache Key (`I5`):** Đổi `voiceId` hoặc `sampleRate` hoặc dấu thanh tiếng Việt (`"mới"` vs `"mời"`) phải sinh ra `audioCacheKey` hoàn toàn khác nhau.
