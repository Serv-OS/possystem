// src/backoffice/components/WhichSiteDialog.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, mockup modal "which"): an action that belongs to one site
// (Start a count, and the like) pressed while the picker is on All sites or a group asks which
// site. Picking one moves the picker to it (StockScope askWhichSite).

import { Btn, Modal } from '../sections/msm/msmUi';
import { ui } from '../sections/msm/msmStyle';

export default function WhichSiteDialog({ label, sites, pickerName, onPick, onClose }) {
  const list = Array.isArray(sites) ? sites : [];
  return (
    <Modal title={`${label}: which site?`} onClose={onClose} width={460}>
      <div style={{ ...ui.sub, fontSize: 13, marginBottom: 12 }}>
        The picker is on {pickerName || 'All sites'}. This belongs to one site.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {list.map((s) => (
          <Btn key={s.id} kind="soft" onClick={() => onPick?.(s.id)}>{s.name || 'Site'}</Btn>
        ))}
        {list.length === 0 && <div style={{ ...ui.sub }}>No site is in your list.</div>}
      </div>
    </Modal>
  );
}
