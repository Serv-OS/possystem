// src/backoffice/sections/msm/useMsmLockState.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75, design 3.2): the managed lists of this Back
// Office venue (lib/msm/msmManaged.js), kept fresh, for the Menu Manager lock.

import { useEffect, useState } from 'react';
import { msmManagedState, subscribeMsmManaged } from '../../../lib/msm/msmManaged.js';

export function useMsmLockState() {
  const [st, setSt] = useState(() => msmManagedState());
  useEffect(() => subscribeMsmManaged((s) => setSt(s)), []);
  return st;
}
