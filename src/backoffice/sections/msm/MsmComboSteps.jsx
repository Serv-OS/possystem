// src/backoffice/sections/msm/MsmComboSteps.jsx
//
// A Combo's steps in the group menu's product sheet (5.12.124, Combo products stage 2). The SAME
// editor as a site's Menu Manager (../ComboStepsTab.jsx): the group menu's products are shaped as
// its menu rows by one small adapter (lib/msm/msmComboRows.js), so the rules, the words and the
// checks are the same in both places, and every step lists products of the group menu by their own
// ids. Publish swaps each for that site's own item (msmPlan), and a site that does not sell one
// leaves it out there (said on the publish screen).

import { useMemo } from 'react';
import ComboStepsTab from '../ComboStepsTab';
import { comboStepRows, comboStepItem } from '../../../lib/msm/msmComboRows.js';

/**
 *   id          the Combo's product id (a new product: the id the sheet stages it with)
 *   form        the sheet's form (name, menu_name, combo, modifier_groups, parent_product_id)
 *   price       the group price (the set price)
 *   products    every product of the group menu (the draft applied)
 *   categories  the group menu's categories
 *   onChange    (combo) => the sheet's form takes the new steps value
 *   columnReady false before SQL 20261216a: the editor says the update is needed
 *   readOnly    true when this person may look but not change the group menu
 */
export default function MsmComboSteps({ id, form, price, products, categories, onChange, columnReady = true, readOnly = false }) {
  const rows = useMemo(() => comboStepRows(products), [products]);
  const cats = useMemo(() => (Array.isArray(categories) ? categories : []).filter(Boolean).map((c) => ({ id: c.id, label: c.label || c.name || '' })), [categories]);
  const item = comboStepItem({ id, form, price });
  return (
    <div data-testid="msm-combo-steps">
      <ComboStepsTab
        item={item}
        menuItems={rows}
        categories={cats}
        onUpdate={(patch) => { if (patch && 'combo' in patch) onChange(patch.combo ?? null); }}
        columnReady={columnReady}
        readOnly={readOnly}
        posOnlyNote={false}
        eightySixIds={[]}
        needsUpdateWords="Steps in the group menu need one database update that has not been run yet (SQL 20261216a). Nothing can be saved to them until then. Ask ServOS to run it."
        priceWhere="(the group price on this sheet)"
      />
    </div>
  );
}
