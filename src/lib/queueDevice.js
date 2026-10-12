// src/lib/queueDevice.js
//
// The thin reader for lib/queueDeleteRule.js: gathers what THIS page is (its mode, the paired
// device's type, its profile) and asks the rule for its part in the open orders list. Read on
// every call: it is two cheap lookups, and a device profile can change while the app is open.

import { getDeviceMode } from './supabase';
import { queueDeviceRole } from './queueDeleteRule';

/** 'till' | 'office' | 'reader'. deviceConfig is the store's (the caller holds the store). */
export function readQueueRole(deviceConfig) {
  let deviceType = null;
  try { deviceType = JSON.parse(localStorage.getItem('rpos-device') || 'null')?.type || null; } catch { deviceType = null; }
  return queueDeviceRole({
    mode: getDeviceMode(),
    deviceType,
    defaultSurface: deviceConfig?.defaultSurface,
    profileName: deviceConfig?.profileName,
  });
}
