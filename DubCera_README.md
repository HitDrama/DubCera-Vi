# DubCera

> **AI-powered video translation and synchronized Vietnamese dubbing**  
> **Tagline:** *Every word. Perfectly synced.*  
> **Trạng thái:** Đặc tả định hướng / MVP chưa triển khai  
> **Loại dự án:** Chrome Extension + dịch vụ AI TTS chạy local (có thể mở rộng sang cloud)

---

## 1. DubCera là gì?

**DubCera** là dự án mã nguồn mở hướng tới việc **dịch và lồng tiếng video nước ngoài sang tiếng Việt ngay khi người dùng xem video trong trình duyệt**, bắt đầu từ YouTube và các khóa học Udemy có phụ đề khả dụng.

Người dùng không cần tải video về, biên tập lại video hay đợi xử lý toàn bộ video. DubCera đọc phụ đề (khi được phép truy cập), dịch sang tiếng Việt, tổng hợp giọng nói và phát tiếng Việt **đúng nhịp với video đang xem**.

Khác với công cụ chỉ hiển thị phụ đề dịch, DubCera ưu tiên trải nghiệm **nghe nội dung tiếng Việt**, giữ nguyên đầy đủ ý, lời đọc rõ ràng và không chồng câu.

### Trường hợp sử dụng chính

- Xem khóa học lập trình, Unity, game development trên Udemy bằng giọng tiếng Việt.
- Xem video hướng dẫn hoặc bài giảng tiếng Anh trên YouTube.
- Xem lại cùng một nội dung mà không cần dịch/TTS lại nếu bản cache vẫn hợp lệ.
- Về sau, mở rộng ngôn ngữ và các nền tảng phát video hợp lệ khác.

### Phạm vi MVP (phiên bản đầu tiên)

**Bắt buộc:** video có phụ đề tiếng gốc lấy được hợp lệ hoặc người dùng nhập file `.vtt` / `.srt`.

**Chưa bắt buộc:** video không có phụ đề, nhận dạng tiếng nói trực tiếp (ASR/STT), dịch trực tiếp cuộc họp, clone giọng người nói, xử lý nhiều người nói, xuất video đã lồng tiếng.

Lưu ý: "realtime" ở MVP chủ yếu là **phát lồng tiếng đồng bộ khi xem**, nhờ **xử lý trước các câu sắp phát** (lookahead/prefetch); không có nghĩa mọi câu được dịch từ âm thanh tức thì, không độ trễ.

---

## 2. Mục tiêu và thứ tự ưu tiên

### 2.1. Mục tiêu sản phẩm

1. **Bảo toàn nội dung:** không cố ý bỏ câu, bỏ ý hoặc cắt đuôi audio để ép khung thời gian.
2. **Không chồng giọng:** chỉ có một luồng lời đọc tiếng Việt được phát tại một thời điểm.
3. **Dễ nghe, tự nhiên:** phát câu hoàn chỉnh; điều chỉnh tốc độ trong phạm vi phù hợp thay vì đọc quá nhanh.
4. **Độ trễ cảm nhận thấp:** chuẩn bị bản dịch và âm thanh trước mốc phát, giảm thời gian chờ.
5. **Đồng bộ hình – tiếng:** giữ giọng Việt gần với thời điểm diễn ra nội dung trong video; xử lý tốt play/pause/seek.
6. **Ổn định và tiết kiệm:** cache hợp lệ, không gọi TTS lại không cần thiết, có cơ chế phục hồi khi lỗi.
7. **Dễ phát triển:** MVP chỉ cần những module cốt lõi; mở rộng Live Mode sau.

### 2.2. Các ưu tiên khi có xung đột

**Không mất nội dung > không chồng giọng > chất lượng nghe > đồng bộ sát hình > tốc độ phát bằng 1×.**

Nếu một câu tiếng Việt cần 6 giây nhưng khoảng video tương ứng chỉ có 3 giây, không thể đồng thời đọc đầy đủ, không tăng tốc quá mức, không phát chồng và không thay đổi nhịp video. DubCera phải **xử lý xung đột có chủ đích**: tận dụng khoảng nghỉ sau câu, tăng tốc vừa phải, sau đó giảm tốc/tạm dừng video nếu người dùng cho phép. Không cắt âm thanh để che lỗi.

