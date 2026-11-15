import React from 'react';

export interface BufferingBadgeProps {
  bufferingMessage: string | null;
  autoplayBlocked: boolean;
  onExplicitPause: () => void;
  onResumeAutoplay: () => void;
}

export const BufferingBadge: React.FC<BufferingBadgeProps> = ({
  bufferingMessage,
  autoplayBlocked,
  onExplicitPause,
  onResumeAutoplay,
}) => {
  if (!bufferingMessage && !autoplayBlocked) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: '18px',
        right: '18px',
        zIndex: 2147483645,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 14px',
        borderRadius: '999px',
        background: 'rgba(15, 23, 42, 0.92)',
        border: '1px solid rgba(56, 189, 248, 0.45)',
        color: '#E0F2FE',
        fontSize: '13px',
        fontWeight: 500,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
      }}
    >
      {autoplayBlocked ? (
        <>
          <span>Trình duyệt tạm chặn tự phát tiếp</span>
          <button
            type="button"
            onClick={onResumeAutoplay}
            style={{
              cursor: 'pointer',
              border: 'none',
              borderRadius: '999px',
              padding: '4px 12px',
              background: '#0EA5E9',
              color: '#FFFFFF',
              fontWeight: 600,
              fontSize: '12px',
            }}
          >
            Tiếp tục phát
          </button>
        </>
      ) : (
        <>
          <span
            style={{
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              background: '#38BDF8',
              display: 'inline-block',
            }}
          />
          <span>{bufferingMessage}</span>
          <button
            type="button"
            onClick={onExplicitPause}
            style={{
              cursor: 'pointer',
              border: '1px solid rgba(248, 113, 113, 0.5)',
              borderRadius: '999px',
              padding: '3px 10px',
              background: 'rgba(127, 29, 29, 0.55)',
              color: '#FECACA',
              fontWeight: 600,
              fontSize: '12px',
            }}
          >
            Tạm dừng
          </button>
        </>
      )}
    </div>
  );
};
