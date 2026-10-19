// src/backoffice/sections/msm/useConfirm.jsx
//
// MULTI SITE MENU (v5.11.75): the in app "are you sure" as a hook (msmUi.jsx ConfirmDialog).
// Never window.confirm: it shows nothing in the iPad apps (msmScreens.test.js checks).

import { useCallback, useState } from 'react';
import { ConfirmDialog } from './msmUi';

/** [confirm, dialog]: await confirm({ title, words, yes, no, danger }) is true or false; render dialog. */
export function useConfirm() {
  const [ask, setAsk] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setAsk({ ...(opts || {}), resolve })), []);
  const answer = (v) => { if (ask) ask.resolve(v); setAsk(null); };
  const dialog = ask ? <ConfirmDialog {...ask} onYes={() => answer(true)} onNo={() => answer(false)} /> : null;
  return [confirm, dialog];
}
