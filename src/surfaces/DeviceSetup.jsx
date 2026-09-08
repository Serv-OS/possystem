import { useState } from 'react';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

export default function DeviceSetup({ onSelectMode }) {
  const [hovered, setHovered] = useState(null);

  const choose = (mode) => {
    localStorage.setItem('rpos-device-mode', mode);
    onSelectMode(mode);
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', fontFamily: 'inherit', padding: 24,
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div style={{ margin: '0 auto 16px', width: 64 }}><ServOSIcon size={64} /></div>
        <ServOSWordmark fontSize={28} />
        <div style={{ fontSize: 15, color: 'var(--t3)', marginTop: 6 }}>
          What is this device being used for?
        </div>
      </div>

      {/* Choice cards */}
      <div style={{ display: 'flex', gap: 20, maxWidth: 680, width: '100%' }}>

        {/* POS Terminal */}
        <div
          onClick={() => choose('pos')}
          onMouseEnter={() => setHovered('pos')}
          onMouseLeave={() => setHovered(null)}
          style={{
            flex: 1, background: hovered === 'pos' ? 'var(--bg1)' : 'var(--bg)',
            border: `2px solid ${hovered === 'pos' ? 'var(--acc)' : 'var(--bdr)'}`,
            borderRadius: 16, padding: '32px 28px', cursor: 'pointer',
            transition: 'all .15s', textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 16 }}>🖥</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)', marginBottom: 8 }}>
            POS Terminal
          </div>
          <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.6, marginBottom: 20 }}>
            This device will be used by staff to take orders, process payments and manage tables.
          </div>
          <div style={{
            fontSize: 12, color: 'var(--t3)', background: 'var(--bg3)',
            borderRadius: 8, padding: '8px 12px', lineHeight: 1.5,
          }}>
            Requires a pairing code from your back office
          </div>
        </div>

        {/* Back Office */}
        <div
          onClick={() => choose('backoffice')}
          onMouseEnter={() => setHovered('backoffice')}
          onMouseLeave={() => setHovered(null)}
          style={{
            flex: 1, background: hovered === 'backoffice' ? 'var(--bg1)' : 'var(--bg)',
            border: `2px solid ${hovered === 'backoffice' ? 'var(--acc)' : 'var(--bdr)'}`,
            borderRadius: 16, padding: '32px 28px', cursor: 'pointer',
            transition: 'all .15s', textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 16 }}>🏢</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)', marginBottom: 8 }}>
            Back Office
          </div>
          <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.6, marginBottom: 20 }}>
            This device will be used by owners and managers to manage menus, staff, reports and settings.
          </div>
          <div style={{
            fontSize: 12, color: 'var(--t3)', background: 'var(--bg3)',
            borderRadius: 8, padding: '8px 12px', lineHeight: 1.5,
          }}>
            Requires a Serv OS account (email + password)
          </div>
        </div>

      </div>

      <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 32 }}>
        This choice is stored on this device. You can reset it in settings.
      </div>
    </div>
  );
}
