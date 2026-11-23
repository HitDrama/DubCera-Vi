# Subcara — FastTrackTutorials Integration & Auto Theater Mode

**Loại tài liệu:** Implementation brief cho Coding Agent  
**Mục tiêu:** Thêm FastTrackTutorials vào Subcara, đọc CC tiếng Anh để **dịch và chuẩn bị voice trước khi phát**, đồng thời tự động mở rộng video **trong vùng nội dung của tab trình duyệt**, không bật fullscreen hệ điều hành/trình duyệt.  
**Phạm vi:** Chrome/Edge extension hiện tại. **Không viết lại** hệ thống dịch, tạo TTS, voice cache hay logic đồng bộ đang hoạt động.

---

## 1. Bối cảnh và yêu cầu thực tế

Người dùng học các khóa tại `https://fasttracktutorials.com/` thông qua Membership. Khi bấm **Watch**, video mở trong cửa sổ/popup nhỏ. Người dùng muốn:

1. Subcara **tự phát hiện** video/bài học mới, không nhập Bunny ID thủ công.
2. **Lấy toàn bộ phụ đề tiếng Anh cùng timestamp** ngay khi có sẵn, thay vì ASR/Whisper hay phụ thuộc phụ đề hiện trên màn hình.
3. **Tái sử dụng thuật toán hiện có** để dịch, gộp câu nếu cần, pre-generate giọng đọc TTS, cache và phát theo timeline.
4. **Auto Theater Mode:** mở video chiếm ~90–96% diện tích khả dụng **trong tab**, căn giữa, 16:9, nền tối, không che thanh tab/thanh địa chỉ Chrome/Edge.
5. Hỗ trợ đóng/thu nhỏ hoặc `Esc` để trả giao diện gốc; **không reload iframe** và không mất thời gian xem/phụ đề.
6. Không làm hỏng tích hợp các nền tảng khác trong Subcara.

**Nguyên tắc:** Giao diện video và đọc phụ đề là **hai tác vụ độc lập**, có thể triển khai/kiểm thử riêng.

## 2. Thông tin đã xác minh thực tế (không phải suy đoán)

### 2.1. Cấu trúc trình phát

- Trang chính: `fasttracktutorials.com`.
- Trình phát nhúng trong cross-origin iframe: `iframe.mediadelivery.net` (Bunny Stream, giao diện Plyr).
- Trong ngữ cảnh iframe, có thẻ `<video id="main-video">`.
- Thẻ video có `data-plyr-config` chứa tiêu đề bài, nguồn HLS `.m3u8` và các `<track kind="captions">`.
- Đã thấy `<track srclang="en" label="English" src=".../captions/EN.vtt?ver=1">`; còn có Spanish và Chinese.
- Ví dụ bài: `02-Starting The Blockout.mp4`, `03 Continuing The Blockout.mp4`. **Mỗi bài có định danh/đường dẫn asset khác nhau**. Tuyệt đối không hardcode ID/URL được thấy khi debug.

### 2.2. Phụ đề đã được đọc thành công

Tại **iframe Bunny** của bài `02-Starting The Blockout.mp4`, Developer Tools cho kết quả:

```text
hostname: iframe.mediadelivery.net
Video: true
Tracks: 3
English cues: 522
```

Đã trích xuất mảng **522 cue** qua `video.textTracks`, với các trường `startMs`, `endMs`, `sourceText`. Ví dụ cue đầu: `startMs: 330`, `endMs: 2450`, `sourceText: "So in this video we're going to be"`.

**Kết luận được phép rút ra:** Trình phát trên bài thử nghiệm có phụ đề tiếng Anh **dạng text, có timestamp**, đọc được từ JS chạy trong đúng iframe. **Không cần ASR** đối với bài có CC theo cách này.

**Chưa xác minh:** Extension MV3 hiện tại đã đọc được trong thực tế; mọi bài đều có phụ đề đầy đủ; tất cả cue sẵn ngay lúc video tạm dừng tại 0 giây; điều kiện pháp lý của việc lưu/đồng bộ file VTT. Những điều này cần kiểm thử hoặc xem điều khoản.

### 2.3. Lỗi đã gặp khi thử Console

