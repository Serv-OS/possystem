// src/components/secondStep/authTokens.js
//
// Colours for the sign in screens: ServOS Brand v2 (Ink #0F1211, Coal #161A18, Paper #F5F7F4,
// Ash #8C938C, Signal green #15C26A with Signal-ink #06130C text, Glow #46E08C, Coral #FF5A4A,
// Amber #F5A623). Kept apart from AuthUi.jsx so that file only exports components.
//
// tone 'dark'  fixed Brand v2 dark tokens (Back Office and admin sign in are always dark)
// tone 'auto'  the ServOS skin CSS variables, so the Owner app keeps its light or dark theme

const DARK = {
  bg: '#0F1211', panel: '#161A18', field: '#1b201d', text: '#F5F7F4', sub: '#8C938C', faint: '#6B746D',
  line: 'rgba(233,236,234,0.12)', acc: '#15C26A', accInk: '#06130C', accText: '#46E08C',
  accSoft: 'rgba(21,194,106,0.12)', accLine: 'rgba(21,194,106,0.34)', err: '#FF5A4A',
  errSoft: 'rgba(255,90,74,0.10)', errLine: 'rgba(255,90,74,0.32)', warn: '#F5A623', warnSoft: 'rgba(245,166,35,0.10)',
  qrBg: '#F5F7F4',
};
const AUTO = {
  bg: 'var(--bg, #0F1211)', panel: 'var(--bg1, #161A18)', field: 'var(--bg2, #1b201d)', text: 'var(--t1, #F5F7F4)',
  sub: 'var(--t2, #8C938C)', faint: 'var(--t3, #6B746D)', line: 'var(--bdr2, rgba(233,236,234,0.14))',
  acc: 'var(--acc, #15C26A)', accInk: '#06130C', accText: 'var(--acc, #46E08C)', accSoft: 'var(--acc-d, rgba(21,194,106,0.12))',
  accLine: 'var(--acc-b, rgba(21,194,106,0.34))', err: 'var(--red, #FF5A4A)', errSoft: 'var(--red-d, rgba(255,90,74,0.10))',
  errLine: 'var(--red-b, rgba(255,90,74,0.32))', warn: 'var(--amber, #F5A623)', warnSoft: 'rgba(245,166,35,0.12)',
  qrBg: '#F5F7F4',
};

export const tokens = (tone) => (tone === 'auto' ? AUTO : DARK);
