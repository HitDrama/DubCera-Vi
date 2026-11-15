# Phase 3 — Tích Hợp Udemy & Gia Cố Chạy Bền Video Dài 60–120 Phút

> **Phụ thuộc:** Phase 2 đã chạy ổn định trên YouTube  
> **Đầu ra:** Học trọn vẹn các khóa học lập trình / Unity / Game Dev trên Udemy bằng giọng tiếng Việt + phụ đề thuật ngữ chuẩn, vận hành liên tục 1–2 tiếng không rò rỉ bộ nhớ và tự phục hồi êm ái khi có lỗi mạng/server.

---

## 1. Mục tiêu của Phase 3

Mở rộng sang môi trường khóa học chuyên ngành **Udemy** (nơi mật độ từ khóa kỹ thuật cao và người học thường tua đi tua lại xem thao tác màn hình chi tiết), đồng thời hoàn thiện toàn bộ cơ chế bảo vệ bộ nhớ, dung lượng đĩa và chịu lỗi đường dài cho bản phát hành MVP hoàn chỉnh.

---

## 2. Danh sách File sẽ thêm mới / hoàn thiện

```text
apps/extension/src/
├─ adapters/
│  └─ udemy/
│     ├─ udemyAdapter.ts            # Nhận diện bài giảng Udemy, theo dõi chuyển Lecture tự động
│     ├─ udemySubtitleExtractor.ts  # Đọc track .vtt hợp lệ từ thẻ <track> / dữ liệu bài giảng người học đang mở
│     └─ udemyControlsHook.ts       # Đồng bộ Play/Pause/Seek/PlaybackRate với trình phát Video.js/Shaka của Udemy
├─ translation/
│  └─ domainGlossaries/
│     ├─ unityGameDev.ts            # Glossary chuyên sâu Unity (GameObject, Prefab, Inspector, Shader Graph, URP...)
│     └─ softwareEngineering.ts     # Glossary lập trình chung (Promise, Callback, Middleware, Dependency Injection...)
└─ coordinator/
   ├─ memoryGuard.ts                # Sliding Decoded Window giải phóng AudioBuffer cũ khỏi RAM
   └─ healthFallbackManager.ts      # Chuyển mượt về chế độ chỉ hiện Sub nếu tts-local mất kết nối
```

---

## 3. Đặc tả kỹ thuật chi tiết cho Phase 3

### 3.1. `UdemyAdapter` & Quy tắc Tuân thủ Bản quyền / DRM
- **Nguyên tắc bắt buộc (Mục 9 & 11.8 `DubCera_README.md`):**
  - Chỉ đọc phụ đề `.vtt` hợp lệ khi người dùng đã đăng nhập và có quyền học bài giảng đó (thông qua `HTMLVideoElement.textTracks` hoặc URL phụ đề `.vtt` đang gắn hợp lệ cho trình phát).
  - Nếu gặp bài giảng bật cơ chế bảo vệ DRM khóa luồng hoặc chặn truy cập phụ đề: hiển thị thông báo rõ ràng `"Bài giảng này giới hạn quyền truy cập phụ đề"`, giữ nguyên video gốc hoạt động bình thường, **tuyệt đối không can thiệp hay tìm cách vượt cơ chế bảo vệ nội dung**.
- **Tự động chuyển bài giảng (`Auto-Advance Lecture`):**
  - Khi học hết Lecture 1 và Udemy tự chuyển sang Lecture 2 trong cùng tab: tự động dọn dẹp phiên cũ, nạp phụ đề Lecture 2 và duy trì trạng thái bật DubCera mà học viên không cần bấm bật lại bằng tay.

### 3.2. Tối ưu vị trí Sub & Glossary cho Bài giảng Unity / Code
- Trong video dạy Unity hoặc viết code trên VS Code/Rider, thanh công cụ dưới đáy màn hình hoặc cửa sổ Console thường chứa thông tin quan trọng:
  - Cho phép người dùng **kéo thả vị trí hộp `SubtitleOverlay`** (hoặc gạt lên góc trên / đặt ngoài vùng video nếu bố cục cho phép) và chỉnh độ mờ nền (`backdrop opacity`).
- Kích hoạt bộ **Glossary `unityGameDev` & `softwareEngineering`**:
  - Giữ nguyên dạng viết chuẩn tiếng Anh cho tên class, component, hàm API (`Rigidbody2D`, `OnTriggerEnter`, `SerializeField`, `ScriptableObject`, `NavMeshAgent`...) để vừa khớp với giao diện tiếng Anh trên màn hình giảng viên, vừa giúp `VieNeu-TTS` phát âm tự nhiên không dịch sát nghĩa gây lú (như tránh dịch *Rigidbody* thành *"Cơ thể cứng"*).

### 3.3. Gia cố chạy liên tục 60–120 phút (`memoryGuard.ts` & Disk Quota)
1. **Trên trình duyệt (`Sliding Decoded Window`):**
   - Một video 120 phút có khoảng `~1.000 SpeechSegment`. Nếu giữ toàn bộ `AudioBuffer` đã giải mã PCM trên RAM trình duyệt sẽ ngốn hàng GB RAM.
   - `memoryGuard.ts` chỉ giữ tối đa **6 `AudioBuffer` / `ObjectURL`** trong cửa sổ `[currentIdx - 1 .. currentIdx + 4]`. Mọi câu nằm ngoài cửa sổ lập tức được `URL.revokeObjectURL()` và hủy tham chiếu bộ nhớ (vì file WAV gốc vẫn nằm an toàn trên `Disk Cache` của `tts-local`, nếu tua ngược lại nạp lên chỉ mất vài chục mili-giây).
2. **Dưới `services/tts-local` (`LRU Disk Quota`):**
   - Kiểm tra định kỳ dung lượng thư mục `cache/` (mặc định tối đa `5 GB`). Khi vượt ngưỡng, xóa theo thứ tự `lastAccessedAt` cũ nhất.
3. **Cơ chế Tự Phục Hồi Khi Mất Kết Nối Local TTS (`healthFallbackManager.ts`):**
   - Nếu đang học mà người dùng vô tình đóng cửa sổ `tts-local` (hoặc request timeout quá `6 giây` sau 1 lần ping kiểm tra):
     - Lập tức nhả `Buffer Gate` để không khóa cứng video bài giảng.
     - Khôi phục âm lượng gốc `100%` của giảng viên.
     - Vẫn tiếp tục dịch và hiển thị **`SubtitleOverlay` tiếng Việt 1–2 dòng** bình thường kèm thông báo nhỏ `"Local TTS tạm ngắt — Đang hiển thị Phụ đề tiếng Việt"`. Khi bật lại `tts-local`, tự động nối lại giọng đọc ở câu kế tiếp.

---

## 4. Checklist Nghiệm thu Tổng thể Trước Khi Chốt MVP v1.0

- [ ] Học thử liên tục 1 bài giảng dài `60–120 phút`: mức RAM của tab trình duyệt đi ngang ổn định (không tăng tuyến tính theo thời gian xem).
- [ ] Thuật ngữ Unity / Lập trình hiển thị trên Sub và phát qua giọng đọc giữ đúng chuẩn chuyên ngành.
- [ ] Thử tắt đột ngột tiến trình Python `tts-local` khi video đang chạy → sau vài giây video tự nhả dừng, trả lại tiếng gốc và tiếp tục chạy phụ đề tiếng Việt mượt mà, không văng lỗi làm đơ trang.
- [ ] Toàn bộ 12 mục trong *Checklist kiểm thử quan trọng* của `DubCera_README.md` và 8 mục trong `DubCera_Architecture_Flow.md` đều đạt `PASS`.
