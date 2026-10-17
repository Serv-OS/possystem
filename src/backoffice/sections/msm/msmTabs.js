// src/backoffice/sections/msm/msmTabs.js
//
// MULTI SITE MENU (v5.11.75): more tabs for the screen (MultiSiteMenu.jsx shows Menu first, then
// these in order, then Menu details). Each is { id, label, badge(shared), render(shared) }, where
// `shared` is the screen's state and actions (see MultiSiteMenu.jsx: api, client, menu, live, eff,
// ix, sites, sets, working, rows, staged, ctx, stage, unstage, canEdit, editable, costs, channel,
// setChannel, refreshSets, reload, setWorkingId, setNote, setTab, tabIds, openProduct). A tab with
// id 'publish' also gets the "Publish or schedule" button in the Changes panel.
//
// Plain createElement here (a .js file): the screens themselves are .jsx.

import { createElement as h } from 'react';
import MsmPublish from './MsmPublish';
import MsmTimeline from './MsmTimeline';
import MsmSites from './MsmSites';
import MsmSpread from './MsmSpread';

export const EXTRA_TABS = [
  { id: 'publish', label: 'Publish', badge: (s) => (s.working?.status === 'draft' ? s.rows.length : 0), render: (s) => h(MsmPublish, s) },
  { id: 'timeline', label: 'Timeline', badge: (s) => s.sets.filter((x) => x.status === 'scheduled' || x.status === 'running').length, badgeTone: 'blue', render: (s) => h(MsmTimeline, s) },
  { id: 'sites', label: 'Sites', render: (s) => h(MsmSites, s) },
  { id: 'spread', label: 'Price spread', render: (s) => h(MsmSpread, s) },
];
