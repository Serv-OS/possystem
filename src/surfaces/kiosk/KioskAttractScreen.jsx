/**
 * KioskAttractScreen: tap to start (decision 4: KEEP it, with its video).
 * The banner and button wording settings are not used by the new design.
 * The whole screen is one tap target. Only kfade animates (README motion rule).
 */
import { useState } from 'react';
import { t, tf } from '../../lib/i18n';
import { KioskLogoPlate } from './KioskChrome';

export default function KioskAttractScreen({ brandName, brandLogoUrl, attractVideoUrl, avgWaitMinutes, onStart }) {
  // Remember WHICH video failed, so a new url gets its own try.
  const [failedVideo, setFailedVideo] = useState(null);
  const showVideo = !!attractVideoUrl && failedVideo !== attractVideoUrl;
  const onDark = showVideo;
  const wait = Number(avgWaitMinutes);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('k2.attract.tap')}
      onClick={onStart}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStart(); } }}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden', cursor: 'pointer',
        background: 'var(--k2Ground)', animation: 'kfade .3s ease',
      }}
    >
      {showVideo && (
        <>
          <video
            src={attractVideoUrl}
            autoPlay
            loop
            muted
            playsInline
            onError={() => { console.warn('[kiosk] attract video failed to load (try MP4):', attractVideoUrl); setFailedVideo(attractVideoUrl); }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(20,17,15,0) 40%, rgba(20,17,15,.55) 100%)' }} />
        </>
      )}

      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', padding: '64px 56px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 96 }}>
          {brandLogoUrl ? <KioskLogoPlate logoUrl={brandLogoUrl} brandName={brandName} showName={false} /> : null}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 36, textAlign: 'center' }}>
          {brandName ? (
            <div style={{
              fontSize: 76, fontWeight: 800, lineHeight: 1.02, letterSpacing: '-0.03em', textWrap: 'balance',
              color: onDark ? '#FFFFFF' : 'var(--k2Ink)', maxWidth: 900, overflowWrap: 'anywhere',
              textShadow: onDark ? '0 4px 30px rgba(0,0,0,.35)' : 'none',
            }}>{brandName}</div>
          ) : null}
          {Number.isFinite(wait) && wait > 0 ? (
            <div style={{ background: '#FFFFFF', color: 'var(--k2Ink)', borderRadius: 999, padding: '16px 26px', fontSize: 20, fontWeight: 600 }}>
              {tf('k2.attract.wait', { n: Math.round(wait) })}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 24 }}>
          <div style={{
            height: 132, borderRadius: 30, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)',
            fontSize: 36, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 18px 40px rgba(0,0,0,.22)',
          }}>{t('k2.attract.tap')}</div>
          <div style={{ fontSize: 20, textAlign: 'center', color: onDark ? '#FFFFFF' : 'var(--k2InkSubtle)' }}>
            {t('k2.attract.hint')}
          </div>
        </div>
      </div>
    </div>
  );
}