- `document.querySelectorAll('video').length === 0` khi Console ở `fasttracktutorials.com` là **bình thường**: video nằm trong iframe nguồn khác.
- Chuyển JavaScript execution context sang `iframe.mediadelivery.net` thì đã thấy `#main-video`, `textTracks`, 522 cue.
- Nhiều script Theater Mode chạy từ Console báo **`Không tìm thấy Bunny Player`**. Nguyên nhân chưa được chẩn đoán chính xác: có thể chạy ở context sai, iframe ẩn/đang thay, iframe lồng trong frame FastTrack trung gian, hoặc bộ lọc `src`/kích thước không khớp. **Không được khẳng định một nguyên nhân duy nhất khi chưa đo đạc.**
- Các request `500b.jpg ... ERR_NAME_NOT_RESOLVED` là lỗi telemetry được quan sát, **chưa có bằng chứng** chúng gây lỗi caption/theater.
- URL `.dts` có `Content-Type: video/mp2t` là **video segment**, không phải VTT.

---

## 3. Công việc A — FastTrack Caption/Player Adapter

### 3.1. Tự phát hiện, không nhập ID thủ công

- Trên trang FastTrack, phát hiện khi người dùng nhấn **Watch** / khi popup và player iframe được tạo.
- Có thể có **nhiều iframe** (YouTube preview, FastTrack iframe trung gian, Bunny iframe). Chỉ gắn vào player đang hoạt động, không chọn iframe đầu tiên một cách mù quáng.
- Trong Bunny iframe, tìm `video#main-video` và ngôn ngữ `en` từ `video.textTracks` hoặc `track[srclang="en"]`.
- Dùng observer/lifecycle phù hợp để phát hiện khi player tải muộn, chuyển bài hoặc thay iframe. Cleanup listener khi video hoặc iframe bị hủy.

### 3.2. Đọc cue nguồn

Ví dụ giao diện dữ liệu mà adapter trả về (map sang schema Subcara **thực tế** nếu khác):

```ts
type SourceCue = {
  id: number | string;
  startMs: number;
  endMs: number;
  sourceText: string;
};
```

Đọc từ `TextTrack.cues` sau khi track có dữ liệu. Giữ thứ tự/timestamp, lọc cue trống, xử lý HTML/entity nếu cần, và đảm bảo không tạo cue trùng.

```js
// Chỉ là đoạn tham khảo bên trong Bunny iframe, không phải implementation hoàn chỉnh.
const video = document.querySelector('video#main-video');
const en = [...(video?.textTracks ?? [])].find(t => t.language === 'en');
if (en) en.mode = 'hidden'; // tải cue mà không hiển thị CC gốc
const cues = [...(en?.cues ?? [])].map((cue, index) => ({
  id: index,
  startMs: Math.round(cue.startTime * 1000),
  endMs: Math.round(cue.endTime * 1000),
  sourceText: cue.text
}));
```

**Đừng dùng `.plyr__caption` làm nguồn chính:** Nó chỉ chứa text của caption **đang hiện**, không đảm bảo có đủ cue và timestamp của toàn bài.

**Quan trọng:** `mode = 'hidden'` có thể thay đổi trạng thái hiển thị CC của người dùng. Trong sản phẩm thật, ưu tiên giữ nguyên lựa chọn của họ nếu có thể hoặc khôi phục trạng thái ban đầu; đảm bảo track tải xong trước khi kết luận `0 cue`.

### 3.3. Pre-Generate Voice và cache

- Khi đã có **đủ cue**, gửi sang đúng pipeline dịch + TTS hiện có của Subcara, không tự xây dịch/TTS mới trong adapter.
- **Cho phép chuẩn bị voice trước khi Play**. Thử nghiệm: mở bài, pause gần 0 giây, đọc track English, kiểm tra cue cuối/độ dài, sau đó pre-generate.
- Sử dụng chính cơ chế ghép cue thành câu, kiểm tra nội dung không rỗng, voice ID/hash text, incremental regenerate và cache của dự án (nếu đã có). **Không giả định 1 cue = 1 câu hoàn chỉnh.**
- Khóa cache dựa trên **ID bài/video ổn định + phiên bản/hash nội dung CC + ngôn ngữ đích + cấu hình voice/TTS**. Không dùng blob URL (`blob:https://...`) làm ID cache vì thay đổi giữa phiên.
- Khi phát lại cùng bài với cùng nội dung/cấu hình, sử dụng cache, tránh dịch/gen lại không cần thiết.
- Cần báo trạng thái rõ: đang lấy CC, đang dịch, đang chuẩn bị voice, sẵn sàng; lỗi có tùy chọn thử lại.
- Tái sử dụng engine sync hiện tại cho `play`, `pause`, `seeked`, `ratechange`, chuyển bài. Voice tiếng Việt dài hơn câu gốc vẫn phải được engine xử lý, không coi pre-gen là tự giải quyết mọi lệch nhịp.

