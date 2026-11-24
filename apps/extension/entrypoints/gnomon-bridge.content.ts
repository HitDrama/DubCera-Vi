import {
  extractKalturaLessonFromMultirequest,
  pickBestKalturaCaptionTrack,
} from '../src/adapters/gnomon/kalturaCaptionParser';

interface CachedLessonInfo {
  entryId: string;
  title: string;
  vttUrl: string | null;
  vttText: string | null;
}

export default defineContentScript({
  matches: ['*://*.thegnomonworkshop.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const lessonByEntryId = new Map<string, CachedLessonInfo>();
    let currentEntryId = '';

    function isSpokenVttPayload(vttText: string): boolean {
      const trimmed = vttText.trimStart();
      if (!trimmed.startsWith('WEBVTT') || trimmed.length < 20) return false;
      if (/#xywh=\d+,\d+,\d+,\d+/i.test(trimmed)) return false;
      return true;
    }

    function dispatchLessonReady(info: CachedLessonInfo): void {
      window.dispatchEvent(
        new CustomEvent('dubcera:gnomon-lesson-ready', {
          detail: {
            entryId: info.entryId,
            title: info.title,
            vttUrl: info.vttUrl,
            hasVttText: Boolean(info.vttText),
          },
        }),
      );
    }

    function dispatchCaptionsResult(entryId: string, vttText: string | null, vttUrl: string | null): void {
      window.dispatchEvent(
        new CustomEvent('dubcera:gnomon-captions-result', {
          detail: {
            videoId: entryId,
            ok: Boolean(vttText || vttUrl),
            vttText: vttText ?? undefined,
            vttUrl: vttUrl ?? undefined,
          },
        }),
      );
    }

    function handleMultirequestPayload(json: unknown): void {
      const parsed = extractKalturaLessonFromMultirequest(json);
      if (!parsed || !parsed.entryId) return;

      const bestTrack = pickBestKalturaCaptionTrack(parsed.tracks);
      const existing = lessonByEntryId.get(parsed.entryId);
      const nextInfo: CachedLessonInfo = {
        entryId: parsed.entryId,
        title: parsed.title || existing?.title || '',
        vttUrl: bestTrack?.url ?? existing?.vttUrl ?? null,
        vttText: existing?.vttText ?? null,
      };
      lessonByEntryId.set(parsed.entryId, nextInfo);
      currentEntryId = parsed.entryId;

      dispatchLessonReady(nextInfo);
      if (nextInfo.vttText || nextInfo.vttUrl) {
        dispatchCaptionsResult(nextInfo.entryId, nextInfo.vttText, nextInfo.vttUrl);
      }
    }

    function extractEntryIdFromUrl(urlStr: string): string {
      const m = urlStr.match(/\/entryId\/([^/?#]+)/i);
      return m?.[1] ?? currentEntryId;
    }

    function handleVttResponse(urlStr: string, vttText: string): void {
      if (!isSpokenVttPayload(vttText)) return;
      const entryId = extractEntryIdFromUrl(urlStr);
      if (!entryId) return;

      const existing = lessonByEntryId.get(entryId);
      const updated: CachedLessonInfo = {
        entryId,
        title: existing?.title ?? '',
        vttUrl: existing?.vttUrl ?? urlStr,
        vttText,
      };
      lessonByEntryId.set(entryId, updated);
      currentEntryId = entryId;

      dispatchCaptionsResult(entryId, vttText, updated.vttUrl);
    }

    // 1. Passive fetch observer for Kaltura multirequest & WebVTT responses
    const origFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
      const resp = await origFetch.apply(this, args);
      try {
        const req = args[0];
        const urlStr =
          typeof req === 'string'
            ? req
            : req instanceof URL
              ? req.toString()
              : req?.url ?? '';

        if (resp.ok && urlStr) {
          const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
          if (urlStr.includes('kaltura.com') && urlStr.includes('multirequest')) {
            void resp
              .clone()
              .json()
              .then((json) => handleMultirequestPayload(json))
              .catch(() => {});
          } else if (
            urlStr.includes('kaltura.com') &&
            (urlStr.includes('.vtt') ||
              urlStr.includes('serveWebVTT') ||
              contentType.includes('text/vtt'))
          ) {
            void resp
              .clone()
              .text()
              .then((txt) => handleVttResponse(urlStr, txt))
              .catch(() => {});
          }
        }
      } catch {
        // Never disrupt Gnomon/Kaltura native network calls
      }
      return resp;
    };

    // 2. Passive XHR observer (PlayKit / Shaka may fetch multirequest or .vtt via XHR)
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const xhrUrlMap = new WeakMap<XMLHttpRequest, string>();

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      xhrUrlMap.set(this, String(url));
      return origOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const urlStr = xhrUrlMap.get(this) ?? '';
      if (
        urlStr.includes('kaltura.com') &&
        (urlStr.includes('multirequest') ||
          urlStr.includes('.vtt') ||
          urlStr.includes('serveWebVTT'))
      ) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            if (typeof this.responseText !== 'string' || !this.responseText) return;
            if (urlStr.includes('multirequest')) {
              handleMultirequestPayload(JSON.parse(this.responseText));
            } else {
              handleVttResponse(urlStr, this.responseText);
            }
          } catch {
            // Ignore parse errors
          }
        });
      }
      return origSend.call(this, body);
    };

    // 3. Respond to on-demand caption requests from isolated-world content.tsx
    window.addEventListener('dubcera:request-gnomon-captions', (ev: Event) => {
      const customEv = ev as CustomEvent<{ videoId?: string }>;
      const requestedId = customEv.detail?.videoId || currentEntryId;
      const info = requestedId ? lessonByEntryId.get(requestedId) : undefined;
      if (info && (info.vttText || info.vttUrl)) {
        dispatchCaptionsResult(info.entryId, info.vttText, info.vttUrl);
      } else {
        dispatchCaptionsResult(requestedId || '', null, null);
      }
    });
  },
});
