import React from 'react';
import type { DisplayChunk, SubtitleDisplayMode } from '@dubcera/core';

export interface SubtitleOverlayProps {
  chunk: DisplayChunk | null;
  mode: SubtitleDisplayMode;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({ chunk, mode }) => {
  if (!chunk || mode === 'OFF') return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '54px',
        transform: 'translateX(-50%)',
        maxWidth: '82%',
        zIndex: 2147483640,
        pointerEvents: 'none',
        textAlign: 'center',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          display: 'inline-block',
          padding: '8px 16px',
          borderRadius: '10px',
          background: 'rgba(10, 14, 23, 0.82)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
        }}
      >
        <div
          style={{
            color: '#F8FAFC',
            fontSize: '19px',
            fontWeight: 600,
            lineHeight: 1.4,
            letterSpacing: '0.01em',
            textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          }}
        >
          {chunk.text}
        </div>
        {mode === 'BILINGUAL' && chunk.sourceExcerpt && (
          <div
            style={{
              marginTop: '4px',
              color: '#94A3B8',
              fontSize: '13.5px',
              fontWeight: 400,
              lineHeight: 1.35,
            }}
          >
            {chunk.sourceExcerpt}
          </div>
        )}
      </div>
    </div>
  );
};