### 3.4. Chrome/Edge extension — cách tổ chức

- Khảo sát `manifest.json`, host permissions, content scripts và message bus hiện có **trước khi sửa**.
- Một thành phần ở trang FastTrack để phát hiện popup + điều khiển Theater Mode.
- Một thành phần chạy trong các iframe Bunny được phép của tab để đọc `video.textTracks`/thời gian video.
- Cân nhắc `all_frames: true` / `match_about_blank` nếu thực sự cần, và quyền host phù hợp cho `fasttracktutorials.com` và `iframe.mediadelivery.net`.
- Giao tiếp frame → background/service worker → UI/engine Subcara bằng runtime messaging đang có. Tuân thủ same-origin policy, không cố đọc DOM cross-origin trực tiếp từ top frame.
- Hạn chế quyền extension vào đúng các host cần thiết, xử lý iframe không khớp và tránh duplicate events.
- Không can thiệp DRM, không tải/sao chép video stream, không gửi cookie/token cho service không liên quan. Chỉ dùng phụ đề khả dụng trong phiên học mà người dùng có quyền truy cập, phù hợp điều khoản dịch vụ.

---

## 4. Công việc B — Auto Theater Mode trong **viewport**, không Fullscreen

### 4.1. UX bắt buộc

- Sau khi bấm **Watch**, popup video **tự mở rộng trong phần nội dung của tab**, tối đa khoảng **94–96vw × 90–94vh**, giữ **aspect-ratio: 16 / 9** (hoặc tự nhận từ video), căn giữa.
- Vẫn nhìn thấy **tab trình duyệt, thanh URL, extension toolbar**; **không gọi `requestFullscreen()`**, không ép F11.
- Nền tối, thanh điều khiển video vẫn thao tác bình thường, overlay thuyết minh Subcara không bị che.
- Có nút thu nhỏ/đóng; `Esc` cũng khôi phục giao diện. Không bắt buộc dùng backdrop có click-to-close vì có thể vô tình làm mất bài đang xem.
- **Không tạo iframe mới, không thay `src`, không di chuyển iframe sang cây DOM khác** nếu có thể. Chỉ chỉnh bố cục của **modal/container chứa iframe**, giữ playback/caption state nguyên vẹn.
- Thay đổi kích thước theo `resize`; tránh che UI Subcara, lỗi z-index, scroll lock và clipping; khôi phục **đúng** trạng thái CSS, focus, scroll ban đầu.
- Bật/tắt được trong Settings, mặc định có thể bật cho FastTrack riêng (không ảnh hưởng site khác).

### 4.2. Chẩn đoán lỗi `Không tìm thấy Bunny Player`

**Không tiếp tục chỉ thay selector rồi đoán.** Trước tiên agent phải xem DOM thực tế khi popup đã mở:

1. Tại **top frame**, liệt kê iframe (`src`, `getBoundingClientRect`, `display`, `visibility`, `closest dialog/modal`).
2. Kiểm tra iframe Bunny nằm trực tiếp trong top DOM hay nằm trong iframe FastTrack trung gian; top frame **không thể** đọc cây DOM của iframe khác origin.
3. Xác định chính xác **container modal** đang giới hạn chiều rộng/chiều cao (`max-width`, `max-height`, `transform`, `overflow`, `position`, `z-index`).
4. Resize **container phù hợp** thay vì chỉ style iframe. Trường hợp popup bị tạo trong same-origin nested iframe, triển khai layout controller ở đúng frame mà extension có quyền tác động, hoặc xử lý container cha theo message giữa các frame.
5. Nếu không thấy Bunny iframe vì chưa được tạo, quan sát DOM rồi retry khi user nhấn Watch; nếu có nhiều Bunny iframe, chọn cái thuộc bài đang xem.

