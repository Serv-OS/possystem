// src/surfaces/menu/MenuHeader.jsx
//
// Themeable storefront header — three treatments (cinematic / framed / compact), shared by online
// ordering, catering, and the back-office "Menu appearance" preview. Renders the real logo on a
// height-locked white plate (any shape), the venue wordmark, and status pills, over the uploaded
// header photo OR a brand-derived ember-gradient fallback. Always a clean straight bottom edge.
// Expects the parent wrapper to set container-type:inline-size (so the cqw clamps scale) + the theme
// CSS vars (deriveVars). Keyframes mh-flicker / mh-dotpulse live in globals.css.

import { logoGeom, EMBER_GRADIENT } from './menuTheme';

// White logo plate with the real logo. v5.5.745: NO logo uploaded → NO plate at all (a clean header
// with just the venue name), rather than a default/initial box — "remove the logo" means no square.
function LogoPlate({ theme, name, height, onWhite = false }) {
  if (!theme.logoUrl) return null;
  const g = logoGeom(theme.logoShape);
  const plate = {
    flex: 'none', height, padding: theme.logoShape === 'circle' ? 4 : 6, background: '#fff',
    borderRadius: g.plateRadius, display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: onWhite ? 'none' : '0 10px 26px rgba(0,0,0,.34)', border: onWhite ? '1px solid var(--line)' : 'none',
    ...(theme.logoShape === 'circle' ? { aspectRatio: '1 / 1' } : {}),
  };
  const imgStyle = {
    height: '100%', width: 'auto', maxWidth: 220, objectFit: g.fit, borderRadius: g.imgRadius,
    ...(g.aspect ? { aspectRatio: g.aspect, width: 'auto' } : {}),
    ...(theme.logoShape === 'circle' ? { aspectRatio: '1', borderRadius: '50%' } : {}),
  };
  return (
    <div style={plate}>
      <img src={theme.logoUrl} alt={name} style={imgStyle} />
    </div>
  );
}

function Pills({ pills, variant }) {
  // variant: 'dark' (cinematic/framed) | 'brand' (compact)
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: variant === 'compact' ? 0 : 12 }}>
      {(pills || []).map((p, i) => {
        const bg = p.green ? 'rgba(34,197,94,.22)' : variant === 'compact' ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.14)';
        const color = p.green ? '#bbf7d0' : '#fff';
        const border = p.green ? 'rgba(34,197,94,.4)' : variant === 'compact' ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.26)';
        return (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, background: bg, color, border: `1px solid ${border}`, backdropFilter: variant === 'compact' ? undefined : 'blur(4px)' }}>
            {p.dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', animation: 'mh-dotpulse 2s ease-in-out infinite' }} />}
            {p.label}
          </span>
        );
      })}
    </div>
  );
}

const Flicker = () => <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(118deg, rgba(255,160,60,.10) 0 2px, transparent 2px 16px)', mixBlendMode: 'screen', animation: 'mh-flicker 5s ease-in-out infinite', pointerEvents: 'none' }} />;
const photoBg = (url) => (url ? `url(${url}) center/cover no-repeat` : EMBER_GRADIENT);

export default function MenuHeader({ theme, name, pills, max = 1120 }) {
  const inner = { maxWidth: max, margin: '0 auto', width: '100%' };

  if (theme.headerStyle === 'framed') {
    return (
      <div style={{ background: '#1a1310', padding: 'clamp(16px,3.4cqw,26px)', borderBottom: '4px solid var(--brand)' }}>
        <div style={{ ...inner, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'clamp(16px,4cqw,28px)' }}>
          <div style={{ flex: '1 1 230px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <LogoPlate theme={theme} name={name} height="clamp(54px,11cqw,76px)" />
            <div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 'clamp(24px,6cqw,40px)', lineHeight: 1, color: '#fff', letterSpacing: '-.02em' }}>{name}</div>
              <Pills pills={pills} variant="dark" />
            </div>
          </div>
          <div style={{ flex: '1 1 280px', position: 'relative', minHeight: 'clamp(96px,18cqw,150px)', borderRadius: 16, overflow: 'hidden', background: photoBg(theme.headerImageUrl), boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.1)' }}>
            {!theme.headerImageUrl && <Flicker />}
          </div>
        </div>
      </div>
    );
  }

  if (theme.headerStyle === 'compact') {
    return (
      <div style={{ position: 'relative', background: 'linear-gradient(100deg, var(--brand) 0%, var(--brand-deep) 100%)', padding: 'clamp(14px,2.8cqw,20px) clamp(16px,3.4cqw,26px)', overflow: 'hidden', borderBottom: '4px solid var(--brand-deep)' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(90% 200% at 100% 0%, rgba(255,180,90,.5), transparent 55%)', pointerEvents: 'none' }} />
        <div style={{ ...inner, position: 'relative', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <LogoPlate theme={theme} name={name} height="clamp(44px,9cqw,58px)" />
          <div style={{ flex: '1 1 130px', minWidth: 0 }}>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 'clamp(20px,5cqw,32px)', lineHeight: 1, color: '#fff', letterSpacing: '-.02em' }}>{name}</div>
          </div>
          <div style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end' }}><Pills pills={pills} variant="compact" /></div>
        </div>
      </div>
    );
  }

  // cinematic (default) — full-bleed photo / ember, dark scrims, big wordmark + pills bottom-left.
  return (
    <div style={{ position: 'relative', minHeight: 'clamp(200px,40cqw,300px)', overflow: 'hidden', background: photoBg(theme.headerImageUrl) }}>
      {!theme.headerImageUrl && <Flicker />}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(10,5,3,.78) 0%, rgba(10,5,3,.22) 45%, transparent 75%)' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(0deg, rgba(8,4,2,.82) 0%, rgba(8,4,2,.10) 48%, transparent 70%)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <div style={{ ...inner, display: 'flex', alignItems: 'flex-end', gap: 'clamp(12px,3cqw,20px)', padding: 'clamp(18px,4cqw,30px)' }}>
          <LogoPlate theme={theme} name={name} height="clamp(56px,12cqw,84px)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 'clamp(26px,7cqw,48px)', lineHeight: 1, color: '#fff', letterSpacing: '-.02em', textShadow: '0 2px 18px rgba(0,0,0,.4)' }}>{name}</div>
            <Pills pills={pills} variant="dark" />
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, background: 'linear-gradient(90deg, var(--ember1), var(--brand), var(--brand-deep))' }} />
    </div>
  );
}
