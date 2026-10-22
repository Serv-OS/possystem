// purchasing/OrderPadWhichSite.jsx: the Order pad on All sites or a group (multi site stock Drop 3,
// v5.11.96, contract 3.2 and 4.2, mockup scrOrderPad no site view). An order belongs to one site:
// one button per site (kitchens left out by the caller); head office also gets Order for many sites.

import { PageHead, Btn, ui } from '../stock/stockUi';
import { PAD_WORDS } from '../../../lib/stock/purchasingWords';

export default function OrderPadWhichSite({ sites = [], onPick, onMany = null }) {
  return (
    <div style={ui.page}>
      <PageHead title={PAD_WORDS.noSiteTitle} sub={PAD_WORDS.noSiteSub} />
      <div style={{ ...ui.card, padding: 18, borderRadius: 14, maxWidth: 720 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>{PAD_WORDS.whichSite}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(sites || []).map((s) => <Btn key={s.id} kind="soft" onClick={() => onPick?.(s.id)}>{s.name}</Btn>)}
          {!(sites || []).length && <span style={{ fontSize: 13, color: 'var(--t3)' }}>No open site to order for.</span>}
        </div>
        {onMany && (
          <div style={{ ...ui.sub, marginTop: 14 }}>
            {PAD_WORDS.manyNoteBefore}
            <Btn kind="link" small onClick={onMany} style={{ fontWeight: 800, padding: 0 }}>{PAD_WORDS.manyButton}</Btn>
            {PAD_WORDS.manyNoteAfter}
          </div>
        )}
      </div>
    </div>
  );
}