**Không nên** áp dụng hàng loạt `transform:none`, `filter:none`, `position:relative` lên **mọi ancestor tới `<html>`**; điều này dễ phá layout trang và tạo lỗi stacking context.

### 4.3. Ví dụ CSS định hướng, không phải selector cuối cùng

```css
/* Gắn class vào modal thực tế mà agent khảo sát được */
.subcara-ft-theater-modal {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483000 !important;
  display: grid !important;
  place-items: center !important;
  background: rgba(0, 0, 0, 0.94) !important;
}

.subcara-ft-theater-player {
  width: min(96vw, calc(92vh * 16 / 9)) !important;
  aspect-ratio: 16 / 9;
  height: auto !important;
  max-width: none !important;
  max-height: 92vh !important;
  border: 0;
}
```

**Lưu ý:** Selector/class ở trên chỉ là ví dụ. Agent phải tìm cấu trúc modal thực tế và đảm bảo tỷ lệ iframe tính đúng, không ép `height:auto` nếu iframe/player cần kích thước CSS xác định để hoạt động. Ưu tiên CSS class có thể bật/tắt, kèm snapshot style trước khi sửa để cleanup.

---

## 5. Thứ tự triển khai đề xuất

1. **Inspect repo**: xem kiến trúc adapter, message bus, TTS pre-generation và cache sẵn có; lập sơ đồ luồng tối thiểu.
2. **Caption PoC**: tự nhận video Bunny, lấy cue + timestamp trong content script (không cần mở DevTools), gửi tới Core Subcara. Test bài 02 và 03.
3. **Pre-TTS integration**: tận dụng pipeline dịch/voice hiện tại, đảm bảo có thể chuẩn bị khi pause trước lúc play, cache reuse, báo tiến độ.
4. **DOM/Layout PoC**: xem thực tế popup, xác định lớp DOM chứa Bunny, mở rộng **trong viewport** mà không reload player; đóng khôi phục hoàn toàn.
5. **Robustness**: thử bài khác, nhiều iframe, reload, seek, pause, đổi tốc độ, đóng modal, chuyển bài, nhiều tab; xử lý thất bại nếu bài không có English CC.
6. **Tests & docs**: unit test cue normalization/cache identity, integration smoke test iframe messaging, document selectors/rủi ro phiên bản.

## 6. Tiêu chí nghiệm thu

- [ ] Người dùng mở bài mới trên `fasttracktutorials.com` → Subcara nhận diện **không nhập ID Bunny**.
- [ ] Phụ đề tiếng Anh được lấy **toàn bộ cue + timestamp**, không chỉ câu hiện tại, không dùng Whisper với bài có CC.
- [ ] Video có thể **pause gần đầu bài** mà hệ thống vẫn chuẩn bị được voice trước khi phát (nếu track đã tải đầy đủ).
- [ ] TTS/dịch/cache **dùng lại hệ thống hiện có**, không nhân đôi/tạo lại voice khi mở lại cùng bài không đổi.
- [ ] Nhấn Watch → **Auto Theater** trong viewport, 16:9, không dùng browser/OS fullscreen.
- [ ] Player và TTS không reset khi phóng to/thu nhỏ; `Esc`/nút Close khôi phục layout và scroll.
- [ ] Không ảnh hưởng các adapter/platform Subcara khác.
- [ ] Không ghi log URL riêng tư/token/cookies, không truy cập vượt quyền, không tự động tải video.

## 7. Kết quả agent phải bàn giao

- Danh sách file đã thay đổi, chức năng và phạm vi của mỗi file.
- Cách bật/tắt Auto Theater ở FastTrack.
- Bằng chứng chạy thử: hostname iframe, số cue, thời điểm lấy cue, trạng thái pre-TTS, kết quả thay đổi layout.
- Những điểm **chưa xác minh** (ví dụ mọi bài có English CC, phụ đề tải đủ trước Play, điều khoản sử dụng) phải nêu rõ, không báo thành công khi chưa kiểm thử.

---

**Tóm tắt một câu cho Coding Agent:** *Hãy thêm adapter FastTrack/Bunny đọc English `TextTrack` trong iframe, đưa toàn bộ cue có timestamp vào pipeline pre-translation/pre-TTS **đã có**, đồng thời mở rộng modal player thành **theater mode trong viewport tab** bằng CSS, không fullscreen, không reload iframe, tự khôi phục khi đóng.*
