export interface GlossaryEntry {
  term: string;
  preserveExact: boolean;
  /**
   * Only match exact casing (PascalCase/camelCase) in non-LLM translation so everyday lowercase
   * English verbs/nouns like "update", "scene", "transform", "promise" are never mis-masked.
   */
  caseSensitive?: boolean;
  note?: string;
}

/**
 * Default technical glossary for Unity, Game Development, and Software Engineering tutorials.
 * Keeps unambiguous identifiers intact so Vietnamese audio & subtitles match the instructor's IDE/Editor UI.
 */
export const DEFAULT_TECH_GLOSSARY: ReadonlyArray<GlossaryEntry> = [
  { term: 'GameObject', preserveExact: true, caseSensitive: true },
  { term: 'Rigidbody2D', preserveExact: true, caseSensitive: true },
  { term: 'Rigidbody', preserveExact: true, caseSensitive: true },
  { term: 'MeshCollider', preserveExact: true, caseSensitive: true },
  { term: 'BoxCollider', preserveExact: true, caseSensitive: true },
  { term: 'SphereCollider', preserveExact: true, caseSensitive: true },
  { term: 'CapsuleCollider', preserveExact: true, caseSensitive: true },
  { term: 'CharacterController', preserveExact: true, caseSensitive: true },
  { term: 'ScriptableObject', preserveExact: true, caseSensitive: true },
  { term: 'MonoBehaviour', preserveExact: true, caseSensitive: true },
  { term: 'SerializeField', preserveExact: true, caseSensitive: true },
  { term: 'Coroutine', preserveExact: true, caseSensitive: true },
  { term: 'Shader Graph', preserveExact: true, caseSensitive: false },
  { term: 'Particle System', preserveExact: true, caseSensitive: true },
  { term: 'RectTransform', preserveExact: true, caseSensitive: true },
  { term: 'NavMeshAgent', preserveExact: true, caseSensitive: true },
  { term: 'NavMesh', preserveExact: true, caseSensitive: true },
  { term: 'Raycast', preserveExact: true, caseSensitive: true },
  { term: 'OnTriggerEnter', preserveExact: true, caseSensitive: true },
  { term: 'OnCollisionEnter', preserveExact: true, caseSensitive: true },
  { term: 'FixedUpdate', preserveExact: true, caseSensitive: true },
  { term: 'LateUpdate', preserveExact: true, caseSensitive: true },
  { term: 'TextMeshPro', preserveExact: true, caseSensitive: true },
  { term: 'Cinemachine', preserveExact: true, caseSensitive: true },
  { term: 'Prefab', preserveExact: true, caseSensitive: true },
  { term: 'Prefabs', preserveExact: true, caseSensitive: true },
  { term: 'async/await', preserveExact: true, caseSensitive: false },
];

export function formatGlossaryPromptDirective(
  entries: ReadonlyArray<GlossaryEntry> = DEFAULT_TECH_GLOSSARY,
): string {
  const preserved = entries.filter((e) => e.preserveExact).map((e) => e.term);
  if (preserved.length === 0) return '';
  return `Giữ nguyên các định danh kỹ thuật / tên cửa sổ phần mềm bằng tiếng Anh khi xuất hiện đúng ngữ cảnh kỹ thuật (ví dụ: ${preserved.join(', ')}, Inspector, Hierarchy, Scene, Transform, Collider, Canvas).`;
}
