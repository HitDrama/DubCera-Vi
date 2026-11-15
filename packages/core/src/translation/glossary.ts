export interface GlossaryEntry {
  term: string;
  preserveExact: boolean;
  note?: string;
}

/**
 * Default technical glossary for Unity, Game Development, and Software Engineering tutorials.
 * Keeps standard English identifiers intact so Vietnamese audio & subtitles match the instructor's IDE/Editor UI.
 */
export const DEFAULT_TECH_GLOSSARY: ReadonlyArray<GlossaryEntry> = [
  { term: 'GameObject', preserveExact: true },
  { term: 'Transform', preserveExact: true },
  { term: 'Rigidbody', preserveExact: true },
  { term: 'Rigidbody2D', preserveExact: true },
  { term: 'Collider', preserveExact: true },
  { term: 'MeshCollider', preserveExact: true },
  { term: 'Prefab', preserveExact: true },
  { term: 'ScriptableObject', preserveExact: true },
  { term: 'MonoBehaviour', preserveExact: true },
  { term: 'SerializeField', preserveExact: true },
  { term: 'Coroutine', preserveExact: true },
  { term: 'Shader Graph', preserveExact: true },
  { term: 'Particle System', preserveExact: true },
  { term: 'Inspector', preserveExact: true },
  { term: 'Hierarchy', preserveExact: true },
  { term: 'Scene', preserveExact: true },
  { term: 'Canvas', preserveExact: true },
  { term: 'RectTransform', preserveExact: true },
  { term: 'NavMesh', preserveExact: true },
  { term: 'Raycast', preserveExact: true },
  { term: 'OnTriggerEnter', preserveExact: true },
  { term: 'OnCollisionEnter', preserveExact: true },
  { term: 'Update', preserveExact: true },
  { term: 'FixedUpdate', preserveExact: true },
  { term: 'async/await', preserveExact: true },
  { term: 'Promise', preserveExact: true },
  { term: 'Callback', preserveExact: true },
  { term: 'State Machine', preserveExact: true },
];

export function formatGlossaryPromptDirective(
  entries: ReadonlyArray<GlossaryEntry> = DEFAULT_TECH_GLOSSARY,
): string {
  const preserved = entries.filter((e) => e.preserveExact).map((e) => e.term);
  if (preserved.length === 0) return '';
  return `Giữ nguyên các thuật ngữ kỹ thuật sau bằng tiếng Anh (không dịch sang tiếng Việt): ${preserved.join(', ')}.`;
}
