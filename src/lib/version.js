export const VERSION = '5.7.94';

// Expose for on-screen diagnostics inside the Sunmi APK.
if (typeof window !== 'undefined') {
  window.RPOS_VERSION = VERSION;
}
