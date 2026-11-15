# DubCera — Đặc Tả Luồng Xử Lý & Kiến Trúc Chi Tiết (Flow Specification v2)

> **Phiên bản:** `v2.0` (Đã cập nhật đầy đủ 8 hiệu chỉnh từ vòng Architecture Audit)  
> **Mục đích tài liệu:** Đặc tả chính xác luồng dữ liệu, máy trạng thái dựa trên ý định (`PlaybackIntent`), hệ thời gian kép (`videoTimeMs` / `audioClockMs`), dự báo trễ nhìn trước 3–5 câu, tách đơn vị đọc (`SpeechSegment`) và đơn vị hiển thị (`DisplayChunk`), lưu trữ cache 2 tầng an toàn phiên, và lộ trình kiểm chứng phần cứng thực tế trước khi triển khai MVP.  
> **Tài liệu gốc tham chiếu:** `DubCera_README.md`

---

## 1. Mục tiêu cốt lõi & Các bất biến hệ thống (System Invariants)

DubCera dịch và lồng tiếng video ngoại ngữ (YouTube, Udemy, HTML5 Video có phụ đề hợp lệ) sang tiếng Việt ngay trên trình duyệt với **hai đầu ra đồng bộ: Phụ đề hiển thị gọn gàng (`DisplayChunk` 1–2 dòng) + Giọng đọc tiếng Việt (`SpeechSegment`)**.

Mọi thành phần bắt buộc tuân thủ **8 bất biến (Invariants)**:

- **`I1` (Bảo toàn nội dung):** Không xóa/bỏ `SpeechSegment` chỉ vì câu dịch dài hơn khung thời gian gốc; không tự ý bỏ phần lời đọc khi người dùng tua vào giữa câu.
- **`I2` (Không cắt âm thanh):** Cấm cắt đuôi PCM/WAV (hard-clip) để ép khớp timestamp của cue.
- **`I3` (Đơn luồng giọng đọc):** Tại mọi thời điểm chỉ có tối đa **01** segment tiếng Việt phát ra loa (`nextAudioStartClock >= prevAudioEndClock + minBreathGapMs`).
- **`I4` (Trần tốc độ hiệu dụng):** Tốc độ phát thực tế của audio (đã quy đổi theo `video.playbackRate`, bảo toàn cao độ) không vượt `maxEffectiveSpeechRate` (mặc định thử nghiệm `1.30× – 1.35×`), và không bao giờ bị nhân chồng `video.playbackRate` hai lần.
- **`I5` (Toàn vẹn & Định danh Cache):** `audioCacheKey` tính băm `SHA-256` trên toàn bộ tham số ảnh hưởng đầu ra âm thanh (`normalizedText`, `voiceId`, `engineId`, `modelVersion`, `sampleRate`, `pitch/style/pauseConfig`); xác minh file thực sự tồn tại và giải mã hợp lệ trước khi gán `READY`.
- **`I6` (An toàn phiên & Cấu hình):** Mọi thao tác phát/tua/đổi giọng đều kiểm soát qua `sessionId` và `configVersion`; tác vụ TTS cũ đang chạy dở chỉ được phép lưu vào `audioCacheKey` cũ, tuyệt đối không ghi đè manifest cấu hình mới và không được phát ra loa.
- **`I7` (Không nuốt lỗi âm thầm):** Lỗi dịch hoặc lỗi TTS ở bất kỳ câu nào đều phải hiển thị trạng thái rõ ràng kèm phụ đề thay thế, không âm thầm nhảy qua nội dung.
- **`I8` (Tôn trọng tuyệt đối Ý định Người dùng — `PlaybackIntent`):** Hệ thống quản lý tường minh `intent: "PLAY" | "PAUSE"` kèm `userActionRevision`; chỉ tự động phát tiếp sau khi nạp đệm nếu phiên không đổi và người dùng chưa yêu cầu tạm dừng. Khi không chắc chắn ý định từ player bên ngoài, ưu tiên giữ trạng thái dừng an toàn.

