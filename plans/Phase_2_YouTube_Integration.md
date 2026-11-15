# Phase 2 — Tích Hợp Chrome Extension Cho YouTube (`YouTubeAdapter`)

> **Phụ thuộc:** Phase 1C đã chạy ổn định trên HTML5 Sandbox  
> **Đầu ra:** Cài Extension lên Chrome, mở bất kỳ video bài giảng/hướng dẫn trên YouTube có phụ đề khả dụng là bật nghe lồng tiếng Việt + xem Sub 1–2 dòng trực tiếp trên khung player YouTube.

---

## 1. Mục tiêu của Phase 2

Kết nối toàn bộ bộ điều phối đã kiểm chứng ở Phase 1 vào môi trường thực tế của `youtube.com` — xử lý gọn cơ chế chuyển trang không tải lại (SPA Navigation), lấy track phụ đề hợp lệ, đồng bộ an toàn với thanh điều khiển gốc của YouTube và không bị vỡ giao diện khi bật Fullscreen / Theater Mode.

---

## 2. Danh sách File sẽ thêm mới / hoàn thiện

```text
apps/extension/src/
├─ adapters/
│  └─ youtube/
│     ├─ youtubeAdapter.ts          # Phát hiện video mới, gắn/gỡ vòng đời theo SPA YouTube
│     ├─ youtubeSubtitleExtractor.ts# Trích xuất danh sách track phụ đề khả dụng & chuẩn hóa về SubtitleCue[]
│     └─ youtubeControlsHook.ts     # Bắt tương tác Play/Pause/Seek trên player YouTube & gắn nút DubCera
├─ ui/
│  ├─ PlayerToggleButton.tsx        # Nút bật/tắt nhanh DubCera nằm gọn cạnh cụm nút cài đặt player
│  └─ CachedRangesBar.tsx           # Thanh mảnh hiển thị các đoạn đã dịch/gen cache dọc theo timeline
└─ entrypoints/popup/
   └─ App.tsx                       # Hoàn thiện UI chọn giọng, tốc độ, chế độ Học tập vs Giữ tốc độ video
```

---

## 3. Các bài toán đặc thù của YouTube cần xử lý triệt để

### 3.1. Vòng đời SPA & Đổi video liên tục (`youtubeAdapter.ts`)
- YouTube không tải lại trang khi người dùng bấm sang video khác ở cột bên phải hoặc danh sách phát (Playlist).
- Lắng nghe sự kiện `yt-navigate-finish` kết hợp theo dõi thay đổi tham số `v=` và sự thay đổi `src` của thẻ `video.html5-main-video`:
  - Ngay khi đổi `videoId`: hủy phiên cũ (`sessionId++`), dừng `SingleAudioQueue`, giải phóng các `AudioBuffer` của video cũ trên RAM, nạp `VideoManifest` mới cho `videoId` mới.
- **Chống lồng tiếng nhầm Quảng cáo (Ads Guard):**
  - Kiểm tra trạng thái quảng cáo trên `.html5-video-player` (ví dụ class `.ad-showing` / `.ad-interrupting`). Khi đang phát quảng cáo: tạm ngắt điều phối lồng tiếng và khôi phục âm lượng gốc, chỉ kích hoạt khi vào nội dung video chính.

### 3.2. Trích xuất Phụ đề hợp lệ (`youtubeSubtitleExtractor.ts`)
- Chỉ lấy các track phụ đề mà người xem được phép truy cập trên trang:
  1. Ưu tiên phụ đề chuẩn do tác giả tải lên (Manual Captions — ví dụ `en`) vì dấu câu và ngắt ý chuẩn xác hơn.
  2. Nếu chỉ có phụ đề tự động (ASR Auto-captions): kích hoạt bộ tiền xử lý khử trùng lặp dòng trượt (rolling cue deduplication) trước khi đưa vào `sentenceGrouper` để không bị lặp chữ hai lần.
  3. Nếu video hoàn toàn không có phụ đề nào khả dụng: báo trạng thái rõ ràng `"Video này chưa có phụ đề — Hỗ trợ nhập file .srt/.vtt thủ công"` (cho phép người dùng kéo thả file `.srt`/`.vtt` ngoài vào nếu muốn).

### 3.3. Đồng bộ ý định `PlaybackIntent` với Nút điều khiển gốc YouTube (`youtubeControlsHook.ts`)
- Bắt sự kiện ở **`capture phase`** trên:
  - Nút `.ytp-play-button`
  - Click trực tiếp lên bề mặt video để dừng/phát
  - Phím tắt `Space` và `K` (chỉ khi con trỏ chuột không nằm trong ô nhập bình luận `input` / `textarea` / `contenteditable`!)
- Nhờ đó, ngay cả khi thẻ `<video>` đang bị `Buffer Gate` giữ dừng (`video.paused === true`), nếu người dùng bấm `K`/`Space` hoặc bấm nút dừng, `PlaybackState` lập tức ghi nhận `intent = 'PAUSE'; userActionRevision++` để không tự phát lại ngoài ý muốn.

### 3.4. Hiển thị trong Fullscreen & Theater Mode
- Mount `Shadow DOM` của `SubtitleOverlay` và `BufferingBadge` trực tiếp bên trong container `.html5-video-player` (thay vì gắn ở `document.body`), đảm bảo khi người dùng phóng toàn màn hình (`F`), hộp phụ đề 1–2 dòng tự động co giãn tỷ lệ chữ phù hợp và luôn nổi đúng vị trí phía trên thanh timeline của YouTube.
- Tự động ẩn phụ đề gốc của YouTube (nếu người dùng chọn chế độ dùng hộp Sub của DubCera) để tránh 2 lớp chữ đè lên nhau.

---

## 4. Tiêu chí Nghiệm thu Phase 2

- [ ] Mở một video tutorial tiếng Anh dài 30–60 phút trên YouTube → bật nút DubCera → nghe giọng Việt rõ ràng, phụ đề 1–2 dòng sắc nét, kể cả khi bật Fullscreen.
- [ ] Tua qua lại nhiều đoạn trên thanh đỏ của YouTube, bấm phím `K`/`Space`, chuyển tốc độ `1.25×` ngay trong bánh răng YouTube đều đồng bộ chính xác.
- [ ] Click sang video khác trong Playlist → tiếng của video cũ ngắt ngay lập tức, tự động khởi tạo sạch sẽ cho video mới.
- [ ] Gặp video không có phụ đề → báo trạng thái rõ ràng, không làm treo hay mất tiếng gốc của YouTube.
