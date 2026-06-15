// src/backoffice/sections/WifiManager.jsx
//
// WiFi Manager — back office container for guest WiFi data capture. Tabs:
//   Your page   — live-preview editor for the branded captive portal (WifiPortal)
//   Setup       — connect the venue's UniFi guest network + voucher pool (WifiSetup)
//   Dashboard   — captures, opt-in rate, CRM segments + CSV export (WifiDashboard)
// Mirrors the Review Manager container.

import { useState } from 'react';
import WifiPortal from './wifi/WifiPortal';
import WifiSetup from './wifi/WifiSetup';
import WifiDashboard from './wifi/WifiDashboard';

const TABS = [
  ['page', 'Your page', WifiPortal],
  ['dashboard', 'Dashboard', WifiDashboard],
  ['setup', 'Setup', WifiSetup],
];

export default function WifiManager() {
  const [tab, setTab] = useState('page');
  const Active = (TABS.find(t => t[0] === tab) || TABS[0])[2];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap', borderBottom: '1px solid var(--bdr)', paddingBottom: 12 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            border: '1px solid var(--bdr)',
            background: tab === id ? 'var(--acc)' : 'var(--bg1)',
            color: tab === id ? '#0b0c10' : 'var(--t2)',
          }}>{label}</button>
        ))}
      </div>
      <Active />
    </div>
  );
}
