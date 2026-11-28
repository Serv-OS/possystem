// src/lib/online/comboReady.js
//
// Does the server value a Combo's picks yet (5.12.125)? SQL 20261217a adds
// public.public_order_features(), which answers { "combo_steps": true }. The online page and the
// catering link offer a Combo built from steps only when it says so, so the pages and that file can
// land in any order: before it runs (or after its roll back) the question fails and Combos stay off,
// exactly as in 5.12.123 and 5.12.124. Asked once per page, and only when the menu has such a Combo.

import { comboHasSteps } from '../combo.js';

const asked = new WeakMap();   // client -> the answer it gave (a Promise), once per page

/** True only when the server says it values Combo picks. Any failure is false. */
export async function combosReadyOn(client) {
  if (!client || typeof client.rpc !== 'function') return false;
  if (!asked.has(client)) {
    asked.set(client, (async () => {
      try {
        const { data, error } = await client.rpc('public_order_features');
        if (error) { asked.delete(client); return false; }   // asked again next time (a blip, or not run yet)
        return !!data && data.combo_steps === true;
      } catch {
        asked.delete(client);
        return false;
      }
    })());
  }
  return asked.get(client);
}

/** Does this menu hold a Combo built from steps (the only time the page needs to ask)? */
export const menuHasStepCombos = (rows) => Array.isArray(rows) && rows.some((r) => r && !r.archived && comboHasSteps(r));