### 2.3. Mục tiêu thử nghiệm ban đầu (không phải cam kết)

| Hạng mục | Mục tiêu MVP |
|---|---|
| Video có sub, đã prefetch | Audio sẵn sàng trước mốc cần phát ở phần lớn câu |
| Sai lệch bắt đầu câu | Cố gắng trong khoảng ±150–300 ms khi tài nguyên đủ và không có xung đột timeline |
| Tốc độ audio | Ưu tiên 1.0×; thử nghiệm tối đa ~1.30× với bảo toàn cao độ |
| Lookahead | Bắt đầu thử với 15–30 giây phụ đề tiếp theo |
| Thời gian chạy | Kiểm thử liên tục 60–120 phút, không tăng bộ nhớ bất thường |
| Không cắt âm thanh | 100% các câu được phát không dùng thao tác cắt đuôi để fit slot |
| Không overlap | 0 lần chồng hai đoạn lời đọc trong một hàng phát |

Các chỉ số sẽ được đo thực tế trên thiết bị; không mặc định rằng mọi video đều đạt độ trễ gần bằng 0.

---

## 3. Nguyên lý hoạt động

```text
Trang video (YouTube / Udemy / HTML5)
                 │
                 ▼
       Subtitle Adapter / Parser
         (.vtt, .srt, cues)
                 │
                 ▼
       Sentence / Segment Grouper
    (ghép các cue bị cắt giữa câu)
                 │
                 ▼
        Translation Provider
    (dịch có ngữ cảnh + glossary)
                 │
                 ▼
      Speech Generator (TTS)
   (tạo audio + đo độ dài thật)
                 │
                 ▼
      Adaptive Speed Planner
 (tốc độ + tận dụng khoảng nghỉ)
                 │
                 ▼
      Single Audio Scheduler
 (phát tuần tự, đồng bộ với video)
                 │
                 ▼
    Người xem nghe giọng tiếng Việt
```

**Các công đoạn chuẩn bị chạy bất đồng bộ và có thể chồng lấp việc tính toán** (đang phát câu N thì chuẩn bị N+1, N+2...), nhưng **đầu ra âm thanh được phát theo thứ tự và không chồng giọng**.

### 3.1. Phụ đề được lưu như thế nào?

Một file `.vtt`/`.srt` gồm các **cue**: thời gian bắt đầu, kết thúc và nội dung chữ.

```vtt
WEBVTT

00:00:01.000 --> 00:00:03.000
First, we need to create

00:00:03.000 --> 00:00:05.000
a new GameObject and

00:00:05.000 --> 00:00:07.000
add a particle system.
```

Các cue trên thực ra là **một câu nói**; nếu dịch/TTS từng cue độc lập sẽ dễ ngắt giọng giữa câu và sai ngữ cảnh. Vì vậy, phải **giữ nguyên cue gốc** và đồng thời tạo `SpeechSegment` gồm những cue có liên quan.

```ts
interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
}

interface SpeechSegment {
  id: string;
  sourceCueIds: string[];
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText?: string;
  audioDurationMs?: number;
  audioRef?: string;
  status: 'pending' | 'translating' | 'synthesizing' | 'ready' | 'error';
}
```

### 3.2. Quy tắc ghép câu

- Ghép những cue tạo thành một câu hoặc cụm ý; xét dấu câu, khoảng nghỉ và cấu trúc ngữ pháp.
- **Không đơn giản nối tất cả cue liên tiếp**: phải tránh ghép qua hai người nói hoặc ngắt ý lớn.
- Nếu không đủ ngữ cảnh để ghép chắc chắn, ưu tiên cách ghép bảo thủ, cho phép hiệu chỉnh về sau.
- Luôn giữ liên kết `sourceCueIds`, `startMs`, `endMs` để tua video và đồng bộ.
- Dịch theo nhóm câu với ngữ cảnh của những câu lân cận; giữ thuật ngữ chuyên ngành khi cần, ví dụ `GameObject`, `Shader Graph`, `Particle System`.

