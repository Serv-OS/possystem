// src/components/BetaTag.js
//
// The small BETA pill shown next to a beta feature's name (18 Oct 2026, Peter: "add a small BETA
// tag next to the feature's name, because it is a beta feature"). One component for every place:
// the Back Office sidebar row and top bar title (for the routes in BETA_ROUTES, src/lib/boSections.js),
// the page heading eyebrow and the Company Admin card. Styled from the theme tokens only, so it
// reads in light and dark and in every skin; it never wraps. Plain createElement (no JSX) so a node
// test can render it as the browser does.

import { createElement } from 'react';

const STYLE = {
  display: 'inline-flex', alignItems: 'center', flexShrink: 0, verticalAlign: 'middle',
  padding: '1px 6px', borderRadius: 6, lineHeight: 1.4,
  fontSize: 9.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
  background: 'var(--acc-d)', color: 'var(--acc)', border: '1px solid var(--acc-b, transparent)',
};

export default function BetaTag({ style = null } = {}) {
  return createElement('span', {
    role: 'note', 'aria-label': 'Beta feature', title: 'Beta feature', 'data-testid': 'beta-tag',
    style: style ? { ...STYLE, ...style } : STYLE,
  }, 'BETA');
}