---

## 2. Kiến trúc tinh gọn 4 Module chính

Thay vì tách rời quá nhiều hàng đợi phức tạp, kiến trúc MVP được rút gọn về đúng **4 module cốt lõi** không phụ thuộc vòng tròn:

```mermaid
flowchart TD
    V["Video YouTube / Udemy / HTML5"] -->|"Cues / .vtt / .srt"| M1["1. Subtitle Parser & Grouper"]
    M1 -->|"SpeechSegment[] + DisplayChunk[]"| M2["2. Translation & TTS Pipeline"]
    M2 <-->|"Singleflight + Verify SHA-256"| C[("Cache 2 Tầng: IndexedDB + Local Disk")]
    M2 -->|"Segments READY"| M3["3. Adaptive Sync Coordinator"]
    V -->|"Play / Pause / Seek / Ratechange"| M3
    M3 -->|"Đủ cửa sổ đệm?"| G{"Buffer Gate"}
    G -- "Chưa đủ" -->|"Giữ video + Ưu tiên P0"| M2
    G -- "Đã đủ & intent == PLAY" --> M4["4. Player Bridge & Dual Overlay"]
    M4 -->|"Vietnamese Voice + 1-2 Line Sub"| U["Người xem"]
```

Trong đó **`Adaptive Sync Coordinator`** gói gọn 3 trách nhiệm nội bộ:
1. **`PlaybackState`:** Quản lý ý định `PLAY`/`PAUSE`, trạng thái `isBuffering`, `sessionId` và `userActionRevision`.
2. **`Dual-Clock Speed Planner`:** Ánh xạ `videoTimeMs` ↔ `audioClockMs`, nhìn trước `3–5 câu` dự báo độ trễ tích lũy và điều phối tốc độ đọc / nhịp video.
3. **`Single Audio Queue`:** Phát tuần tự một luồng âm thanh duy nhất, không chồng giọng, không bỏ câu.

---

## 3. Cấu trúc dữ liệu & Tách `SpeechSegment` / `DisplayChunk`

### 3.1. Phân tách đơn vị Dịch/Đọc và đơn vị Hiển thị Phụ đề
Một câu ghép hoàn chỉnh (`SpeechSegment`) có thể dài `40–60 từ`. Nếu hiển thị cả khối văn bản lên màn hình sẽ che khuất vùng thao tác code / Unity Editor. Do đó:
- **`SpeechSegment`:** Đơn vị ngữ nghĩa trọn câu dùng để **dịch có ngữ cảnh** và **tổng hợp giọng nói (TTS)** để câu đọc tự nhiên, không gãy nhịp.
- **`DisplayChunk`:** Đơn vị con tách ra từ `translatedText` của một `SpeechSegment` (tối đa **1–2 dòng**, khoảng `12–18 từ/chunk`, ưu tiên cắt tại dấu phẩy, chấm phẩy hoặc liên từ) dùng riêng cho **`SubtitleOverlay`**.

