// kioskVatGateContext.js: the kiosk's VAT gate state, shared by context (8 Oct 2026, VAT audit).
// KioskApp provides { gate: null | { code, message }, onRetry }; KioskVatGate reads it, so the new
// design's LinkedScreenPay (a module level component, kept stable so ScreenPay never remounts) can
// decide whether the card screen mounts without a new prop on every screen. Its own file so the
// component file exports only a component (fast refresh).
import { createContext } from 'react';

export const KioskVatGateContext = createContext({ gate: null, onRetry: null });
