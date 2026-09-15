/**
 * KioskChrome: small pieces shared by the new kiosk design screens.
 * Every size is README design px (the canvas scales them). No vw, vh or clamp.
 */
import { useState } from 'react';
import { t, getLanguageMeta } from '../../lib/i18n';
import { photoBlock } from '../../lib/kioskTheme';
import { BackIcon, CloseIcon, TickIcon } from './KioskIcons';

/**
 * The venue logo in the README logo plate (white, radius 10, padding 8, about 96 tall).
 * A wide logo grows sideways up to 360. With no logo, or a logo that fails to load, the
 * brand name shows at 34px/800 ink instead (when showName is true).
 */
export function KioskLogoPlate({ logoUrl, brandName, showName = true }) {
  // Remember WHICH url failed, so a new logo url gets its own try.
  const [failedUrl, setFailedUrl] = useState(null);
  if (logoUrl && failedUrl !== logoUrl) {
    return (
      <div style={{ background: '#FFFFFF', borderRadius: 10, padding: 8, height: 96, maxWidth: 360, display: 'flex', alignItems: 'center', flex: 'none' }}>
        <img
          src={logoUrl}
          alt={brandName || ''}
          draggable={false}
          onError={() => setFailedUrl(logoUrl)}
          style={{ height: 80, width: 'auto', maxWidth: 344, objectFit: 'contain', display: 'block' }}
        />
      </div>
    );
  }
  if (!showName || !brandName) return <div style={{ height: 96 }} />;
  return (
    <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1, letterSpacing: '-0.02em', maxWidth: 560, overflowWrap: 'anywhere' }}>
      {brandName}
    </div>
  );
}

/** README "Cancel" pill: 1px border, transparent, radius 999, padding 16px 22px, 19px/600. */
export function KioskCancelPill({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: '1px solid rgba(0,0,0,.15)', background: 'transparent', borderRadius: 999,
        padding: '16px 22px', fontSize: 19, fontWeight: 600, color: 'var(--k2InkMuted)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, minHeight: 64, flex: 'none',
      }}
    >
      <CloseIcon size={20} />
      <span>{t('k2.common.cancel')}</span>
    </button>
  );
}

/** README language pill: white, radius 999, padding 16px 26px, 20px/600, flag and name. */
export function KioskLanguagePill({ lang, onClick }) {
  const meta = getLanguageMeta(lang);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('language.choose')}
      style={{
        border: 0, background: '#FFFFFF', borderRadius: 999, padding: '16px 26px',
        fontSize: 20, fontWeight: 600, color: 'var(--k2InkBody)', display: 'flex',
        alignItems: 'center', gap: 10, cursor: 'pointer', minHeight: 64, flex: 'none',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 24, lineHeight: 1 }}>{meta.flag}</span>
      <span>{meta.nativeName}</span>
    </button>
  );
}

/** README back button: 64 by 64, radius 20. `deep` is the cream card screen version. */
export function KioskBackButton({ onClick, deep = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('k2.common.back')}
      style={{
        border: 0, background: deep ? 'var(--k2GroundDeep)' : 'var(--k2Neutral)', width: 64, height: 64,
        borderRadius: 20, display: 'grid', placeItems: 'center', color: 'var(--k2Ink)', cursor: 'pointer', flex: 'none',
      }}
    >
      <BackIcon size={28} />
    </button>
  );
}

/** README round close button on sheets: 64 by 64, radius 999. */
export function KioskCloseButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label || t('k2.common.close')}
      style={{
        border: 0, background: 'var(--k2Neutral)', width: 64, height: 64, borderRadius: 999,
        display: 'grid', placeItems: 'center', color: 'var(--k2Ink)', cursor: 'pointer', flex: 'none',
      }}
    >
      <CloseIcon size={26} />
    </button>
  );
}

/**
 * A photo slot: the image (cover crop) over the venue colour block (README placeholder
 * gradient, alpha 88). With no image, or an image that fails to load, the block shows, so
 * the slot keeps its size (decision: item cards with no photo show the brand colour).
 * width may be a number or '100%'.
 */
// dim: opacity for the photo and its colour block only. Children (badges) always draw at full
// opacity, so an Unsafe or Sold out badge stays readable on a dimmed card.
export function KioskPhoto({ image, color, width, height, radius, dim = 1, children }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const show = !!image && failedUrl !== image;
  return (
    <div style={{ position: 'relative', width, height, maxWidth: '100%', flex: 'none', borderRadius: radius, overflow: 'hidden' }}>
      {/* dim fades the colour block and the photo as ONE layer: the photo covers the block at
          full strength inside it, so a dimmed photo never picks up the brand colour behind. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, opacity: dim }}>
        <div style={{ position: 'absolute', inset: 0, background: photoBlock(color, '88') }} />
        {show ? (
          <img
            src={image}
            alt=""
            draggable={false}
            loading="lazy"
            onError={() => setFailedUrl(image)}
            style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * README bottom sheet: scrim, white sheet with radius 40px 40px 0 0, kfade .22s.
 * Tapping the scrim closes it unless closeOnScrim is false.
 */
export function KioskBottomSheet({ label, onClose, closeOnScrim = true, padding = 40, gap = 22, maxHeight = 'calc(100% - 140px)', children }) {
  return (
    <div
      onClick={closeOnScrim ? onClose : undefined}
      style={{ position: 'absolute', inset: 0, background: 'var(--k2Scrim)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', zIndex: 30 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: '40px 40px 0 0', padding, display: 'flex', flexDirection: 'column', gap,
          maxHeight, minHeight: 0, overflowY: 'auto', animation: 'kfade .22s ease',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** README sheet head: a 40px/800 title, a 21px sub line and the round close button. */
export function KioskSheetHead({ title, sub, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flex: 'none' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1 }}>{title}</div>
        {sub ? <div style={{ fontSize: 21, color: 'var(--k2InkSubtle)', marginTop: 6, lineHeight: 1.35 }}>{sub}</div> : null}
      </div>
      <KioskCloseButton onClick={onClose} />
    </div>
  );
}

/** README 5.5 checkbox: 48 by 48, radius 14, neutral when off, primary with a white tick when on. */
export function KioskCheckBox({ checked }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 48, height: 48, borderRadius: 14, flex: 'none', display: 'grid', placeItems: 'center',
        background: checked ? 'var(--k2Primary)' : 'var(--k2Neutral)', color: 'var(--k2OnPrimary)',
      }}
    >{checked ? <TickIcon size={30} /> : null}</span>
  );
}

/** README neutral pill button (Add more, Change): #F1ECE6, radius 999, padding 13px 24px, 19px/700. */
export function KioskPillButton({ onClick, children, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        border: 0, background: 'var(--k2Neutral)', borderRadius: 999, padding: '13px 24px', fontSize: 19, fontWeight: 700,
        color: 'var(--k2Ink)', cursor: 'pointer', flex: 'none', minHeight: 64,
      }}
    >{children}</button>
  );
}