```typescript
export interface SubtitleCue {
  cueId: string;
  startMs: number;              // Thuộc trục videoTimeMs
  endMs: number;                // Thuộc trục videoTimeMs
  rawText: string;
}

export interface DisplayChunk {
  chunkId: string;
  text: string;                 // Tối đa 1-2 dòng hiển thị gọn trên video
  sourceExcerpt?: string;       // Phục vụ chế độ song ngữ nếu bật
  weightRatio: number;          // Tỷ trọng âm tiết trong câu (tổng các chunk = 1.0)
  alignedStartOffsetMs?: number;// Dùng khi provider có word/phrase timestamp thật
  alignedEndOffsetMs?: number;
}

export type SegmentStatus =
  | 'UNPROCESSED'
  | 'TRANSLATING'
  | 'TRANSLATED'
  | 'SYNTHESIZING'
  | 'READY'
  | 'ERROR';

export interface SynthesisConfigSnapshot {
  targetLang: string;
  voiceId: string;
  engineId: string;
  modelVersion: string;
  sampleRate: number;
  styleOrPitchConfig: string;
  pauseConfig: string;
}

export interface SpeechSegment {
  segmentIndex: number;
  segmentId: string;
  sourceCueIds: string[];
  startMs: number;              // Trục videoTimeMs
  endMs: number;                // Trục videoTimeMs
  nextSegmentStartMs: number | null;
  sourceText: string;
  translatedText?: string;
  displayChunks?: DisplayChunk[];
  configVersion: string;        // Hash của SynthesisConfigSnapshot hiện hành
  audioCacheKey?: string;       // sha256(normalizedViText + JSON(SynthesisConfigSnapshot))
  audioDurationMs?: number;     // Thời lượng PCM/WAV thực tế ở tốc độ 1.0x
  status: SegmentStatus;
  errorMessage?: string;
}
```

> **Lưu ý về căn thời gian `DisplayChunk` ở MVP:** Khi chưa có word-level forced alignment, thời điểm chuyển giữa các `DisplayChunk` trong phạm vi `[actualAudioStartClock, actualAudioEndClock]` của câu được phân bổ theo tỷ trọng số âm tiết + trọng số dấu ngắt câu (`weightRatio`). Tài liệu ghi nhận rõ đây là xấp xỉ hiển thị mượt ở MVP, chưa phải căn từng chữ tuyệt đối.

### 3.2. Cache 2 tầng, `Singleflight` & Kiểm tra toàn vẹn

1. **Chống gọi trùng tác vụ (`Singleflight Deduplication`):**
   - Pipeline giữ bảng `inFlightSynthesis: Map<audioCacheKey, Promise<AudioMeta>>`. Nếu hai câu có cùng nội dung chuẩn hóa hoặc sự kiện tua kích hoạt lại câu đang tạo dở, các lời gọi sau dùng chung `Promise` đang chạy thay vì bắn request TTS thứ hai.
2. **Bảo vệ khi đổi giọng / cấu hình giữa chừng:**
   - Khi người dùng đổi `voiceId` hoặc model, `activeConfigVersion` tăng mới. Mọi kết quả TTS cũ vừa chạy xong chỉ được ghi vào đĩa dưới `audioCacheKey` cũ của nó; chỉ cập nhật trạng thái `segment.status = 'READY'` trên manifest đang mở nếu `result.configVersion === activeConfigVersion`.
3. **Không gán `READY` mù quáng & Tính chi phí giải mã:**
   - Chỉ đánh dấu `READY` sau khi xác minh file WAV trên đĩa tồn tại, ghi hoàn tất (atomic rename), header hợp lệ và `durationMs > 50ms`.
   - Ngay cả khi `Cache Hit`, hệ thống vẫn nạp trước (`preload + decodeAudioData`) cho `2–3 câu` sắp tới trong cửa sổ lookahead vì thao tác đọc đĩa + giải mã PCM sang `AudioBuffer` vẫn tốn vài đến vài chục mili-giây, không giả định bằng `0 ms` tuyệt đối.

---

## 4. Quản lý Ý định Phát (`PlaybackIntent`) & Xử lý Tua an toàn

### 4.1. Thay cờ Boolean bằng `PlaybackState` có Revision tường minh
Không suy đoán ý định người dùng thuần túy qua sự kiện `pause` của DOM (vì `video.pause()` không bắn sự kiện nếu video đã dừng sẵn, sự kiện không cho biết nguồn gọi, và `video.play()` trả về `Promise` có thể bị từ chối).

```typescript
export type PlaybackIntent = 'PLAY' | 'PAUSE';

export interface PlaybackState {
  intent: PlaybackIntent;
  isBuffering: boolean;
  sessionId: number;
  userActionRevision: number;
  autoplayBlocked: boolean;
}
```

