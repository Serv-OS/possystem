/**
 * KioskAttractScreen: tap to start (decision 4: KEEP it, with its video).
 * The banner and button wording settings are not used by the new design.
 * The whole screen is one tap target. Only kfade animates (README motion rule).
 *
 * Logo: big and centred above the venue name, like the old tap to start (Peter, 14 Sep).
 * No white plate here. The Start screen keeps its small logo plate top left.
 */
import { useEffect, useRef, useState } from 'react';
import { t, tf } from '../../lib/i18n';

// The logo fits inside this box (design px) and keeps its shape.
const LOGO_MAX_W = 540;
const LOGO_MAX_H = 384;
// How long the name and wait pill wait for the logo before they show anyway.
const LOGO_WAIT_MS = 1000;

/**
 * The logo's size in design px. The old tap to start drew the file at its own size in
 * screen px, and the canvas draws design px at its zoom, so its own size divided by the
 * zoom is the size the old screen showed on this kiosk. Shrunk to fit the box, never
 * made bigger than that, so a small file is not stretched soft.
 * Returns null when the file has no size of its own.
 */
function logoSize(img) {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!(nw > 0) || !(nh > 0)) return null;
  const canvasEl = img.closest('[data-kiosk-canvas]');
  const zoom = canvasEl ? parseFloat(canvasEl.style.zoom) : NaN;
  const z = zoom > 0 ? zoom : 1;
  const k = Math.min(1 / z, LOGO_MAX_W / nw, LOGO_MAX_H / nh);
  return { w: Math.round(nw * k), h: Math.round(nh * k) };
}

export default function KioskAttractScreen({ brandName, brandLogoUrl, attractVideoUrl, avgWaitMinutes, onStart }) {
  // Remember WHICH video or logo failed, so a new url gets its own try.
  const [failedVideo, setFailedVideo] = useState(null);
  const [failedLogo, setFailedLogo] = useState(null);
  // { url, size } once that logo has loaded; the url whose wait ran out.
  const [loadedLogo, setLoadedLogo] = useState(null);
  const [waitedLogo, setWaitedLogo] = useState(null);
  const logoRef = useRef(null);
  const showVideo = !!attractVideoUrl && failedVideo !== attractVideoUrl;
  const showLogo = !!brandLogoUrl && failedLogo !== brandLogoUrl;
  const logoLoaded = showLogo && !!loadedLogo && loadedLogo.url === brandLogoUrl;
  // The centred block waits for the logo, so the name does not jump down when it arrives.
  const blockReady = !showLogo || logoLoaded || waitedLogo === brandLogoUrl;
  const onDark = showVideo;
  const wait = Number(avgWaitMinutes);

  useEffect(() => {
    if (blockReady) return undefined;
    const url = brandLogoUrl;
    const id = window.setTimeout(() => {
      // If the load event was missed but the logo is there, use it.
      const img = logoRef.current;
      if (img && img.complete && img.naturalWidth > 0) setLoadedLogo({ url, size: logoSize(img) });
      else setWaitedLogo(url);
    }, LOGO_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [blockReady, brandLogoUrl]);

  let logoStyle = { display: 'block', maxWidth: LOGO_MAX_W, maxHeight: LOGO_MAX_H, objectFit: 'contain' };
  if (logoLoaded && loadedLogo.size) {
    logoStyle = { display: 'block', width: loadedLogo.size.w, height: loadedLogo.size.h, objectFit: 'contain' };
  } else if (logoLoaded) {
    // No size of its own (some SVG files): fill the box.
    logoStyle = { display: 'block', width: LOGO_MAX_W, height: 'auto', maxHeight: LOGO_MAX_H, objectFit: 'contain' };
  }

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
          {/* The whole video is dimmed, top to bottom, like the old tap to start, so the
              logo and name in the middle stay readable over a bright video. */}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(20,17,15,.2) 0%, rgba(20,17,15,.6) 100%)' }} />
        </>
      )}

      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', padding: '64px 56px 48px' }}>
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 36, textAlign: 'center',
          visibility: blockReady ? 'visible' : 'hidden',
          ...(brandLogoUrl && blockReady ? { animation: 'kfade .3s ease' } : null),
        }}>
          {showLogo ? (
            // Block wrapper, so the image sizes the plain way (not as a flex item). With the
            // gap that makes 56px above the name, like the old screen.
            // A new img per url, so the old picture never shows while a new logo loads.
            <div style={{ flex: 'none', marginBottom: 20 }}>
              <img
                key={brandLogoUrl}
                ref={logoRef}
                src={brandLogoUrl}
                alt=""
                draggable={false}
                onLoad={(e) => setLoadedLogo({ url: brandLogoUrl, size: logoSize(e.currentTarget) })}
                onError={() => setFailedLogo(brandLogoUrl)}
                style={logoStyle}
              />
            </div>
          ) : null}
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
