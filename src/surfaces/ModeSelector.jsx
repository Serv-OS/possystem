import { useState } from 'react';
import { VERSION } from '../lib/version';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

function Card({ icon, title, desc, note, accent, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? '#1e2235' : '#161926',
        border: `2px solid ${hover ? accent : '#2d3148'}`,
        borderRadius: 16, padding: '32px 28px',
        cursor: 'pointer', textAlign: 'left',
        fontFamily: 'inherit', transition: 'all .18s',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
      <div style={{ fontSize: 36, lineHeight: 1 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#f1f5f9' }}>{title}</div>
      <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>{desc}</div>
      {note && <div style={{ fontSize: 12, color: accent, fontWeight: 600, marginTop: 4 }}>{note}</div>}
    </button>
  );
}

export default function ModeSelector({ onSelectPOS, onSelectBackOffice, onSelectAdmin, onSelectMPOS, onSelectClock, onSelectMenuBoard, onSelectOps }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f1117',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'inherit', padding: 40,
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 56 }}>
        <div style={{ margin: '0 auto 20px', width: 56 }}><ServOSIcon size={56} /></div>
        <div style={{ marginBottom: 10 }}><ServOSWordmark fontSize={34} color="#f1f5f9" /></div>
        <div style={{ fontSize: 16, color: '#64748b' }}>What is this device being used for?</div>
      </div>

      {/* Main cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20, width: '100%', maxWidth: 720, marginBottom: 20 }}>
        <Card
          icon="🖥"
          title="POS Terminal"
          desc="A till, counter screen, or handheld used by staff to take orders and process payments."
          note="Requires a pairing code from Back Office"
          accent="#E8743C"
          onClick={onSelectPOS}
        />
        <Card
          icon="📱"
          title="MPOS (mobile)"
          desc="A phone or Sunmi handheld used by servers and runners — portrait UI, Stripe Tap to Pay, walk-in orders."
          note="Pairs to a location like a regular POS"
          accent="#22c55e"
          onClick={onSelectMPOS}
        />
        <Card
          icon="🕐"
          title="Time Clock"
          desc="A dedicated tablet by the staff entrance — staff enter their PIN to clock in/out and take breaks."
          note="Pairs to a location like a regular POS"
          accent="#a855f7"
          onClick={onSelectClock}
        />
        <Card
          icon="🏢"
          title="Back Office"
          desc="For owners and managers — menu builder, staff, reports, device management and settings."
          note="Requires a Serv OS account"
          accent="#6366f1"
          onClick={onSelectBackOffice}
        />
        <Card
          icon="📺"
          title="Menu Board"
          desc="A TV or display showing your menu — categories, prices and allergens, updating live. Marks items sold out automatically."
          note="Pairs to a location like a regular POS"
          accent="#0ea5e9"
          onClick={onSelectMenuBoard}
        />
        <Card
          icon="🌡"
          title="Operations"
          desc="Mobile food-safety & ops — temperature checks, deliveries, checklists and maintenance, with manager alerts on a breach."
          note="Pairs to a location, then staff sign in by PIN"
          accent="#15C26A"
          onClick={onSelectOps}
        />
      </div>

      {/* Internal admin — subtle */}
      <div style={{ width: '100%', maxWidth: 680 }}>
        <button
          onClick={onSelectAdmin}
          style={{
            width: '100%', padding: '14px 20px',
            background: 'transparent', border: '1px solid #2d3148',
            borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 12,
            transition: 'all .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#1a1d27'; e.currentTarget.style.borderColor = '#6366f1'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#2d3148'; }}
        >
          <span style={{ fontSize: 18 }}>🔐</span>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#64748b' }}>Serv OS Internal — Company Admin</div>
            <div style={{ fontSize: 12, color: '#334155' }}>Your internal tool for creating and managing venues on the platform</div>
          </div>
        </button>
      </div>

      <div style={{ marginTop: 28, fontSize: 11, color: '#334155', fontFamily: 'monospace' }}>v{VERSION} · Choice saved to this device</div>
    </div>
  );
}
