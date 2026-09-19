// src/components/secondStep/AuthUi.jsx
//
// The sign in screens' look: ServOS Brand v2 (Ink, Coal, Mist, Signal green, Space Grotesk,
// JetBrains Mono labels). Shared by the Back Office password screen (BOLogin), the second
// step screens (SecondStepGate) and the Sign in security page, so they read as one flow.
//
// tone 'dark'  fixed Brand v2 dark tokens (Back Office and admin sign in are always dark)
// tone 'auto'  the ServOS skin CSS variables, so the Owner app keeps its light or dark theme

import { ServOSIcon, ServOSWordmark } from '../ServOSBrand';
import { tokens } from './authTokens';

const FONT = "'Space Grotesk', system-ui, -apple-system, sans-serif";
const MONO = "'JetBrains Mono', 'SF Mono', Menlo, monospace";

/** Full screen frame: brand panel on the left (wide screens), content on the right. */
export function AuthFrame({ tone = 'dark', area = 'Back Office', headline, blurb, children, footer }) {
  const t = tokens(tone);
  return (
    <div className="ss-frame" style={{ minHeight: '100vh', display: 'flex', background: t.bg, color: t.text, fontFamily: FONT }}>
      <style>{`
        .ss-frame .ss-side { display: flex; }
        .ss-frame .ss-top { display: none; }
        @media (max-width: 860px) {
          .ss-frame .ss-side { display: none; }
          .ss-frame .ss-top { display: flex; }
          .ss-frame .ss-main { padding: 28px 18px 40px !important; align-items: flex-start !important; }
        }
      `}</style>
      <aside className="ss-side" style={{
        width: 400, flexShrink: 0, flexDirection: 'column', padding: '44px 40px',
        background: t.panel, borderRight: `1px solid ${t.line}`,
      }}>
        <Brand tone={tone} area={area} />
        <div style={{ marginTop: 'auto', marginBottom: 'auto', paddingTop: 72 }}>
          <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.18, letterSpacing: '-0.02em', color: t.text }}>
            {headline || 'Run the whole restaurant from one place'}
          </div>
          <div style={{ fontSize: 15, color: t.sub, lineHeight: 1.65, marginTop: 14 }}>
            {blurb || 'Menus, team, devices, payments and reports. Signed in securely, with a second step only you can do.'}
          </div>
        </div>
        {footer}
      </aside>
      <main className="ss-main" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div className="ss-top" style={{ marginBottom: 28 }}><Brand tone={tone} area={area} /></div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function Brand({ tone = 'dark', area = 'Back Office' }) {
  const t = tokens(tone);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <ServOSIcon size={40} style={{ color: t.text }} />
      <div>
        <ServOSWordmark fontSize={20} color={t.text} />
        <MonoLabel tone={tone} style={{ color: t.accText, marginTop: 3 }}>{area}</MonoLabel>
      </div>
    </div>
  );
}

export function MonoLabel({ tone = 'dark', children, style }) {
  const t = tokens(tone);
  return (
    <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase', color: t.sub, ...style }}>
      {children}
    </div>
  );
}

export function Heading({ tone = 'dark', title, sub, step }) {
  const t = tokens(tone);
  return (
    <div style={{ marginBottom: 26 }}>
      {step && <MonoLabel tone={tone} style={{ marginBottom: 10 }}>{step}</MonoLabel>}
      <div style={{ fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em', color: t.text, lineHeight: 1.2 }}>{title}</div>
      {sub && <div style={{ fontSize: 15, color: t.sub, marginTop: 10, lineHeight: 1.6 }}>{sub}</div>}
    </div>
  );
}

export function PrimaryButton({ tone = 'dark', children, disabled, busy, onClick, type = 'button', testId, icon }) {
  const t = tokens(tone);
  const off = disabled || busy;
  return (
    <button type={type} onClick={onClick} disabled={off} data-testid={testId} style={{
      width: '100%', minHeight: 54, padding: '14px 18px', borderRadius: 14, border: 'none',
      background: off ? t.field : t.acc, color: off ? t.faint : t.accInk,
      fontFamily: FONT, fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em',
      cursor: off ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      boxShadow: off ? 'none' : '0 6px 22px rgba(21,194,106,0.25)', transition: 'background .15s',
    }}>
      {icon}{busy ? 'Please wait…' : children}
    </button>
  );
}

export function SecondaryButton({ tone = 'dark', children, disabled, onClick, testId }) {
  const t = tokens(tone);
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-testid={testId} style={{
      width: '100%', minHeight: 50, padding: '12px 18px', borderRadius: 14, border: `1px solid ${t.line}`,
      background: 'transparent', color: t.text, fontFamily: FONT, fontSize: 16, fontWeight: 600,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>
      {children}
    </button>
  );
}

export function LinkButton({ tone = 'dark', children, onClick, testId, style }) {
  const t = tokens(tone);
  return (
    <button type="button" onClick={onClick} data-testid={testId} style={{
      background: 'none', border: 'none', padding: '6px 0', color: t.accText, fontFamily: FONT,
      fontSize: 15, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, ...style,
    }}>
      {children}
    </button>
  );
}

export function Note({ tone = 'dark', kind = 'info', children, testId }) {
  if (!children) return null;
  const t = tokens(tone);
  const map = {
    info: { bg: t.accSoft, line: t.accLine, color: t.text },
    error: { bg: t.errSoft, line: t.errLine, color: t.err },
    warn: { bg: t.warnSoft, line: t.warn, color: t.text },
  };
  const c = map[kind] || map.info;
  return (
    <div role={kind === 'error' ? 'alert' : undefined} data-testid={testId} style={{
      padding: '12px 14px', borderRadius: 12, background: c.bg, border: `1px solid ${c.line}`,
      color: c.color, fontSize: 14.5, lineHeight: 1.55,
    }}>
      {children}
    </div>
  );
}

/** Six big digits. Paste friendly; the phone keyboard shows numbers; the phone can autofill. */
export function CodeInput({ tone = 'dark', value, onChange, onDone, autoFocus = true, testId = 'second-step-code', label = 'Your 6 digit code' }) {
  const t = tokens(tone);
  return (
    <label style={{ display: 'block' }}>
      <MonoLabel tone={tone} style={{ marginBottom: 8 }}>{label}</MonoLabel>
      <input
        data-testid={testId}
        value={value}
        onChange={(e) => {
          const v = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
          onChange(v);
          if (v.length === 6 && onDone) onDone(v);
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={7}
        autoFocus={autoFocus}
        placeholder="000000"
        aria-label={label}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '14px 16px', borderRadius: 14,
          border: `1.5px solid ${t.line}`, background: t.field, color: t.text, outline: 'none',
          fontFamily: MONO, fontSize: 30, letterSpacing: '0.42em', textAlign: 'center',
        }}
      />
    </label>
  );
}

export function TextInput({ tone = 'dark', label, type = 'text', value, onChange, placeholder, autoComplete, autoFocus, testId }) {
  const t = tokens(tone);
  return (
    <label style={{ display: 'block' }}>
      <MonoLabel tone={tone} style={{ marginBottom: 8 }}>{label}</MonoLabel>
      <input
        data-testid={testId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '13px 15px', borderRadius: 12,
          border: `1.5px solid ${t.line}`, background: t.field, color: t.text, outline: 'none',
          fontFamily: FONT, fontSize: 16,
        }}
      />
    </label>
  );
}

export function Stack({ gap = 14, children, style }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>;
}

/** A fingerprint mark for the Face ID button (plain SVG, currentColor). */
export function FaceIdIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.1 3.6 1.1 5 0" />
    </svg>
  );
}
