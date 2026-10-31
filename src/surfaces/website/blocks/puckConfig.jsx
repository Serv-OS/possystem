// src/surfaces/website/blocks/puckConfig.jsx
//
// The Puck 0.20 config for the Back Office editor (ARCHITECTURE.md section 6), built from the one
// schema (schema.js) and the same React components the public site renders, so what the owner
// sees in the editor is what the site shows. Agent C mounts <Puck config={puckConfig(ctx)} data={layout}>.
// Puck itself is imported ONLY by the Back Office; this file imports no Puck code, it only produces
// the plain config object Puck reads (fields: text, textarea, number, select, radio, array, object).

import { BLOCK_SCHEMAS, BLOCK_TYPES, GROUPS, defaultPropsFor, normaliseProps } from './schema.js';
import { puckFields } from './puckFields.js';
import { COMPONENTS } from './components/index.jsx';
import { SiteContext } from '../siteContext.js';
import { buildCtx } from '../ssr/renderBlocks.js';
import { siteVars } from '../theme.js';
import { pickLocation } from '../resolveHref.js';

/**
 * puckConfig(ctx) → Puck config. ctx: { snapshot, menu, customerRoot, reviews, now }, or the Back
 * Office editor's shape { site, pages, posts, locations, branding } (a snapshot is built from it).
 * The site context the components read comes from the same buildCtx the public site uses, so a
 * block in the editor shows the venue's real hours, locations and menu.
 */
export function snapshotFromEditor(ctx = {}) {
  if (ctx.snapshot && typeof ctx.snapshot === 'object') return ctx.snapshot;
  return {
    site: { ...(ctx.site || {}) },
    // Drafts count as published in the editor: the owner is looking at their own work.
    pages: (Array.isArray(ctx.pages) ? ctx.pages : []).map((p) => ({ ...p, status: 'published' })),
    posts: Array.isArray(ctx.posts) ? ctx.posts : [],
    locations: Array.isArray(ctx.locations) ? ctx.locations : [],
  };
}

export function puckConfig(ctx = {}) {
  const snapshot = snapshotFromEditor(ctx);
  const siteCtx = buildCtx({ snapshot, host: ctx.host || '', path: ctx.path || '/', menu: ctx.menu, reviews: ctx.reviews, customerRoot: ctx.customerRoot, now: ctx.now });
  const loc0 = pickLocation(siteCtx, 'default');
  let vars = {};
  try { vars = siteVars(siteCtx.site.theme || {}, ctx.branding || (loc0 && loc0.online_branding) || {}); } catch { vars = {}; }
  // In the editor every block is shown, switches or not: the owner must see what they are editing.
  siteCtx.settings = { ...siteCtx.settings, allow_custom_code: true, channels: {} };
  const value = { ctx: siteCtx, menu: ctx.menu || null, menuLoading: false, here: null, nearestState: 'idle', requestNearest: () => {}, navigate: () => {} };
  const components = {};
  for (const type of BLOCK_TYPES) {
    const schema = BLOCK_SCHEMAS[type];
    const Comp = COMPONENTS[type];
    components[type] = {
      label: schema.label,
      fields: puckFields(schema.props),
      defaultProps: defaultPropsFor(type),
      render: (props) => {
        // Puck hands its own `puck` prop and the id; the component gets normalised block props.
        const { puck, ...rest } = props;
        void puck;
        const clean = normaliseProps(type, rest);
        return (
          <SiteContext.Provider value={value}>
            {Comp ? <Comp {...clean} isFirst={false} /> : null}
          </SiteContext.Provider>
        );
      },
    };
  }
  return {
    categories: {
      servos: { title: 'ServOS', components: GROUPS.servos.slice(), defaultExpanded: true },
      content: { title: 'Content', components: GROUPS.content.slice(), defaultExpanded: true },
    },
    components,
    // The theme variables ride on the wrapper so the canvas is painted in the venue's colours.
    root: { fields: {}, render: ({ children }) => <div className="w-site" style={vars} data-layout={(siteCtx.site.theme && siteCtx.site.theme.layout) || 'ember'}><main className="w-main">{children}</main></div> },
  };
}
