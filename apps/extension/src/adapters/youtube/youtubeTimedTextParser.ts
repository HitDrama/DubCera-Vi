import { cleanSubtitleText, deduplicateRollingCues, parseVtt, type SubtitleCue } from '@dubcera/core';

interface YouTubeJson3Seg {
  utf8?: string;
}

interface YouTubeJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: YouTubeJson3Seg[];
}

interface YouTubeJson3Payload {
  events?: YouTubeJson3Event[];
}

function stripInlineSoundDescriptors(text: string): string {
  return text
    .replace(/\[(?:music|singing|applause|laughter|âm nhạc|tiếng hát|vỗ tay)[^\]]*\]/gi, ' ')
    .replace(/\((?:music|singing|applause|laughter)[^)]*\)/gi, ' ')
    .replace(/♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseYouTubeTimedTextPayload(payload: string): SubtitleCue[] {
  const trimmed = payload.trim();
  if (!trimmed) return [];

  // 1. JSON3 format (`&fmt=json3`)
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as YouTubeJson3Payload;
      const events = parsed.events ?? [];
      const cues: SubtitleCue[] = [];
      let counter = 0;

      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        if (typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs) || ev.segs.length === 0) {
          continue;
        }
        const joined = ev.segs.map((s) => s.utf8 ?? '').join('');
        const cleaned = stripInlineSoundDescriptors(cleanSubtitleText(joined));
        if (!cleaned) continue;

        const startMs = Math.max(0, Math.round(ev.tStartMs));
        let durationMs = typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0 ? ev.dDurationMs : 2500;

        // Clamp overlapping auto-caption display windows to next spoken event start so cues don't overlap artificially
        for (let nextIdx = i + 1; nextIdx < events.length; nextIdx++) {
          const nextEv = events[nextIdx]!;
          if (typeof nextEv.tStartMs === 'number' && nextEv.tStartMs > startMs && nextEv.segs?.some((s) => (s.utf8 ?? '').trim())) {
            durationMs = Math.min(durationMs, nextEv.tStartMs - startMs);
            break;
          }
        }

        const endMs = startMs + Math.max(250, Math.round(durationMs));
        counter += 1;
        cues.push({
          cueId: `yt-j3-${counter}`,
          startMs,
          endMs,
          rawText: cleaned,
        });
      }
      return deduplicateRollingCues(cues);
    } catch {
      // Fall through
    }
  }

  // 2. WebVTT format (`&fmt=vtt`)
  if (/^WEBVTT/i.test(trimmed)) {
    return parseVtt(trimmed)
      .map((c) => ({ ...c, rawText: stripInlineSoundDescriptors(c.rawText) }))
      .filter((c) => c.rawText.length > 0);
  }

  // 3. XML timedtext (`<transcript><text start="1.23" dur="2.5">...</text></transcript>` or `<timedtext><body><p t="1230" d="2500">`)
  // Parsed without DOMParser so YouTube TrustedTypes policies never interfere
  if (trimmed.startsWith('<')) {
    const cues: SubtitleCue[] = [];
    let counter = 0;

    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRegex.exec(trimmed)) !== null) {
      const attrs = pMatch[1] ?? '';
      const inner = pMatch[2] ?? '';
      const tAttr = /\bt="(\d+)"/i.exec(attrs)?.[1];
      if (!tAttr) continue;
      const dAttr = /\bd="(\d+)"/i.exec(attrs)?.[1];
      const startMs = Number(tAttr);
      const durMs = dAttr ? Number(dAttr) : 2500;
      const cleaned = stripInlineSoundDescriptors(cleanSubtitleText(inner));
      if (!cleaned || Number.isNaN(startMs)) continue;
      counter += 1;
      cues.push({
        cueId: `yt-srv3-${counter}`,
        startMs: Math.round(startMs),
        endMs: Math.round(startMs + Math.max(250, durMs)),
        rawText: cleaned,
      });
    }
    if (cues.length > 0) {
      return deduplicateRollingCues(cues);
    }

    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = textRegex.exec(trimmed)) !== null) {
      const attrs = tMatch[1] ?? '';
      const inner = tMatch[2] ?? '';
      const startAttr = /\bstart="([\d.]+)"/i.exec(attrs)?.[1];
      if (!startAttr) continue;
      const durAttr = /\bdur="([\d.]+)"/i.exec(attrs)?.[1];
      const startSec = Number(startAttr);
      const durSec = durAttr ? Number(durAttr) : 2.5;
      const cleaned = stripInlineSoundDescriptors(cleanSubtitleText(inner));
      if (!cleaned || Number.isNaN(startSec)) continue;
      counter += 1;
      const startMs = Math.round(startSec * 1000);
      cues.push({
        cueId: `yt-xml-${counter}`,
        startMs,
        endMs: startMs + Math.max(250, Math.round(durSec * 1000)),
        rawText: cleaned,
      });
    }
    return deduplicateRollingCues(cues);
  }

  return [];
}