### 3.3. Tạo âm thanh

- TTS nhận văn bản tiếng Việt hoàn chỉnh và `voiceId` đã chọn.
- Tạo **audio gốc không bị cắt**; có thể tạo dạng streaming/chunk để chuẩn bị sớm.
- Đo thời lượng audio **thực tế**; không chỉ suy đoán từ số từ.
- Lưu audio gốc vào cache; các bản thay đổi tempo được xử lý riêng, không ghi đè bản gốc.
- Không coi một file WAV có kích thước trên 44 byte là đủ hợp lệ; phải kiểm tra file đã ghi xong, header, thời lượng và khả năng giải mã.

---

## 4. Thuật toán tối giản: Adaptive Speed + Sequential Scheduling

Chỉ cần **một bộ lập kế hoạch tốc độ có lookahead** và **một hàng phát tuần tự**.

### 4.1. Đầu vào của mỗi segment

- `startMs`, `endMs`: khoảng thời gian của nội dung trong video.
- `audioDurationMs`: thời lượng TTS ở tốc độ tự nhiên.
- `next.startMs`: thời điểm câu sau bắt đầu.
- `playbackTimeMs`: thời gian video đang phát.
- `maxSpeechRate`: trần tốc độ dễ nghe, mặc định thử `1.30`.

### 4.2. Logic đơn giản

1. **Ưu tiên chuẩn bị trước:** nếu có phụ đề phía trước, dịch + tạo giọng trước 15–30 giây.
2. **Nhìn trước một số câu:** không bắt buộc ép mỗi câu vào `endMs - startMs`; xét khoảng nghỉ sau câu.
3. **Chọn tốc độ thấp nhất đủ dùng:** bắt đầu 1.0×; nếu cần, tăng dần (ví dụ 1.05×, 1.10×...) nhưng không vượt giới hạn chất lượng.
4. **Chỉ phát sau câu trước:** `actualStart = max(targetStart, previousActualEnd)`.
5. **Khi vẫn không đủ thời gian:** sử dụng khoảng nghỉ hợp lệ; nếu quá tải kéo dài, giảm tốc/tạm dừng video (khi được bật). Nếu không được phép, chấp nhận độ lệch và báo trạng thái — **không cắt lời**.
6. **Khi seek:** dừng audio cũ, tăng `playbackSessionId`, lập lại kế hoạch từ vị trí mới; kết quả async phiên cũ không được phát nhầm.

Ví dụ:

| Segment | Khung video | Audio tốc độ 1.0× | Hướng xử lý |
|---|---:|---:|---|
| A | 0–3s | 4.0s | Có thể tăng lên 1.2×, mượn ~0.33s sau mốc 3s |
| B | 3–6s | 1.0s | Phát sau A, khoảng rảnh còn lại giúp bù trễ |
| C | 6–10s | 5.0s | Tăng lên ~1.25× để khớp 4s |

Ví dụ này minh họa nguyên tắc, không bảo đảm khớp mọi loại video. Một số cảnh thao tác yêu cầu bám mốc sát hơn; một số đoạn giảng lý thuyết có thể chịu lệch tốt hơn.

### 4.3. Bất biến bắt buộc (Invariants)

```text
I1. Không xóa / bỏ segment chỉ vì quá dài.
I2. Không cắt phần cuối PCM để ép vào thời lượng cue.
I3. Với một voice track, segment sau không phát chồng segment trước.
I4. Tốc độ hiệu dụng cuối cùng không vượt maxSpeechRate.
I5. Cache phải bị vô hiệu khi text / voice / model / cấu hình audio thay đổi.
I6. Play / Pause / Seek phải đồng bộ với trạng thái phát tiếng Việt.
I7. Lỗi một segment không được âm thầm làm biến mất nội dung.
```

### 4.4. Trường hợp bất khả thi

