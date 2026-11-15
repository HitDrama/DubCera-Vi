const AUDIO_DB_NAME = 'dubcera_builtin_audio_db';
const AUDIO_DB_VERSION = 1;
const AUDIO_STORE_NAME = 'audio_clips';

/**
 * Strict 1-day (24 hours = 86,400,000 ms) hard expiration from creation time,
 * plus 500 MB browser IndexedDB cap (~18 hours of 64kbps MP3 audio, well below 5 GB ceiling).
 */
export const BUILTIN_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;
export const BUILTIN_AUDIO_MAX_BYTES = 500 * 1024 * 1024;

export interface StoredBuiltinAudioRecord {
  audioCacheKey: string;
  mimeType: string;
  audioDurationMs: number;
  sizeBytes: number;
  createdAtMs: number;
  audioBytes: ArrayBuffer;
}

function openAudioDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE_NAME)) {
        const store = db.createObjectStore(AUDIO_STORE_NAME, { keyPath: 'audioCacheKey' });
        store.createIndex('createdAtMs', 'createdAtMs', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open Builtin Audio IndexedDB'));
  });
}

export async function pruneBuiltinAudioCache(minValidTimestampMs = 0): Promise<void> {
  try {
    const db = await openAudioDatabase();
    const nowMs = Date.now();
    const ttlCutoffMs = nowMs - BUILTIN_AUDIO_TTL_MS;

    await new Promise<void>((resolve) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE_NAME);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const records = (allReq.result as StoredBuiltinAudioRecord[] | undefined) ?? [];
        const valid: StoredBuiltinAudioRecord[] = [];
        let totalBytes = 0;

        for (const rec of records) {
          if (
            !rec.createdAtMs ||
            rec.createdAtMs <= ttlCutoffMs ||
            rec.createdAtMs < minValidTimestampMs ||
            !rec.audioBytes ||
            rec.sizeBytes <= 0
          ) {
            store.delete(rec.audioCacheKey);
          } else {
            valid.push(rec);
            totalBytes += rec.sizeBytes;
          }
        }

        if (totalBytes > BUILTIN_AUDIO_MAX_BYTES) {
          valid.sort((a, b) => a.createdAtMs - b.createdAtMs);
          for (const rec of valid) {
            if (totalBytes <= BUILTIN_AUDIO_MAX_BYTES) break;
            store.delete(rec.audioCacheKey);
            totalBytes -= rec.sizeBytes;
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

export async function getBuiltinCachedAudio(
  audioCacheKey: string,
  minValidTimestampMs = 0,
): Promise<StoredBuiltinAudioRecord | null> {
  if (!audioCacheKey) return null;
  try {
    const cleanKey = audioCacheKey.toLowerCase();
    const db = await openAudioDatabase();
    return await new Promise<StoredBuiltinAudioRecord | null>((resolve) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE_NAME);
      const req = store.get(cleanKey);
      req.onsuccess = () => {
        const rec = (req.result as StoredBuiltinAudioRecord | undefined) ?? null;
        if (!rec) {
          resolve(null);
          return;
        }
        if (
          Date.now() - rec.createdAtMs >= BUILTIN_AUDIO_TTL_MS ||
          rec.createdAtMs < minValidTimestampMs ||
          !rec.audioBytes ||
          rec.audioBytes.byteLength < 64
        ) {
          store.delete(cleanKey);
          resolve(null);
          return;
        }
        resolve(rec);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function verifyBuiltinCachedAudioKeys(
  cacheKeys: string[],
  minValidTimestampMs = 0,
): Promise<Record<string, { audioDurationMs: number }>> {
  if (cacheKeys.length === 0) return {};
  await pruneBuiltinAudioCache(minValidTimestampMs);

  const validMap: Record<string, { audioDurationMs: number }> = {};
  for (const key of cacheKeys) {
    const rec = await getBuiltinCachedAudio(key, minValidTimestampMs);
    if (rec) {
      validMap[key.toLowerCase()] = { audioDurationMs: rec.audioDurationMs };
    }
  }
  return validMap;
}

export async function putBuiltinCachedAudio(params: {
  audioCacheKey: string;
  mimeType: string;
  audioDurationMs: number;
  audioBytes: ArrayBuffer;
}): Promise<void> {
  try {
    const db = await openAudioDatabase();
    const cleanKey = params.audioCacheKey.toLowerCase();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE_NAME);
      const record: StoredBuiltinAudioRecord = {
        audioCacheKey: cleanKey,
        mimeType: params.mimeType,
        audioDurationMs: params.audioDurationMs,
        sizeBytes: params.audioBytes.byteLength,
        createdAtMs: Date.now(),
        audioBytes: params.audioBytes,
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    await pruneBuiltinAudioCache();
  } catch {
    // Best-effort cache write
  }
}

export async function clearAllBuiltinAudioCache(): Promise<{
  deletedCount: number;
  freedBytes: number;
}> {
  try {
    const db = await openAudioDatabase();
    return await new Promise<{ deletedCount: number; freedBytes: number }>((resolve) => {
      let deletedCount = 0;
      let freedBytes = 0;
      const tx = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE_NAME);
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const records = (allReq.result as StoredBuiltinAudioRecord[] | undefined) ?? [];
        deletedCount = records.length;
        for (const rec of records) {
          freedBytes += rec.sizeBytes ?? 0;
        }
        store.clear();
      };
      tx.oncomplete = () => resolve({ deletedCount, freedBytes });
      tx.onerror = () => resolve({ deletedCount: 0, freedBytes: 0 });
    });
  } catch {
    return { deletedCount: 0, freedBytes: 0 };
  }
}
