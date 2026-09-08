// src/backoffice/sections/ReviewManager.jsx
//
// Review Manager — back office container. Tabs across the four working surfaces:
//   Approvals  — the queue: AI-drafted replies, approve/edit/regenerate/send
//   Dashboard  — ratings, distribution, sources, ask funnel
//   Triggers   — the POS-triggered review-ask engine + tester
//   Settings   — routing threshold, connected platforms, AI voice, card copy
// Each tab is its own self-contained component under ./review/.

import { useState } from 'react';
import ReviewQueue from './review/ReviewQueue';
import ReviewCard from './review/ReviewCard';
import ReviewDashboard from './review/ReviewDashboard';
import ReviewTriggers from './review/ReviewTriggers';
import ReviewSettings from './review/ReviewSettings';

const TABS = [
  ['approvals', 'Approvals', ReviewQueue],
  ['card', 'Your card', ReviewCard],
  ['dashboard', 'Dashboard', ReviewDashboard],
  ['triggers', 'Get reviews', ReviewTriggers],
  ['settings', 'Settings', ReviewSettings],
];

export default function ReviewManager() {
  const [tab, setTab] = useState('approvals');
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
