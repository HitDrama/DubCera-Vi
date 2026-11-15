/**
 * Contextual Source Pre-Normalizer, Spoken-Vietnamese Dubbing Naturalizer,
 * and Phonetic TTS Script Formatter.
 *
 * Separates clean written subtitles (`translatedText`) from phonetically optimized
 * TTS narration script (`spokenText`) so technical terms, numbers, and idioms sound
 * natural and accurate when read aloud in Vietnamese.
 */

const ASR_FILLER_WORDS = /\b(?:uh+|um+|erm+|hmm+)\b[,\s]*/gi;
const STUTTER_WORD_REPEAT = /\b(i|we|you|they|he|she|it|the|a|an|to|in|on|is|are|and|so|but)\s+\1\b/gi;

/**
 * Cleans spoken disfluencies and disambiguates UI/domain phrases prior to NMT translation
 * without injecting synthetic placeholder tokens that break sentence syntax.
 */
export function cleanSourceForTranslation(sourceText: string): string {
  let cleaned = sourceText
    .replace(ASR_FILLER_WORDS, ' ')
    .replace(STUTTER_WORD_REPEAT, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  // Disambiguate common software/engine UI phrases that stateless NMT misreads literally
  cleaned = cleaned
    .replace(/\b(?:check|uncheck)\s+(Use Gravity|Is Trigger|Is Kinematic|Loop Time|Apply Root Motion)\b/gi, (m, prop: string) =>
      /^uncheck/i.test(m) ? `untick "${prop}"` : `tick "${prop}"`,
    )
    .replace(/\bplayer\s+(GameObject|Prefab|Controller|Character|Rigidbody|Transform)\b/gi, 'Player $1');

  // Capitalize sentence start for lowercase YouTube ASR auto-captions so NMT parses full clause grammar
  if (/^[a-z]/.test(cleaned)) {
    cleaned = cleaned[0]!.toUpperCase() + cleaned.slice(1);
  }

  return cleaned;
}

/**
 * Refines literal machine-translated Vietnamese into natural, idiomatic spoken Vietnamese
 * suitable for instructional lectures, tech tutorials, and creator videos.
 */
export function polishTranslatedVietnamese(translated: string, sourceText = ''): string {
  let out = translated.replace(/\s+/g, ' ').trim();
  if (!out) return '';

  const srcLower = sourceText.toLowerCase();

  // 1. Recover domain UI window names mistranslated by generic NMT when present in source
  if (/\binspector\b/.test(srcLower)) {
    out = out
      .replace(/\btrong\s+Thanh\s+tra\b/gi, 'trong cửa sổ Inspector')
      .replace(/\bcửa\s+sổ\s+Thanh\s+tra\b/gi, 'cửa sổ Inspector')
      .replace(/\bbảng\s+Thanh\s+tra\b/gi, 'bảng Inspector');
  }
  if (/\bhierarchy\b/.test(srcLower)) {
    out = out
      .replace(/\btrong\s+Hệ\s+thống\s+phân\s+cấp\b/gi, 'trong cửa sổ Hierarchy')
      .replace(/\bcửa\s+sổ\s+Hệ\s+thống\s+phân\s+cấp\b/gi, 'cửa sổ Hierarchy');
  }
  if (/\bplayer\b/.test(srcLower) && /\b(?:gameobject|prefab|rigidbody|collider|controller)\b/.test(srcLower)) {
    out = out
      .replace(/\bGameObject\s+trình\s+phát\b/gi, 'Player GameObject')
      .replace(/\btrình\s+phát\s+GameObject\b/gi, 'Player GameObject')
      .replace(/\btrình\s+phát\s+của\s+chúng\s+(?:tôi|ta)\b/gi, 'nhân vật của chúng ta');
  }
  if (/\b(?:hit|press|click)\s+play\b/.test(srcLower)) {
    out = out.replace(/\bnhấn\s+(?:phát|chơi)\b/gi, 'nhấn Play');
  }
  if (/\bfrom\s+scratch\b/.test(srcLower)) {
    out = out.replace(/\btừ\s+vết\s+xước\b/gi, 'từ đầu');
  }
  if (/\bunder\s+the\s+hood\b/.test(srcLower)) {
    out = out.replace(/\bdưới\s+mui\s+xe\b/gi, 'bên dưới hệ thống');
  }

  // 2. Smooth stiff English-to-Vietnamese calques into natural spoken phrasing
  out = out
    .replace(/^Chào mừng trở lại([!.,?]*)/i, 'Chào mừng các bạn quay trở lại$1')
    .replace(/^Chào mừng quay trở lại([!.,?]*)/i, 'Chào mừng các bạn quay trở lại$1')
    .replace(/\b(?:chúng ta )?hãy tiếp tục và\s+/gi, 'hãy ')
    .replace(/\btiếp tục và\s+(tạo|thêm|mở|chọn|viết|thiết lập|nhấp|nhấn|tích|xem|chạy)\b/gi, '$1')
    .replace(/\bhãy kiểm tra nó([!.,?]*)$/i, 'hãy cùng xem thử nhé$1')
    .replace(/\bxem nó hoạt động như thế nào\b/gi, 'xem cách nó hoạt động')
    .replace(/\bthấy nó hoạt động như thế nào\b/gi, 'thấy cách nó hoạt động')
    .replace(/\bnhư thế nào\s+nó\s+hoạt động\b/gi, 'cách nó hoạt động')
    .replace(/\bNgay bây giờ,\s*/g, 'Hiện tại, ')
    .replace(/^Ngay bây giờ\s+/g, 'Hiện tại ');

  // 3. Harmonize instructional inclusive pronouns ("we/our" -> "chúng ta") when addressing viewers
  const isInstructional =
    /\b(?:bạn|các bạn|chúng ta|hãy cùng)\b/i.test(out) ||
    /\b(?:let's|let us|in this video|in this lecture|welcome back)\b/i.test(srcLower);

  if (isInstructional) {
    out = out
      .replace(/\bcủa chúng tôi\b/g, 'của chúng ta')
      .replace(/\bkhi chúng tôi\s+(nhấn|chạy|mở|tạo|thêm|chọn|xây dựng|viết|thử|kiểm tra|sử dụng)\b/gi, 'khi chúng ta $1')
      .replace(/\bnếu chúng tôi\s+(nhấn|chạy|mở|tạo|thêm|chọn|thay đổi|xóa|tắt|bật)\b/gi, 'nếu chúng ta $1');
  }

  // Normalize spacing around punctuation
  out = out
    .replace(/\s+([,.;:?!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

const PHONETIC_EXACT_MAP: ReadonlyArray<[RegExp, string]> = [
  [/\bC#/g, 'xi thăng'],
  [/\bC\+\+/g, 'xi cộng cộng'],
  [/(?:^|\s)\.NET\b/g, ' đốt nét'],
  [/\bNode\.js\b/gi, 'nốt dây ét'],
  [/\bNext\.js\b/gi, 'nếch dây ét'],
  [/\bVue\.js\b/gi, 'viu dây ét'],
  [/\bThree\.js\b/gi, 'thri dây ét'],
  [/\bRigidbody2D\b/g, 'Rigid body hai đê'],
  [/\bRigidbody\b/g, 'Rigid body'],
  [/\bGameObjects\b/g, 'Game Object'],
  [/\bGameObject\b/g, 'Game Object'],
  [/\bScriptableObjects\b/g, 'Scriptable Object'],
  [/\bScriptableObject\b/g, 'Scriptable Object'],
  [/\bMonoBehaviour\b/g, 'Mono Behaviour'],
  [/\bSerializeField\b/g, 'Serialize Field'],
  [/\bRectTransform\b/g, 'Rect Transform'],
  [/\bMeshCollider\b/g, 'Mesh Collider'],
  [/\bBoxCollider2D\b/g, 'Box Collider hai đê'],
  [/\bBoxCollider\b/g, 'Box Collider'],
  [/\bSphereCollider\b/g, 'Sphere Collider'],
  [/\bCapsuleCollider\b/g, 'Capsule Collider'],
  [/\bCharacterController\b/g, 'Character Controller'],
  [/\bNavMeshAgent\b/g, 'Nav Mesh Agent'],
  [/\bNavMesh\b/g, 'Nav Mesh'],
  [/\bOnTriggerEnter2D\b/g, 'On Trigger Enter hai đê'],
  [/\bOnTriggerEnter\b/g, 'On Trigger Enter'],
  [/\bOnCollisionEnter2D\b/g, 'On Collision Enter hai đê'],
  [/\bOnCollisionEnter\b/g, 'On Collision Enter'],
  [/\bFixedUpdate\b/g, 'Fixed Update'],
  [/\bLateUpdate\b/g, 'Late Update'],
  [/\bTextMeshPro\b/g, 'Text Mesh Pro'],
  [/\basync\/await\b/gi, 'async await'],
  [/\b2D\b/g, 'hai đê'],
  [/\b3D\b/g, 'ba đê'],
  [/\b4K\b/g, 'bốn ca'],
  [/\b(\d+)\s*fps\b/gi, '$1 ép pê ét'],
  [/\bFPS\b/g, 'ép pê ét'],
  [/\bJSON\b/g, 'dây-sơn'],
  [/\bAPI\b/g, 'A P I'],
  [/\bAPIs\b/g, 'A P I'],
  [/\bUI\b/g, 'U I'],
  [/\bUX\b/g, 'U X'],
  [/\bSDK\b/g, 'S D K'],
  [/\bIDE\b/g, 'I D E'],
  [/\bURL\b/g, 'U R L'],
  [/\bHTML\b/g, 'H T M L'],
  [/\bCSS\b/g, 'C S S'],
  [/\bSQL\b/g, 'S Q L'],
  [/\bCPU\b/g, 'C P U'],
  [/\bGPU\b/g, 'G P U'],
  [/\bRGB\b/g, 'R G B'],
  [/\bVFX\b/g, 'V F X'],
  [/\bSFX\b/g, 'S F X'],
  [/\bvs\.?(?=\s)/gi, 'so với'],
];

/**
 * Converts clean written Vietnamese subtitles into a phonetically smooth TTS narration script
 * so Vietnamese TTS engines pronounce technical identifiers, decimals, and symbols cleanly
 * without affecting on-screen subtitle text.
 */
export function toSpokenVietnameseTtsText(displayViText: string): string {
  let spoken = displayViText.trim();
  if (!spoken) return '';

  // Strip surrounding quotation marks around technical property names so TTS doesn't pause unnaturally
  spoken = spoken.replace(/["“”«»]/g, '');

  for (const [pattern, replacement] of PHONETIC_EXACT_MAP) {
    spoken = spoken.replace(pattern, replacement);
  }

  // Split remaining general PascalCase words (e.g. AudioSource -> Audio Source) for clean syllable boundaries
  spoken = spoken.replace(/\b([A-Z][a-z]{2,})([A-Z][a-z]{2,})\b/g, '$1 $2');

  // Pronounce English/metric decimal points ("1.5" -> "1 chấm 5") instead of Vietnamese thousands grouping
  spoken = spoken.replace(/\b(\d+)\.(\d{1,2})\b/g, '$1 chấm $2');

  // Pronounce percentages naturally
  spoken = spoken.replace(/(\d+)\s*%/g, '$1 phần trăm');

  return spoken.replace(/\s+/g, ' ').trim();
}
