import type { PersistedSegmentRecord, SpeechSegment, VideoManifestRecord } from '@dubcera/core';

const DB_NAME = 'dubcera_manifest_db';
const DB_VERSION = 1;
const STORE_NAME = 'video_manifests';

function openManifestDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'videoKey' });
        store.createIndex('updatedAtMs', 'updatedAtMs', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function loadVideoManifest(videoKey: string): Promise<VideoManifestRecord | null> {
  try {
    const db = await openManifestDatabase();
    return await new Promise<VideoManifestRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(videoKey);
      req.onsuccess = () => resolve((req.result as VideoManifestRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveVideoManifest(record: VideoManifestRecord): Promise<void> {
  try {
    const db = await openManifestDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({
        ...record,
        updatedAtMs: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort persistence
  }
}

export function toPersistedSegments(segments: ReadonlyArray<SpeechSegment>): PersistedSegmentRecord[] {
  return segments.map((s) => ({
    segmentIndex: s.segmentIndex,
    segmentId: s.segmentId,
    sourceCueIds: s.sourceCueIds,
    startMs: s.startMs,
    endMs: s.endMs,
    nextSegmentStartMs: s.nextSegmentStartMs,
    sourceText: s.sourceText,
    translatedText: s.translatedText,
    displayChunks: s.displayChunks,
    configVersion: s.configVersion,
    audioCacheKey: s.audioCacheKey,
    audioDurationMs: s.audioDurationMs,
    status: s.status === 'READY' || s.status === 'TRANSLATED' ? s.status : 'UNPROCESSED',
  }));
}
