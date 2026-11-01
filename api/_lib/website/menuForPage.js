// api/_lib/website/menuForPage.js
//
// Which venue's menu a page needs and how to price it (ARCHITECTURE.md section 7, server side).
// The first LiveMenu or Specials block on the page decides the venue (its location_id, else the
// site default) and the price mode. One menu read per page render. Pure apart from loadMenu.
// Shared with WebsiteSurface's logic by convention (same block → same venue → same prices).

import { walkBlocks } from '../../../src/surfaces/website/blocks/schema.js';
import { menuLocation } from '../../../src/surfaces/website/resolveHref.js';
import { loadMenu } from '../../../src/surfaces/website/data/loadMenu.js';

/** The menu block that drives the page's menu read, or null when the page shows no menu. 5.12.9: a block inside a Row column counts. */
export function menuBlockOf(page) {
  const blocks = walkBlocks(page && page.layout);
  return blocks.find((b) => b.type === 'LiveMenu') || blocks.find((b) => b.type === 'Specials') || null;
}

/** { location, options } for loadMenu, or null when the page needs no menu. */
export function menuPlan(page, ctx) {
  const block = menuBlockOf(page);
  if (!block) return null;
  // 5.12.8: a block on the default venue follows ?venue=<slug> (ctx.menuVenue); a pinned one does not.
  const location = menuLocation(ctx, block.props.location_id);
  if (!location || !location.ops_location_id) return null;
  const p = block.props;
  return {
    location,
    options: {
      menuId: block.type === 'LiveMenu' ? p.menu_id : 'follow',
      pinnedMenuId: location.online_menu_id || null,
      timezone: location.timezone,
      currency: location.currency || 'GBP',
      priceMode: block.type === 'LiveMenu' ? p.price_mode : 'collection',
      // Category and cap filters are applied per block at render time; the read stays whole.
    },
  };
}

/** Load the page's menu with the Ops client; null when none is needed or the read failed. */
export async function menuForPage(opsClient, page, ctx) {
  const plan = menuPlan(page, ctx);
  if (!plan || !opsClient) return null;
  const menu = await loadMenu(opsClient, plan.location.ops_location_id, plan.options);
  return menu && !menu.error ? menu : (menu || null);
}
