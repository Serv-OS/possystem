// src/backoffice/sections/stock/NewSiteBanner.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, map 3.3, mockup 2.13 banner): once a company gets its second
// site, a login that edits the company list (level 'all') is told, once, that its stock can now be
// shared. Dismissed per login and company (servos-stock-banner:<userId>:<orgId>), shown again only
// when the company became multi site after that dismissal. Never shown to a one site company.

import { useState } from 'react';
import { useStockScope } from '../../StockScope';
import { Notice } from '../msm/msmUi';
import { bannerDue, readBannerDismissed, writeBannerDismissed } from '../../../lib/stock/siteScope';

export default function NewSiteBanner() {
  const sc = useStockScope();
  const [dismissedAt, setDismissedAt] = useState(() => readBannerDismissed(sc.userId, sc.orgId));
  if (!sc.ready || !bannerDue({ multi: sc.multi, level: sc.level, multiSince: sc.multiSince, dismissedAt })) return null;
  const gotIt = () => {
    const at = new Date().toISOString();
    writeBannerDismissed(sc.userId, sc.orgId, at);
    setDismissedAt(at);
  };
  return (
    <div style={{ marginBottom: 14 }} data-testid="stock-new-site-banner">
      <Notice tone="good" actions={[{ label: 'Got it', onClick: gotIt }]}>
        Your stock can now be shared across {sc.sites.length} sites. Tick the new site where it should be, or use Copy a site.
      </Notice>
    </div>
  );
}
