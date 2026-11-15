interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface YouTubePlayerResponse {
  videoDetails?: { videoId?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
}

interface YouTubeMoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => YouTubePlayerResponse | undefined;
  loadModule?: (mod: string) => void;
  setOption?: (mod: string, key: string, val: unknown) => void;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Cache real `/api/timedtext` payloads fetched natively by YouTube's player (carries valid session/PO tokens)
    const interceptedPayloadsByVideoId = new Map<string, string>();

    function recordTimedTextIfValid(urlStr: string, bodyText: string): void {
      if (!urlStr.includes('/api/timedtext') || bodyText.trim().length < 20) return;
      try {
        const u = new URL(urlStr, location.origin);
        // Ignore YouTube's degraded cue-by-cue auto-translated captions (`tlang=`) so DubCera always gets clean source text
        if (u.searchParams.has('tlang')) return;
        const vid = u.searchParams.get('v');
        if (vid) {
          interceptedPayloadsByVideoId.set(vid, bodyText);
          window.dispatchEvent(
            new CustomEvent('dubcera:yt-captions-result', {
              detail: {
                videoId: vid,
                ok: true,
                languageCode: u.searchParams.get('lang') ?? 'auto',
                payload: bodyText,
              },
            }),
          );
        }
      } catch {
        // Ignore malformed URLs
      }
    }

    // 1. Passive fetch hook for `/api/timedtext`
    const originalFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
      const resp = await originalFetch.apply(this, args);
      try {
        const reqInfo = args[0];
        const urlStr =
          typeof reqInfo === 'string'
            ? reqInfo
            : reqInfo instanceof URL
              ? reqInfo.toString()
              : reqInfo?.url ?? '';
        if (urlStr.includes('/api/timedtext') && resp.ok) {
          void resp
            .clone()
            .text()
            .then((txt) => recordTimedTextIfValid(urlStr, txt))
            .catch(() => {});
        }
      } catch {
        // Never interfere with page fetch
      }
      return resp;
    };

    // 2. Passive XHR hook for `/api/timedtext` (YouTube desktop player frequently uses XMLHttpRequest for timedtext!)
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
      if (urlStr.includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300 && typeof this.responseText === 'string') {
              recordTimedTextIfValid(urlStr, this.responseText);
            }
          } catch {
            // Ignore non-text responseType
          }
        });
      }
      return origSend.call(this, body);
    };

    function pickBestTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack | null {
      if (tracks.length === 0) return null;
      const enManual = tracks.find(
        (t) => t.languageCode?.startsWith('en') && t.kind !== 'asr' && Boolean(t.baseUrl),
      );
      if (enManual) return enManual;
      const enAsr = tracks.find((t) => t.languageCode?.startsWith('en') && Boolean(t.baseUrl));
      if (enAsr) return enAsr;
      const nonVi = tracks.find((t) => !t.languageCode?.startsWith('vi') && Boolean(t.baseUrl));
      return nonVi ?? tracks.find((t) => Boolean(t.baseUrl)) ?? null;
    }

    async function extractAndFetchForVideo(requestedVideoId: string): Promise<void> {
      // Layer A: Return immediately if native player already fetched `/api/timedtext` for this video!
      const alreadyIntercepted = interceptedPayloadsByVideoId.get(requestedVideoId);
      if (alreadyIntercepted) {
        window.dispatchEvent(
          new CustomEvent('dubcera:yt-captions-result', {
            detail: {
              videoId: requestedVideoId,
              ok: true,
              languageCode: 'intercepted',
              payload: alreadyIntercepted,
            },
          }),
        );
        return;
      }

      const moviePlayer = document.getElementById('movie_player') as YouTubeMoviePlayerElement | null;
      let playerResp = moviePlayer?.getPlayerResponse?.();
      if (!playerResp || playerResp.videoDetails?.videoId !== requestedVideoId) {
        const winResp = (window as unknown as { ytInitialPlayerResponse?: YouTubePlayerResponse })
          .ytInitialPlayerResponse;
        if (winResp?.videoDetails?.videoId === requestedVideoId) {
          playerResp = winResp;
        }
      }

      const tracks = playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const chosen = pickBestTrack(tracks);

      if (!chosen?.baseUrl) {
        window.dispatchEvent(
          new CustomEvent('dubcera:yt-captions-result', {
            detail: { videoId: requestedVideoId, ok: false, reason: 'NO_CAPTION_TRACKS' },
          }),
        );
        return;
      }

      // Layer B: Try direct fetch on chosen.baseUrl
      try {
        for (const fmt of ['json3', 'vtt', '']) {
          const fetchUrl = new URL(chosen.baseUrl);
          if (fmt) fetchUrl.searchParams.set('fmt', fmt);
          const resp = await originalFetch(fetchUrl.toString(), { credentials: 'same-origin' });
          if (resp.ok) {
            const txt = await resp.text();
            if (txt.trim().length > 20) {
              interceptedPayloadsByVideoId.set(requestedVideoId, txt);
              window.dispatchEvent(
                new CustomEvent('dubcera:yt-captions-result', {
                  detail: {
                    videoId: requestedVideoId,
                    ok: true,
                    languageCode: chosen.languageCode ?? 'en',
                    payload: txt,
                  },
                }),
              );
              return;
            }
          }
        }
      } catch {
        // Fall through to Layer C
      }

      // Layer C: Trigger YouTube's own CC button / captions module so YouTube fetches `/api/timedtext` with its PO token
      const ccBtn = document.querySelector('.ytp-subtitles-button') as HTMLButtonElement | null;
      if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
        ccBtn.click();
      } else {
        moviePlayer?.loadModule?.('captions');
        if (chosen.languageCode) {
          moviePlayer?.setOption?.('captions', 'track', { languageCode: chosen.languageCode });
        }
      }
    }

    window.addEventListener('dubcera:request-yt-captions', (ev: Event) => {
      const customEv = ev as CustomEvent<{ videoId?: string }>;
      const vid = customEv.detail?.videoId;
      if (vid) {
        void extractAndFetchForVideo(vid);
      }
    });
  },
});
