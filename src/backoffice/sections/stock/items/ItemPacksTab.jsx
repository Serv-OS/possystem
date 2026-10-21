// src/backoffice/sections/stock/items/ItemPacksTab.jsx
//
// MULTI SITE STOCK Drop 1 (mockup scrItem 'packs'): every way the item is bought or counted, and
// the unit bridges. Today's Units tab, then today's Dimension and Measure tab, both copies that save
// the COMPANY packs and bridges (UnitsTab.jsx, DimensionTab.jsx). Packs are company wide: the server
// writes every site's rows, so every site counts in the same packs.

import { ui } from '../stockUi';
import UnitsTab from './UnitsTab';
import DimensionTab from './DimensionTab';

export default function ItemPacksTab({ detail, editable = false, reload, homeSiteId = null }) {
  const locked = !editable;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
      <div style={ui.card}>
        <UnitsTab detail={detail} homeSiteId={homeSiteId} locked={locked} reload={reload} />
        <div style={{ ...ui.sub, marginTop: 12 }}>Packs are company wide, so every site counts in the same packs.</div>
      </div>
      <div style={ui.card}>
        <div style={{ ...ui.label, marginBottom: 10 }}>Unit bridges</div>
        <DimensionTab detail={detail} homeSiteId={homeSiteId} locked={locked} reload={reload} />
      </div>
    </div>
  );
}
