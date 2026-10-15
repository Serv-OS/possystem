// src/lib/queueDevice.js
//
// The thin reader for lib/queueDeleteRule.js: gathers what THIS page is (its mode, the paired
// device's type, its profile) and asks the rule for its part in the open orders list, or whether
// it shows the kitchen screen. Read on every call: it is two cheap lookups, and a device profile
// can change while the app is open.

import { getDeviceMode } from './supabase';
import { queueDeviceRole, showsKitchenScreen } from './queueDeleteRule';

/** What this page is, as the rule wants it. deviceConfig is the store's (the caller holds the store). */
function readPage(deviceConfig) {
  let deviceType = null;
  try { deviceType = JSON.parse(localStorage.getItem('rpos-device') || 'null')?.type || null; } catch { deviceType = null; }
  return {
    mode: getDeviceMode(),
    deviceType,
    defaultSurface: deviceConfig?.defaultSurface,
    profileName: deviceConfig?.profileName,
  };
}

/** 'till' | 'office' | 'reader'. deviceConfig is the store's (the caller holds the store). */
export function readQueueRole(deviceConfig) {
  return queueDeviceRole(readPage(deviceConfig));
}

/**
 * Does this page show the kitchen screen (in any of its shapes)? The fence for tables: such a
 * page never publishes a table and never puts one back (lib/queueDeleteRule.js showsKitchenScreen).
 */
export function readShowsKitchenScreen(deviceConfig) {
  return showsKitchenScreen(readPage(deviceConfig));
}