**Quy tắc vận hành chặt chẽ:**
1. **Khi cần giữ video chờ dịch/TTS (`enterBuffering`):**
   - Ghi lại `capturedSession = state.sessionId` và `capturedRevision = state.userActionRevision`.
   - Đặt `state.isBuffering = true`. Chỉ gọi `video.pause()` nếu `!video.paused` (kèm dấu thời gian/token nội bộ ngắn hạn cho riêng lần gọi đó, không bao giờ để treo cờ nếu `video.paused` đã là `true`).
   - Trên badge `"Đang chuẩn bị lồng tiếng..."` hiển thị nút **`[Tạm dừng]`** rõ ràng để người dùng có thể chủ động chuyển `intent = 'PAUSE'; userActionRevision++` ngay trong lúc đang nạp đệm.
2. **Xử lý tương tác từ nút điều khiển của Player gốc (YouTube / Udemy):**
   - Lắng nghe ở `capture phase` trên phím tắt (`Space`, `K`) và thao tác click vào nút Play/Pause của trình phát gốc.
   - Nếu đang `isBuffering === true` (lúc thẻ `<video>` đang dừng) mà phát hiện thao tác dừng của người dùng hoặc trạng thái player ngoài bất định: ưu tiên cập nhật `intent = 'PAUSE'; userActionRevision++` (nguyên tắc an toàn: **khi không chắc chắn, tuyệt đối không tự động phát lại**).
3. **Điều kiện duy nhất được phép tự động Resume sau khi nạp xong cửa sổ đệm:**
   - Phải thỏa mãn đồng thời cả 4 điều kiện:
     1. `state.sessionId === capturedSession` (chưa có cú tua mới),
     2. `state.userActionRevision === capturedRevision` (người dùng không chạm nút dừng trong lúc chờ),
     3. `state.intent === 'PLAY'`,
     4. Tất cả segment bắt buộc trong cửa sổ đệm đầu (`requiredWindow`) đã `READY`.
   - Khi gọi `await video.play()`: bọc trong `try / catch`. Nếu Promise bị trình duyệt từ chối (`NotAllowedError` / `AbortError`), đặt `state.autoplayBlocked = true`, giữ nguyên dữ liệu đã chuẩn bị và hiện nút `"Bấm để tiếp tục phát lồng tiếng"`.

### 4.2. Quy tắc Tua giữa câu (`Mid-Segment Seek`) — Bảo toàn 100% giọng đọc
Loại bỏ quy tắc cũ chia cắt `35% / 70%` gây hổng logic và tự ý bỏ giọng đọc:
- **Chế độ mặc định cho MVP:** Khi người dùng tua tới bất kỳ mốc `seekVideoMs` nào nằm trong phạm vi một `SpeechSegment[k]` (`startMs <= seekVideoMs < endMs`), hệ thống **luôn phát trọn vẹn `SpeechSegment[k]` từ đầu** để bảo toàn đầy đủ ý tiếng Việt (`Invariant I1`), đồng thời giao cho `Speed Planner` (và chế độ giữ nhịp video nếu bật) xử lý độ lệch thời gian để không tụt xa so với hình.
- Chỉ khi người dùng chủ động kéo qua hẳn `Segment[k].endMs` mới bắt đầu từ `Segment[k+1]`.
- *(Ghi chú mở rộng sau MVP: Khi tích hợp provider có word-level alignment chính xác, mới bổ sung tùy chọn nâng cao phát từ cụm từ tương ứng với vị trí tua).*

