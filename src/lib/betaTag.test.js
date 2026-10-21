// The BETA tag (18 Oct 2026, Peter: "add a small BETA tag next to the feature's name, because it
// is a beta feature"). One shared pill, src/components/BetaTag.js, shown ONLY for the routes in
// BETA_ROUTES (src/lib/boSections.js): the Back Office sidebar row and top bar title, the Multi
// site menu page heading and the Company Admin card. Every other route shows nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BetaTag from '../components/BetaTag.js';
import { BETA_ROUTES, isBetaRoute, MSM_ROUTE, NAV_IA, routesOfRow } from './boSections.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const allRoutes = NAV_IA.flatMap(routesOfRow);

test('the Multi site menu is the one beta route; every other sidebar route is not', () => {
  assert.ok(BETA_ROUTES.has(MSM_ROUTE));
  assert.equal(isBetaRoute(MSM_ROUTE), true);
  assert.equal(isBetaRoute('multi-site-menu'), true);
  const others = allRoutes.filter((id) => id !== MSM_ROUTE);
  assert.ok(others.length > 50, `${others.length} other routes`);
  for (const id of others) assert.equal(isBetaRoute(id), false, id);
  for (const id of ['menu', 'overview', 'wf-rota', '', null, undefined, 0, {}]) assert.equal(isBetaRoute(id), false, String(id));
  assert.ok([...BETA_ROUTES].every((id) => allRoutes.includes(id)), 'every beta route is a real sidebar route');
});

test('the pill renders the word BETA, is labelled "Beta feature", never wraps and uses theme tokens only', () => {
  const html = renderToStaticMarkup(createElement(BetaTag));
  assert.match(html, /^<span [^>]*>BETA<\/span>$/);
  assert.match(html, /aria-label="Beta feature"/);
  assert.match(html, /title="Beta feature"/);
  assert.match(html, /data-testid="beta-tag"/);
  assert.match(html, /white-space:nowrap/);
  assert.match(html, /flex-shrink:0/);
  assert.match(html, /background:var\(--acc-d\)/);
  assert.match(html, /color:var\(--acc\)/);
  assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b/i, 'no fixed colour: the theme tokens decide light and dark');
  const styled = renderToStaticMarkup(createElement(BetaTag, { style: { marginLeft: 'auto' } }));
  assert.match(styled, /margin-left:auto/);
  assert.match(styled, /white-space:nowrap/, 'a caller style never removes the no wrap');
});

test('Back Office shows the tag for a beta route only: the sidebar child row and the top bar title', () => {
  const bo = read('../backoffice/BackOfficeApp.jsx');
  assert.match(bo, /import \{ isBetaRoute \} from '\.\.\/lib\/boSections';/);
  assert.match(bo, /import BetaTag from '\.\.\/components\/BetaTag';/);
  // The sidebar child row: the label, then the tag when the row's route is beta.
  const row = bo.indexOf("{sec.children.map(([id, label]) => {");
  assert.ok(row > 0, 'the child rows render from NAV_IA');
  const rowEnd = bo.indexOf('</button>', row);
  const rowSrc = bo.slice(row, rowEnd);
  assert.match(rowSrc, /\{label\}\s*\{isBetaRoute\(id\) && <BetaTag \/>\}/, 'the tag follows the name and asks the route');
  // The top bar title: the section's name, then the tag when the open section is beta.
  // v5.11.89 (multi site stock Drop 1): today's NAV title through routeLabel ("Batch and prep" for a
  // multi site company), the BETA tag after it as before.
  const top = bo.indexOf("{routeLabel(section, NAV.find(n => n.id === section)?.label");
  assert.ok(top > 0);
  assert.match(bo.slice(top, bo.indexOf('</div>', top)), /\{isBetaRoute\(section\) && <BetaTag \/>\}/);
  // Nowhere is the tag rendered without asking the route.
  const bare = [...bo.matchAll(/<BetaTag/g)].length;
  const gated = [...bo.matchAll(/isBetaRoute\((id|section)\) && <BetaTag/g)].length;
  assert.equal(bare, gated, 'every tag in Back Office is behind isBetaRoute()');
  // The sidebar row shape is unchanged (the section access tests read it).
  assert.match(read('./boSections.js'), /\['multi-site-menu','Multi site menu'\]/);
});

test('the feature itself carries the tag: the page heading eyebrow and the Admin card heading', () => {
  const page = read('../backoffice/sections/msm/MultiSiteMenu.jsx');
  assert.match(page, /import BetaTag from '\.\.\/\.\.\/\.\.\/components\/BetaTag';/);
  assert.match(page, /textTransform: 'uppercase'[^>]*\}\}>Multi site menu<BetaTag \/><\/div>/, 'the eyebrow');
  const admin = read('../admin/sections/AdminMultiSiteMenu.jsx');
  assert.match(admin, /import BetaTag from '\.\.\/\.\.\/components\/BetaTag';/);
  assert.match(admin, /\.\.\.st\.h,[^>]*\}\}>Multi site menu<BetaTag \/><\/div>/, 'the card heading');
});
