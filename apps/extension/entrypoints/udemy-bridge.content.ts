interface UdemyCaptionTrack {
  url: string;
  localeId: string;
  title: string;
  isAuto: boolean;
}

export default defineContentScript({
  matches: ['*://*.udemy.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const vttTextByLectureId = new Map<string, string>();
    const captionTracksByLectureId = new Map<string, UdemyCaptionTrack[]>();
    let latestCaptionTracks: UdemyCaptionTrack[] = [];
    let knownCourseId: string | null = null;

    function resolveCurrentLectureId(): string {
      const m = location.pathname.match(/\/learn\/lecture\/(\d+)/);
      if (m?.[1]) return m[1];
      return location.pathname;
    }

    function resolveCourseSlug(): string | null {
      const m = location.pathname.match(/\/course\/([^/?#]+)/);
      return m?.[1] ?? null;
    }

    function parseCaptionArray(rawArr: unknown[]): UdemyCaptionTrack[] {
      const out: UdemyCaptionTrack[] = [];
      for (const item of rawArr) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const url =
          typeof rec.url === 'string'
            ? rec.url
            : typeof rec.src === 'string'
              ? rec.src
              : '';
        if (!url || (!url.includes('.vtt') && !url.startsWith('http'))) continue;

        let localeId = '';
        if (typeof rec.locale_id === 'string') {
          localeId = rec.locale_id;
        } else if (rec.locale && typeof rec.locale === 'object') {
          const locObj = rec.locale as Record<string, unknown>;
          if (typeof locObj.locale === 'string') localeId = locObj.locale;
        }

        const title =
          typeof rec.title === 'string'
            ? rec.title
            : typeof rec.video_label === 'string'
              ? rec.video_label
              : localeId;
        const isAuto = /auto|tự động/i.test(title) || rec.source === 'auto';

        out.push({ url, localeId: localeId.toLowerCase(), title, isAuto });
      }
      return out;
    }

    function pickBestUdemyTrack(tracks: UdemyCaptionTrack[]): UdemyCaptionTrack | null {
      if (tracks.length === 0) return null;
      const enManual = tracks.find((t) => t.localeId.startsWith('en') && !t.isAuto);
      if (enManual) return enManual;
      const enAny = tracks.find((t) => t.localeId.startsWith('en'));
      if (enAny) return enAny;
      const nonVi = tracks.find((t) => !t.localeId.startsWith('vi'));
      return nonVi ?? tracks[0] ?? null;
    }

    function scanJsonForCaptions(node: unknown, urlHintLectureId?: string, depth = 0): void {
      if (depth > 5 || !node || typeof node !== 'object') return;

      if (Array.isArray(node)) {
        for (const el of node.slice(0, 60)) {
          scanJsonForCaptions(el, urlHintLectureId, depth + 1);
        }
        return;
      }

      const obj = node as Record<string, unknown>;
      const ownId =
        typeof obj.id === 'number' || typeof obj.id === 'string' ? String(obj.id) : undefined;

      // Check direct `captions` or nested `asset.captions`
      if (Array.isArray(obj.captions)) {
        const parsed = parseCaptionArray(obj.captions);
        if (parsed.length > 0) {
          latestCaptionTracks = parsed;
          const targetId = urlHintLectureId ?? ownId ?? resolveCurrentLectureId();
          captionTracksByLectureId.set(targetId, parsed);
        }
      }

      if (obj.asset && typeof obj.asset === 'object') {
        const assetObj = obj.asset as Record<string, unknown>;
        if (Array.isArray(assetObj.captions)) {
          const parsed = parseCaptionArray(assetObj.captions);
          if (parsed.length > 0) {
            latestCaptionTracks = parsed;
            const targetId = urlHintLectureId ?? ownId ?? resolveCurrentLectureId();
            captionTracksByLectureId.set(targetId, parsed);
          }
        }
      }

      if (Array.isArray(obj.results)) {
        scanJsonForCaptions(obj.results, urlHintLectureId, depth + 1);
      }
    }

    function recordApiUrlMetadata(urlStr: string): string | undefined {
      const courseMatch = urlStr.match(/\/(?:subscribed-courses|courses)\/(\d+)/);
      if (courseMatch?.[1]) {
        knownCourseId = courseMatch[1];
      }
      const lectureMatch = urlStr.match(/\/lectures\/(\d+)/);
      return lectureMatch?.[1];
    }

    function recordVttPayload(vttText: string): void {
      if (!vttText.trimStart().startsWith('WEBVTT') || vttText.trim().length < 20) return;
      const vid = resolveCurrentLectureId();
      vttTextByLectureId.set(vid, vttText);
      window.dispatchEvent(
        new CustomEvent('dubcera:udemy-captions-result', {
          detail: {
            videoId: vid,
            ok: true,
            vttText,
          },
        }),
      );
    }

    // 1. Passive fetch hook for `.vtt` files & `/api-2.0/` lecture metadata
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

        if (resp.ok) {
          const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
          if (urlStr.includes('.vtt') || contentType.includes('text/vtt')) {
            void resp
              .clone()
              .text()
              .then((txt) => recordVttPayload(txt))
              .catch(() => {});
          } else if (urlStr.includes('/api-2.0/')) {
            const lectureHint = recordApiUrlMetadata(urlStr);
            if (urlStr.includes('captions') || urlStr.includes('lectures') || urlStr.includes('curriculum')) {
              void resp
                .clone()
                .json()
                .then((json) => scanJsonForCaptions(json, lectureHint))
                .catch(() => {});
            }
          }
        }
      } catch {
        // Never disrupt Udemy's native fetch
      }
      return resp;
    };

    // 2. Passive XHR hook (Shaka / Video.js frequently fetches `.vtt` via XMLHttpRequest!)
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
      return origOpen.call(this, method, url, async ?? true, username, password);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
      const urlStr = xhrUrlMap.get(this) ?? '';
      if (urlStr.includes('.vtt') || urlStr.includes('/api-2.0/')) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            // Only read responseText when responseType is '' or 'text'
            if (this.responseType === '' || this.responseType === 'text') {
              const txt = this.responseText;
              if (urlStr.includes('.vtt') || txt.trimStart().startsWith('WEBVTT')) {
                recordVttPayload(txt);
              } else if (urlStr.includes('/api-2.0/')) {
                const lectureHint = recordApiUrlMetadata(urlStr);
                scanJsonForCaptions(JSON.parse(txt), lectureHint);
              }
            } else if (this.responseType === 'json' && this.response && urlStr.includes('/api-2.0/')) {
              const lectureHint = recordApiUrlMetadata(urlStr);
              scanJsonForCaptions(this.response, lectureHint);
            }
          } catch {
            // Ignore non-text/binary XHRs
          }
        });
      }
      return origSend.call(this, body);
    };

    async function resolveCourseId(): Promise<string | null> {
      if (knownCourseId) return knownCourseId;

      // Check PerformanceResourceTiming for `/subscribed-courses/<id>` or `/courses/<id>`
      try {
        const resources = performance.getEntriesByType('resource');
        for (let i = resources.length - 1; i >= 0; i--) {
          const name = resources[i]?.name ?? '';
          const m = name.match(/\/(?:subscribed-courses|courses)\/(\d+)/);
          if (m?.[1]) {
            knownCourseId = m[1];
            return knownCourseId;
          }
        }
      } catch {
        // Ignore
      }

      // Check Udemy's DOM `data-module-args` (e.g. `{"courseId": 123456}`) or `data-clp-course-id`
      const bodyCourseId = document.body?.getAttribute('data-clp-course-id');
      if (bodyCourseId && /^\d+$/.test(bodyCourseId)) {
        knownCourseId = bodyCourseId;
        return knownCourseId;
      }

      const moduleEls = Array.from(document.querySelectorAll('[data-module-args]'));
      for (const el of moduleEls) {
        const rawArgs = el.getAttribute('data-module-args');
        if (!rawArgs) continue;
        try {
          const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
          const cid = parsed.courseId ?? parsed.course_id;
          if ((typeof cid === 'number' || typeof cid === 'string') && /^\d+$/.test(String(cid))) {
            knownCourseId = String(cid);
            return knownCourseId;
          }
        } catch {
          // Ignore malformed module args
        }
      }

      // Fallback: Same-origin Udemy course slug lookup
      const slug = resolveCourseSlug();
      if (slug) {
        try {
          const resp = await origFetch(`/api-2.0/courses/${encodeURIComponent(slug)}/?fields[course]=id`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json, text/plain, */*' },
          });
          if (resp.ok) {
            const data = (await resp.json()) as { id?: number | string };
            if (data?.id) {
              knownCourseId = String(data.id);
              return knownCourseId;
            }
          }
        } catch {
          // Ignore
        }
      }

      return null;
    }

    async function handleCaptionRequest(requestedVideoId: string): Promise<void> {
      // Layer A: Direct WebVTT payload already captured for this lecture!
      const cachedVtt = vttTextByLectureId.get(requestedVideoId);
      if (cachedVtt) {
        window.dispatchEvent(
          new CustomEvent('dubcera:udemy-captions-result', {
            detail: { videoId: requestedVideoId, ok: true, vttText: cachedVtt },
          }),
        );
        return;
      }

      // Layer B: Caption track metadata already intercepted for this lecture
      const cachedTracks = captionTracksByLectureId.get(requestedVideoId);
      const chosenCached = cachedTracks ? pickBestUdemyTrack(cachedTracks) : null;
      if (chosenCached?.url) {
        window.dispatchEvent(
          new CustomEvent('dubcera:udemy-captions-result', {
            detail: { videoId: requestedVideoId, ok: true, vttUrl: chosenCached.url },
          }),
        );
        return;
      }

      // Layer C: Official Same-Origin Authenticated Lecture API Lookup (works even when Udemy CC button is OFF!)
      if (/^\d+$/.test(requestedVideoId)) {
        const courseId = await resolveCourseId();
        if (courseId) {
          try {
            const apiUrl = `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${requestedVideoId}/?fields[lecture]=asset&fields[asset]=captions`;
            const resp = await origFetch(apiUrl, {
              credentials: 'same-origin',
              headers: { Accept: 'application/json, text/plain, */*' },
            });
            if (resp.ok) {
              const json = (await resp.json()) as unknown;
              scanJsonForCaptions(json, requestedVideoId);
              const tracks = captionTracksByLectureId.get(requestedVideoId) ?? [];
              const best = pickBestUdemyTrack(tracks);
              if (best?.url) {
                window.dispatchEvent(
                  new CustomEvent('dubcera:udemy-captions-result', {
                    detail: { videoId: requestedVideoId, ok: true, vttUrl: best.url },
                  }),
                );
                return;
              }
            }
          } catch {
            // Fall through to PerformanceResourceTiming / latest tracks
          }
        }
      }

      // Layer D: Scan PerformanceResourceTiming for any `.vtt` file already loaded by Udemy's player
      try {
        const resources = performance.getEntriesByType('resource');
        for (let i = resources.length - 1; i >= 0; i--) {
          const resUrl = resources[i]?.name ?? '';
          if (resUrl.includes('.vtt') && resUrl.startsWith('https://')) {
            window.dispatchEvent(
              new CustomEvent('dubcera:udemy-captions-result', {
                detail: { videoId: requestedVideoId, ok: true, vttUrl: resUrl },
              }),
            );
            return;
          }
        }
      } catch {
        // Ignore
      }

      // Layer E: Fallback to latest intercepted caption tracks (e.g. course landing preview modal)
      const fallbackTrack = pickBestUdemyTrack(latestCaptionTracks);
      if (fallbackTrack?.url) {
        window.dispatchEvent(
          new CustomEvent('dubcera:udemy-captions-result', {
            detail: { videoId: requestedVideoId, ok: true, vttUrl: fallbackTrack.url },
          }),
        );
        return;
      }

      window.dispatchEvent(
        new CustomEvent('dubcera:udemy-captions-result', {
          detail: { videoId: requestedVideoId, ok: false, reason: 'NO_CAPTION_TRACKS' },
        }),
      );
    }

    window.addEventListener('dubcera:request-udemy-captions', (ev: Event) => {
      const customEv = ev as CustomEvent<{ videoId?: string }>;
      const vid = customEv.detail?.videoId;
      if (vid) {
        void handleCaptionRequest(vid);
      }
    });
  },
});
