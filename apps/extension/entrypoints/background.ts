import type { DubCeraRpcRequest, DubCeraRpcResponse } from '../src/bridges/extensionRpc';

const activeSessionControllers = new Map<string, Set<AbortController>>();

function registerSessionController(sessionTag?: string): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!sessionTag) {
    return { controller, cleanup: () => {} };
  }
  let group = activeSessionControllers.get(sessionTag);
  if (!group) {
    group = new Set<AbortController>();
    activeSessionControllers.set(sessionTag, group);
  }
  group.add(controller);
  return {
    controller,
    cleanup: () => {
      const current = activeSessionControllers.get(sessionTag);
      if (current) {
        current.delete(controller);
        if (current.size === 0) {
          activeSessionControllers.delete(sessionTag);
        }
      }
    },
  };
}

function abortSessionControllers(sessionTag: string): number {
  const group = activeSessionControllers.get(sessionTag);
  if (!group) return 0;
  let count = 0;
  for (const ctrl of group) {
    ctrl.abort();
    count += 1;
  }
  activeSessionControllers.delete(sessionTag);
  return count;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

async function handleRpc(msg: DubCeraRpcRequest): Promise<unknown> {
  switch (msg.type) {
    case 'ABORT_SESSION_REQUESTS': {
      return { aborted: abortSessionControllers(msg.sessionTag) };
    }

    case 'TTS_HEALTH': {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), msg.timeoutMs ?? 3500);
      try {
        const resp = await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/health`, {
          method: 'GET',
          signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`Health HTTP ${resp.status}`);
        return await resp.json();
      } finally {
        clearTimeout(timer);
      }
    }

    case 'TTS_VERIFY_CACHE': {
      const resp = await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/cache/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DubCera-Token': msg.token,
        },
        body: JSON.stringify({ cacheKeys: msg.cacheKeys }),
      });
      if (!resp.ok) throw new Error(`Cache verify HTTP ${resp.status}`);
      const body = (await resp.json()) as { validItems?: Record<string, unknown> };
      return body.validItems ?? {};
    }

    case 'TTS_SYNTHESIZE': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const resp = await fetch(`${msg.baseUrl.replace(/\/+$/, '')}/v1/synthesize`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-DubCera-Token': msg.token,
          },
          body: JSON.stringify({
            audioCacheKey: msg.audioCacheKey,
            text: msg.text,
            targetLang: 'vi',
            voiceId: msg.voiceId,
            engineId: msg.engineId,
            modelVersion: 'v1',
            sampleRate: msg.sampleRate,
            styleOrPitchConfig: 'default',
            pauseConfig: 'default',
          }),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          throw new Error(`TTS synthesize HTTP ${resp.status}: ${detail}`);
        }
        return await resp.json();
      } finally {
        cleanup();
      }
    }

    case 'TTS_FETCH_AUDIO_B64': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const resp = await fetch(
          `${msg.baseUrl.replace(/\/+$/, '')}/v1/audio/${msg.audioCacheKey}`,
          {
            method: 'GET',
            signal: controller.signal,
            headers: { 'X-DubCera-Token': msg.token },
          },
        );
        if (!resp.ok) throw new Error(`Audio fetch HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        return arrayBufferToBase64(buf);
      } finally {
        cleanup();
      }
    }

    case 'FREE_WEB_TRANSLATE': {
      const { controller, cleanup } = registerSessionController(msg.sessionTag);
      try {
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', msg.sourceLang || 'auto');
        url.searchParams.set('tl', msg.targetLang || 'vi');
        url.searchParams.set('dt', 't');
        url.searchParams.set('q', msg.query);

        const resp = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`Translate HTTP ${resp.status}`);
        const rawJson = (await resp.json()) as unknown;
        const parts = Array.isArray(rawJson) && Array.isArray(rawJson[0]) ? (rawJson[0] as unknown[]) : [];
        return parts
          .map((p) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : ''))
          .join('');
      } finally {
        cleanup();
      }
    }

    case 'FETCH_SUBTITLE_TEXT': {
      const parsed = new URL(msg.url);
      const host = parsed.hostname.toLowerCase();
      const isAllowedSubtitleHost =
        parsed.protocol === 'https:' &&
        (host.endsWith('.udemycdn.com') ||
          host.endsWith('.udemy.com') ||
          host === 'udemy.com' ||
          host.endsWith('.youtube.com'));
      if (!isAllowedSubtitleHost) {
        throw new Error(`Disallowed subtitle host: ${host}`);
      }
      const resp = await fetch(parsed.toString(), { method: 'GET' });
      if (!resp.ok) {
        throw new Error(`Subtitle fetch HTTP ${resp.status}`);
      }
      return await resp.text();
    }
  }
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    console.info('[DubCera] Extension installed and RPC background worker ready.');
  });

  chrome.runtime.onMessage.addListener(
    (
      message: DubCeraRpcRequest | undefined,
      _sender,
      sendResponse: (res: DubCeraRpcResponse) => void,
    ) => {
      if (!message || typeof message.type !== 'string') return false;

      void handleRpc(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    },
  );
});
