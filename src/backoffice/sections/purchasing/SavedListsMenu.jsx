// purchasing/SavedListsMenu.jsx: the Order pad's Saved lists menu (multi site stock Drop 3, v5.11.96,
// contract 3.2 and 4.2): each saved list of the site, 'Save this basket as a list' and 'Repeat last
// order'.

import { MenuButton } from '../stock/stockUi';
import { PAD_WORDS } from '../../../lib/stock/purchasingWords';

export default function SavedListsMenu({ lists = [], onPick, onSave, onRepeat, canSave = true, canRepeat = true }) {
  const items = [
    ...(lists || []).slice(0, 100).map((l) => ({ label: l.name, hint: `${(l.lines || []).length} line${(l.lines || []).length === 1 ? '' : 's'}`, onClick: () => onPick?.(l) })),
    { label: PAD_WORDS.saveAsList, disabled: !canSave, why: 'Put something in the basket first.', onClick: () => onSave?.() },
    { label: PAD_WORDS.repeatLast, disabled: !canRepeat, why: 'Pick one supplier to repeat its last order.', onClick: () => onRepeat?.() },
  ];
  return <MenuButton label={PAD_WORDS.savedLists} items={items} align="left" small={false} />;
}
