import type { PersistedSegmentRecord, SpeechSegment, VideoManifestRecord } from '@dubcera/core';

const DB_NAME = 'dubcera_manifest_db';
const DB_VERSION = 1;
const STORE_NAME = 'video_manifests';

/**
 * Strict 1-day (24 hours = 86,400,000 ms) hard expiration from creation time.
 */
export const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_MANIFESTS = 150;

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

function getEffectiveCreatedAtMs(rec: VideoManifestRecord): number {
  return rec.createdAtMs ?? rec.updatedAtMs ?? 0;
}

/**
 * Strictly deletes any video manifest created >= 1 day (24h) ago, invalidated by manual Clear Cache,
 * or exceeding MAX_STORED_MANIFESTS.
 */
export async function pruneExpiredManifests(minValidTimestampMs = 0): Promise<void> {
  try {
    const db = await openManifestDatabase();
    const nowMs = Date.now();
    const ttlCutoffMs = nowMs - MANIFEST_TTL_MS;

    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const records = (allReq.result as VideoManifestRecord[] | undefined) ?? [];
        const validRemaining: VideoManifestRecord[] = [];

        for (const rec of records) {
          const createdAt = getEffectiveCreatedAtMs(rec);
          const updatedAt = rec.updatedAtMs ?? createdAt;
          if (!createdAt || createdAt <= ttlCutoffMs || updatedAt < minValidTimestampMs) {
            store.delete(rec.videoKey);
          } else {
            validRemaining.push(rec);
          }
        }

        if (validRemaining.length > MAX_STORED_MANIFESTS) {
          validRemaining.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
          const toDrop = validRemaining.length - MAX_STORED_MANIFESTS;
          for (let i = 0; i < toDrop; i++) {
            store.delete(validRemaining[i]!.videoKey);
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore restricted frame errors
  }
}

export async function loadVideoManifest(
  videoKey: string,
  minValidTimestampMs = 0,
): Promise<VideoManifestRecord | null> {
  try {
    await pruneExpiredManifests(minValidTimestampMs);
    const db = await openManifestDatabase();
    return await new Promise<VideoManifestRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(videoKey);
      req.onsuccess = () => {
        const record = (req.result as VideoManifestRecord | undefined) ?? null;
        if (!record) {
          resolve(null);
          return;
        }
        const createdAt = getEffectiveCreatedAtMs(record);
        if (
          Date.now() - createdAt >= MANIFEST_TTL_MS ||
          record.updatedAtMs < minValidTimestampMs
        ) {
          store.delete(videoKey);
          resolve(null);
          return;
        }
        resolve(record);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveVideoManifest(record: VideoManifestRecord): Promise<void> {
  try {
    const db = await openManifestDatabase();
    const nowMs = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const existingReq = store.get(record.videoKey);
      existingReq.onsuccess = () => {
        const existing = (existingReq.result as VideoManifestRecord | undefined) ?? null;
        const existingCreatedAt = existing ? getEffectiveCreatedAtMs(existing) : 0;
        const preserveCreatedAt =
          existingCreatedAt > 0 && nowMs - existingCreatedAt < MANIFEST_TTL_MS
            ? existingCreatedAt
            : nowMs;

        store.put({
          ...record,
          createdAtMs: record.createdAtMs ?? preserveCreatedAt,
          updatedAtMs: nowMs,
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort persistence
  }
}

export async function deleteVideoManifest(videoKey: string): Promise<void> {
  if (!videoKey) return;
  try {
    const db = await openManifestDatabase();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(videoKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

/**
 * Immediately wipes every cached video manifest & translation stored in the current origin's IndexedDB.
 */
export async function clearAllVideoManifests(): Promise<number> {
  try {
    const db = await openManifestDatabase();
    return await new Promise<number>((resolve) => {
      let count = 0;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => {
        count = countReq.result ?? 0;
        store.clear();
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => resolve(0);
    });
  } catch {
    return 0;
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