### 4.3. Hàng đợi Ưu tiên khi Tua (`Urgent Window` vs `Background Fill`)
1. Sự kiện `seeking`: tăng `sessionId++`, ngắt ngay audio đang kêu trên loa, xóa timer debounce cũ.
2. Sau khi dừng kéo `200ms` (`seeked`): xác định `Segment[k]` chứa vị trí tua và kiểm tra cửa sổ đệm tối thiểu `[k, k+1]`.
   - Nếu chưa `READY`: vào `enterBuffering()`, đẩy `[k .. k+4]` lên đầu hàng đợi xử lý trước, bỏ qua mọi câu đã `READY` trong Cache.
   - Nếu từ điểm tua tới `Segment[k].startMs` là khoảng im lặng dài (`> 5 giây` chưa có lời thoại): cho video chạy bình thường trong lúc chuẩn bị ngầm `Segment[k]`; chỉ bật `Buffer Gate` nếu video chạm mốc `Segment[k].startMs` mà câu đó vẫn chưa xong.

---

## 5. Hệ Đồng Hồ Kép (`videoTimeMs` / `audioClockMs`) & Dự Báo Trễ 3–5 Câu

### 5.1. Phân tách rạch ròi 2 hệ quy chiếu thời gian
Mọi phép tính trong `Adaptive Sync Coordinator` cấm cộng trừ trực tiếp timestamp phụ đề với thời lượng audio khi chưa quy đổi qua `videoRate = video.playbackRate`:

- **`videoTimeMs` (Trục nội dung video):** Đơn vị của `segment.startMs`, `segment.endMs`, và `video.currentTime * 1000`. Khi `videoRate = 1.5×`, cứ `1000 ms` ngoài đời thực thì `videoTimeMs` tăng thêm `1500 ms`.
- **`audioClockMs` (Trục đồng hồ thực tế của bộ phát âm thanh):** Đơn vị của `AudioContext.currentTime * 1000` (hoặc `performance.now()`) và thời lượng phát thực tế của file WAV. Một file audio gốc dài `L = segment.audioDurationMs` phát ở tốc độ `effectiveSpeechRate` sẽ chiếm đúng:
  $$\text{actualAudioDurationClockMs} = \frac{L}{\text{effectiveSpeechRate}}$$

**Công thức ánh xạ chuẩn tại thời điểm lập lịch `(nowClockMs, currentVideoTimeMs, videoRate)`:**
1. Đổi mốc mục tiêu của câu `i` từ trục video sang trục đồng hồ thực:
   $$\text{targetStartClockMs}_i = \text{nowClockMs} + \frac{\text{segment}_i.\text{startMs} - \text{currentVideoTimeMs}}{\text{videoRate}}$$
2. Áp ràng buộc không chồng giọng trên trục `audioClockMs` (`Invariant I3`, với `minBreathGapMs = 60ms`):
   $$\text{actualStartClockMs}_i = \max(\text{targetStartClockMs}_i,\ \text{prevAudioEndClockMs} + 60)$$
3. Đổi hạn chót khả dụng của câu `i` (`usableEndVideoMs_i`, có tính khoảng nghỉ sau câu) sang trục đồng hồ thực:
   $$\text{usableEndClockMs}_i = \text{nowClockMs} + \frac{\text{usableEndVideoMs}_i - \text{currentVideoTimeMs}}{\text{videoRate}}$$
4. Quỹ thời gian thực tế dành cho audio câu `i`:
   $$\text{availableClockWindowMs}_i = \max(250,\ \text{usableEndClockMs}_i - \text{actualStartClockMs}_i)$$
5. Tốc độ đọc cần thiết và tốc độ áp dụng thực tế (`Invariant I4` — **chỉ truyền đúng 1 lần giá trị này vào bộ phát audio, không nhân thêm `videoRate`**):
   $$\text{neededRate}_i = \frac{\text{segment}_i.\text{audioDurationMs}}{\text{availableClockWindowMs}_i}$$
   $$\text{effectiveSpeechRate}_i = \text{clamp}(\text{quantize05}(\max(1.0,\ \text{neededRate}_i)),\ 1.0,\ \text{maxEffectiveSpeechRate})$$