Nếu có quá nhiều nội dung cần đọc liên tục, **không tồn tại thuật toán nào** đồng thời đảm bảo đọc đủ, giữ tốc độ tự nhiên, không overlap và không bị trễ mà **không điều chỉnh thời gian của video**. Vì thế tính năng tùy chọn `Auto Slow/Pause` là biện pháp cuối để bảo toàn nội dung.

---

## 5. Bốn module cốt lõi của MVP

### Module A — Subtitle Input

**Nhiệm vụ:** lấy/nhập `.vtt` hoặc `.srt`, chuẩn hóa timestamp, tạo cue và nhóm câu.  
**Đầu ra:** `SpeechSegment[]` có nguồn gốc rõ ràng.

### Module B — Translation & TTS

**Nhiệm vụ:** dịch nhóm câu có ngữ cảnh; tạo WAV/PCM; đo thời lượng thật; cache theo text, voice, model, speed/config.  
**Đầu ra:** các segment `ready` kèm audio hợp lệ.

- Provider dịch có thể là Chrome Translator API (nếu cặp ngôn ngữ/thiết bị được hỗ trợ), local AI hoặc API cloud.
- TTS thử nghiệm: **VieNeu-TTS / ZeroTTS**, benchmark trên máy thực tế trước khi chọn mặc định.
- Web Speech API có thể là fallback, nhưng giọng Việt và chất lượng tùy hệ điều hành/trình duyệt.

### Module C — Adaptive Speed Planner

**Nhiệm vụ:** so thời lượng audio với cửa sổ thời gian có thể dùng, xét những segment kế tiếp; chọn tốc độ hợp lý; không chồng nhiều lần tăng tốc ngoài giới hạn.  
**Đầu ra:** kế hoạch phát `{segmentId, targetStartMs, speed, expectedEndMs}`.

### Module D — Audio Scheduler / Player Bridge

**Nhiệm vụ:** phát một voice track theo timeline video; xử lý `play`, `pause`, `seek`, đổi tốc độ video; giảm âm lượng tiếng gốc khi lồng tiếng; ngăn phát lại chunk lỗi thời.  
**Đầu ra:** người xem nghe lời Việt đúng thứ tự, không overlap.

> **Phân biệt:** nhiều tác vụ TTS có thể được chuẩn bị song song, nhưng chỉ có **một bộ điều phối phát** quyết định audio nào được nghe tại một thời điểm.

---

## 6. Stack và cấu trúc repository đề xuất

| Phần | Công nghệ |
|---|---|
| Extension | WXT + TypeScript |
| UI | React (tùy chọn) |
| Subtitle | Parser WebVTT/SRT riêng hoặc thư viện phù hợp |
| Dịch | Provider interface, có thể đổi local / browser / cloud |
| TTS | Python + FastAPI chạy `localhost`, hoặc nhà cung cấp TTS khác |
| Audio | Web Audio API / HTMLAudioElement; time-stretch giữ pitch |
| Lưu cache metadata | IndexedDB trong extension |
| Lưu audio local | File system của dịch vụ TTS local hoặc cache thích hợp |
| Kiểm thử | Unit tests + integration test với video HTML5 giả lập |

```text
dubcera/
├─ README.md                    # Tài liệu này
├─ apps/
│  └─ extension/
│     ├─ entrypoints/           # Background, content script, popup
│     └─ src/
│        ├─ subtitles/          # Parser + adapters + grouping
│        ├─ translation/        # Interface và các provider
│        ├─ tts/                # Giao tiếp dịch vụ giọng nói
│        ├─ scheduler/          # Speed planner + audio queue
│        ├─ player/             # Play/Pause/Seek + âm lượng
│        └─ storage/            # IndexedDB + metadata
├─ services/
│  └─ tts-local/                # Python FastAPI + model TTS
├─ packages/
│  └─ shared/                   # Types, contracts, events
└─ tests/
   ├─ fixtures/                 # Mẫu VTT/SRT và WAV
   └─ integration/
```

**Ghi chú:** cấu trúc trên là đề xuất định hướng, chưa phải các thư mục đã được tạo hay mã nguồn đã chạy.

---

## 7. Cách vận hành từ góc nhìn người dùng

