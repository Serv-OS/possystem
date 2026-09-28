// 5.11.x, assigned at merge (fix/payment-busy-guard). Set the real number before this ships:
// UpdateGuard reads the 'x' as 0, so devices would treat '5.11.x' as 5.11.0, not as newer.
export const VERSION = '5.11.x';

// Expose for on-screen diagnostics inside the Sunmi APK.
if (typeof window !== 'undefined') {
  window.RPOS_VERSION = VERSION;
}