> **Tái lập lịch tức thì:** Bất cứ khi nào phát sinh sự kiện `ratechange` (người dùng đổi tốc độ `1.0× ↔ 1.5×`), `seeked`, `pause`, hoặc hệ thống vừa nhả `Buffer Gate`, bộ điều phối hủy ngay lịch dự kiến của các câu chưa phát và tính lại từ đầu với cặp `(nowClockMs, currentVideoTimeMs, videoRate)` mới.

### 5.2. Dự báo Overflow nhìn trước `3–5 câu` (Chống trễ dây chuyền)
Thay vì đợi một câu bị trễ quá sâu mới phản ứng, `Speed Planner` mô phỏng nối tiếp cửa sổ `W = 3..5` câu sắp tới đã `READY` để tính **độ lệch tích lũy dự kiến (`predictedDriftClockMs`)** ngay cả khi đã tận dụng khoảng nghỉ giữa các câu.

Các ngưỡng can thiệp khởi điểm (sẽ tinh chỉnh qua benchmark thực tế):

| Độ lệch tích lũy dự kiến (`3–5 câu` tới) | Hành động điều phối |
| :--- | :--- |
| **`0 – 300 ms`** | Giữ tốc độ đọc tự nhiên `1.0×`, giữ nguyên tốc độ video. |
| **`300 – 800 ms`** | Tăng nhẹ tốc độ đọc trong dải dễ nghe (`1.05× – 1.25×`). |
| **`800 – 1.500 ms`** | Sử dụng tốc độ đọc tối đa cho phép (`~1.30×`), tận dụng khoảng nghỉ sau câu; nếu đang bật *Chế độ học tập (Ưu tiên đọc đủ)* thì chủ động hạ nhẹ `video.playbackRate` (ví dụ `0.85× – 0.90×` so với mức người dùng chọn). |
| **`Trên 1.500 ms`** | Trong *Chế độ học tập*, chủ động giữ nhịp / tạm dừng ngắn video ở ranh giới câu để audio xả hết nợ trễ trước khi vào câu mới. Trong chế độ *Giữ cứng nhịp video*, giữ nguyên tốc độ video và hiện cảnh báo lệch nhịp (tuyệt đối không cắt bỏ lời đọc). |

---

## 6. Phương Án TTS Theo Phần Cứng Thực Tế & Bảo Mật Local Service

### 6.1. Ma trận Engine TTS trung thực cho MVP (Đo Benchmark trước khi chốt mặc định)
Không giả định NVIDIA, AMD và Intel GPU chạy tương đương nhau và không cam kết cứng số phút khi chưa đo trên thiết bị thật:

| Phần cứng mục tiêu | Phương án kỹ thuật cho MVP | Ghi chú xác thực kỹ thuật |
| :--- | :--- | :--- |
| **CPU Local (Mặc định nền tảng cho mọi máy)** | **`VieNeu-TTS v3` (ONNX Runtime CPU / INT8)** hoặc TTS tiếng Việt nhẹ hơn (như `Piper vi_VN ONNX`) cho máy yếu | `VieNeu-TTS v3` hỗ trợ chính thức đường chạy ONNX Runtime không cần PyTorch trên CPU và đọc tốt thuật ngữ Anh–Việt; khóa `intra_op_threads = max(1, cores - 1)` để không làm giật trình duyệt. |
| **NVIDIA GPU** | **`VieNeu-TTS v3` (CUDA)** | Backend GPU chính thức của `VieNeu-TTS`; bật khi phát hiện CUDA khả dụng và qua bài test benchmark. |
| **AMD GPU (`RX 6800 XT` trên Windows)** | **Nhánh thử nghiệm (`Experimental Benchmark`):** Đo thực tế model ONNX tương thích trên `onnxruntime-directml` (1–2 session tuần tự, không mở 4–6 session gây tranh chấp hàng đợi DirectML) so sánh trực tiếp với `VieNeu-TTS ONNX CPU` | Chỉ bật profile DirectML nếu kết quả benchmark thực tế trên máy cho `RTF` và độ ổn định tốt hơn đường chạy CPU. Không chọn `Kokoro-82M` gốc làm mặc định do chưa hỗ trợ tiếng Việt chính thức. |
| **Cloud / Hybrid Fallback (Tùy chọn)** | Provider TTS qua interface chung (người dùng chủ động bật) | Phục vụ máy quá yếu không muốn tải CPU local. |

