export const VERSION = '5.11.122';

// Expose for on-screen diagnostics inside the Sunmi APK.
if (typeof window !== 'undefined') {
  window.RPOS_VERSION = VERSION;
}