1. Người dùng mở video được hỗ trợ.
2. Bật DubCera → chọn ngôn ngữ đích **Tiếng Việt** và giọng đọc.
3. DubCera kiểm tra phụ đề có thể truy cập không.
4. Nếu có: phân đoạn, dịch, tổng hợp tiếng Việt cho phần sắp phát.
5. Khi câu chuẩn bị xong, extension phát theo thời gian video và giảm tiếng gốc phù hợp.
6. Khi người dùng tạm dừng hoặc tua, DubCera điều chỉnh/hủy lịch phát ngay.
7. Nếu nội dung quá dày: tăng tốc giọng đọc trong giới hạn; có thể giảm/tạm dừng video khi bật chế độ bảo toàn nội dung.
8. Khi đã xử lý trước đó, sử dụng cache đúng cấu hình để giảm CPU/API và tăng tốc khởi động.

### UI tối thiểu

- On/Off lồng tiếng.
- Chọn ngôn ngữ và giọng đọc.
- Điều chỉnh tốc độ giọng cơ bản hoặc chế độ **Auto**.
- Chọn chế độ `Giữ tốc độ video` / `Ưu tiên đọc đủ (cho phép video chậm/tạm dừng)`.
- Trạng thái `Đang chuẩn bị`, `Sẵn sàng`, `Đang phát`, `Thiếu phụ đề`, `Lỗi`.

---

## 8. Cache và xử lý lỗi

- Lưu bản dịch theo nội dung gốc + ngôn ngữ + provider/model hoặc version prompt/glossary.
- Lưu audio theo nội dung tiếng Việt chuẩn hóa + voiceId + model version + thông số tổng hợp.
- Dùng hash ổn định (ví dụ SHA-256) để định danh cache; không chỉ dựa vào tên file.
- Audio gốc và audio đã time-stretch là hai artifact khác nhau.
- Một cue chưa dịch xong **không chặn toàn bộ video**; nhưng không âm thầm nhảy qua nội dung. Có thể chờ, hiển thị phụ đề dịch, hoặc báo lỗi rõ ràng.
- TTS không sẵn sàng: thử lại có giới hạn trước hạn phát; không retry vô hạn trên luồng realtime.
- Nếu file lỗi/corrupt: xóa cache lỗi và xử lý lại khi phù hợp.
- Giới hạn RAM, số worker và lượng audio nhìn trước; ưu tiên segment gần vị trí phát.

---

## 9. Lộ trình phát triển

### Giai đoạn 1 — MVP core không phụ thuộc website

- Player HTML5 dùng video thử nghiệm và phụ đề mẫu `.vtt`/`.srt`.
- Parser + grouping + translation provider + TTS local.
- Audio Scheduler đọc đủ câu, không overlap; hỗ trợ play/pause/seek.
- Thử nghiệm các trường hợp phụ đề dài/ngắn xen kẽ.

**Tiêu chí hoàn thành:** một video thử nghiệm dài có thể lồng tiếng theo thứ tự; không cắt đuôi; không phát nhầm sau seek.

### Giai đoạn 2 — Chrome Extension YouTube

- Kết nối với player YouTube và các phụ đề khả dụng một cách hợp lệ.
- Prefetch + cache + UI popup.
- Kiểm thử thay đổi tốc độ, tua liên tục, mất kết nối dịch vụ TTS.

### Giai đoạn 3 — Udemy

- Viết adapter riêng cho player và phụ đề Udemy nếu người dùng có quyền truy cập.
- Kiểm thử thuật ngữ chuyên ngành và bài giảng dài.
- Không cố vượt DRM, hạn chế truy cập hay bảo vệ nội dung.

### Giai đoạn 4 — Live Mode (không có phụ đề)

- Chrome tab audio capture (nếu được cấp quyền) → streaming ASR → dịch → TTS → scheduler.
- Chỉ phát những kết quả nhận dạng đã đủ ổn định, tránh đọc nhầm kết quả ASR tạm.
- Chấp nhận độ trễ dịch trực tiếp có thể vài giây hoặc hơn; tối ưu sau khi đo thật.