> **Nguyên tắc đo kiểm:** Mọi chỉ số về thời gian phản hồi câu đầu (`TTFB`), hệ số thời gian thực (`RTF`), % CPU/RAM và thời gian xử lý video 60 phút đều là **mục tiêu thử nghiệm** và sẽ được ghi nhận bằng script benchmark thực tế ở Mốc 1.

### 6.2. Bảo mật dịch vụ Local API trên `127.0.0.1`
Một server HTTP mở trên `localhost` nếu không bảo vệ có thể bị các trang web bất kỳ người dùng đang mở gọi lén từ trình duyệt (chiếm dụng CPU/GPU hoặc ghi rác ổ cứng):
1. **Bind cứng địa chỉ Loopback:** Chỉ lắng nghe trên `127.0.0.1` (cấm bind `0.0.0.0` ra mạng LAN).
2. **Kiểm tra `Origin` & `CORS` chặt chẽ:** Chỉ chấp nhận request từ `chrome-extension://<dubcera-extension-id>` (và origin trang test local khi bật cờ `DEV_SANDBOX=1`); từ chối thẳng (`403 Forbidden`) mọi `Origin` website bên ngoài.
3. **Xác thực bằng Token phiên (`X-DubCera-Token`):** Khi `tts-local` khởi động, sinh token ngẫu nhiên (hoặc đọc từ cấu hình cục bộ do người dùng cấp cho Extension) và bắt buộc đính kèm trong header mọi request `/v1/synthesize`, `/v1/cache/*`.
4. **Giới hạn đầu vào & Dung lượng:** Giới hạn độ dài văn bản mỗi request (ví dụ tối đa `1.000 ký tự`), giới hạn số job chờ tối đa trong queue và áp hạn mức dung lượng thư mục cache (`LRU Disk Quota`).

---

## 7. Checklist Nghiệm Thu Kiến Trúc Trước & Trong MVP

- [ ] **State & Session:** Bấm Pause/Play xen kẽ lúc đang `isBuffering`, hoặc khi `video.play()` bị trình duyệt từ chối, không bao giờ gây kẹt trạng thái hoặc tự phát lại trái ý người dùng.
- [ ] **Mid-Segment Seek:** Tua vào bất kỳ vị trí nào giữa câu đều đọc đầy đủ câu đó, không có khoảng trống phần trăm vô định, không âm thầm mất Voice.
- [ ] **Dual Clock (`1.0× ↔ 1.5×`):** Đổi tốc độ phát video không làm sai mốc câu kế tiếp và không nhân chồng tốc độ đọc hai lần vượt `maxEffectiveSpeechRate`.
- [ ] **Lookahead Overflow:** Chuỗi 10 câu dài liên tiếp được dự báo trước trên cửa sổ `3–5 câu` và phanh/điều tốc sớm, không để trễ tích lũy mất kiểm soát.
- [ ] **DisplayChunk UI:** Câu dịch dài 50 từ vẫn chỉ hiển thị gọn từng cụm 1–2 dòng trên video, không che khuất nội dung bài giảng.
- [ ] **Cache & Config Version:** Đổi giọng đọc khi đang gen dở không ghi đè nhầm vào manifest mới; các câu trùng nhau dùng chung `Singleflight` job.
- [ ] **Security `127.0.0.1`:** Request từ website lạ không có `Origin` hợp lệ và `X-DubCera-Token` bị chặn `403` ngay lập tức.
- [ ] **Hardware Benchmark:** Lựa chọn mặc định trên máy `i3-12100F + RX 6800 XT` dựa trên số đo `RTF` và chất lượng WAV thực tế.
