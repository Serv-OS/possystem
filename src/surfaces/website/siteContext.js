// src/surfaces/website/siteContext.js
//
// What every block component reads: the render context (same object shape the SSR renderer uses,
// built by ssr/renderBlocks.js buildCtx), the live menu, the visitor's position after they tapped
// "Find my nearest", and navigate() for client side routing. One provider in WebsiteSurface.
// Plain JS (no component) so fast refresh stays happy; the <A> link lives in Link.jsx.

import { createContext, useContext } from 'react';

export const SiteContext = createContext({
  ctx: null, menu: null, menuLoading: false, here: null, nearestState: 'idle', requestNearest: () => {}, locateByText: () => {}, navigate: () => {},
  // 5.12.8: the venue the visitor picked for menus (online slug) and the setter the venue switch calls.
  menuVenue: null, setMenuVenue: () => {},
});

export function useSite() { return useContext(SiteContext); }