### Giai đoạn 5 — Nâng cao (tùy nhu cầu)

- Đa ngôn ngữ, nhiều giọng/nhiều người nói, glossary theo chủ đề.
- Kiểm thử chất lượng TTS có dùng ASR đối chiếu trong chế độ QA.
- Export bản dịch/audio nếu quyền sử dụng nội dung cho phép.

---

## 10. Checklist kiểm thử quan trọng

- [ ] Cue bị chia giữa câu vẫn được ghép và đọc tự nhiên.
- [ ] Câu dài hơn slot được đọc đủ; không dùng hard clip PCM.
- [ ] Câu sau không chồng câu trước, kể cả lúc bị trễ.
- [ ] Không áp dụng tốc độ hai lần dẫn tới vượt trần.
- [ ] Play/Pause/Seek liên tục không gây phát lại audio của phiên cũ.
- [ ] Video chuyển 1× ↔ 1.5× được đồng bộ lại phù hợp.
- [ ] Cache invalidation đúng khi đổi chữ, giọng, model hay cấu hình.
- [ ] Một câu thiếu bản dịch không bị im lặng bỏ qua.
- [ ] TTS lỗi hoặc server local tắt → trạng thái rõ ràng, không làm hỏng video gốc.
- [ ] Kiểm tra giọng bị nuốt từ/đọc lặp/đọc sai, không chỉ kiểm tra WAV dài bao nhiêu.
- [ ] Video dài 60–120 phút không rò rỉ RAM hoặc tăng hàng đợi vô hạn.
- [ ] Trình duyệt/nền tảng không cho truy cập phụ đề → báo không hỗ trợ, không vượt cơ chế bảo vệ.

---

## 11. Nguyên tắc dành cho AI Agent phát triển DubCera

1. **Làm đúng MVP trước:** không tự thêm backend cloud, đăng nhập, thanh toán hoặc các chức năng ngoài phạm vi.
2. **Giữ code tách module:** subtitle, translation, TTS, planner, scheduler, player bridge và cache không phụ thuộc vòng tròn.
3. **Không làm mất chữ để giảm trễ:** cấm cắt đuôi WAV/PCM, bỏ cue, bỏ chunk hoặc ép tăng tốc quá giới hạn chất lượng để đạt timestamp.
4. **Không đánh đồng cue với câu nói:** luôn giữ dữ liệu cue gốc và nhóm câu riêng.
5. **Audio integrity và timing là hai thứ khác nhau:** WAV hợp lệ chưa chắc đọc đủ; câu dài hơn slot chưa chắc lỗi.
6. **Thay đổi phải đi cùng test:** đặc biệt kiểm thử scheduling, tốc độ hiệu dụng, seek, pause và cache.
7. **Ưu tiên đo thực tế thay vì giả định:** log thời gian dịch, thời gian tới audio chunk đầu, thời lượng TTS, drift, underrun, CPU/RAM.
8. **Bảo đảm quyền truy cập:** chỉ xử lý nội dung người dùng được phép truy cập và không tìm cách vô hiệu hóa DRM.
9. **Không hứa độ trễ tuyệt đối bằng 0:** giải thích rõ trade-off nếu nội dung tiếng Việt cần nhiều thời gian hơn lời gốc.
10. **Mọi provider có interface thay thế được:** có thể chuyển từ local TTS sang cloud hoặc ngược lại mà không viết lại scheduler.

---

## 12. Kết luận

**DubCera không chỉ là công cụ đọc phụ đề bằng giọng AI.** Điểm cốt lõi của dự án là **phân đoạn lời nói, dịch đúng ngữ cảnh, tạo giọng tiếng Việt và điều phối thời gian đọc một cách thông minh**.

Định hướng MVP là **đơn giản nhưng đúng bản chất**: bốn module trọng tâm, xử lý trước khi có phụ đề, chỉ một hàng phát âm thanh, và ưu tiên **đọc đủ – không chồng – dễ nghe – độ trễ thấp**. Realtime ASR cho video không có phụ đề là hướng phát triển tiếp theo, không phải điều kiện để có bản đầu tiên hữu ích.
