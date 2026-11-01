// 5.12.11: the staged site build the Back Office runs (plan, then one call per page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagedBuild, looksLikeSiteBuild, summaryLines } from './stagedBuild.js';

const LONG = 'Build the full Coffee Boy website. '.repeat(20) + 'Pages: Home, Menu, Rewards, About, Contact.';

test('looksLikeSiteBuild: long, says build, names a site and pages; short edits do not', () => {
  assert.equal(looksLikeSiteBuild(LONG), true);
  assert.equal(looksLikeSiteBuild('Build the menu page'), false);
  assert.equal(looksLikeSiteBuild('Make the hero taller and the buttons red. '.repeat(30)), false);
  assert.equal(looksLikeSiteBuild(''), false);
});

test('stagedBuild: plan, then one page call per planned page in order, progress text, summary and applied', async () => {
  const calls = [];
  const plan = { layout: 'marquee', pages: [{ slug: '', title: 'Home', kind: 'home', status: 'published', brief: 'a' }, { slug: 'menu', title: 'Menu', kind: 'menu', status: 'published', brief: 'b' }, { slug: 'about', title: 'About', kind: 'custom', status: 'draft', brief: 'c' }] };
  const request = async (body) => {
    calls.push(body);
    if (body.mode === 'plan') return { reply: 'Planned: marquee, 3 pages.', applied: true, plan };
    if (body.plan_page === 'menu') return { error: 'The designer could not answer (504).' };
    if (body.plan_page === 'about') return { reply: 'r', applied: false, errors: ['pages[1]: Hero is not allowed twice'] };
    return { reply: 'Home built.', applied: true, pages_changed: [body.plan_page] };
  };
  const steps = [];
  const out = await stagedBuild({ siteId: 's1', message: LONG, layout: 'marquee', images: [{ media_type: 'image/png', data: 'x' }], request, onStep: (s) => steps.push(s) });
  assert.deepEqual(calls.map((c) => c.mode), ['plan', 'page', 'page', 'page']);
  assert.deepEqual(calls[0].images.length, 1, 'screenshots go with the plan');
  assert.equal(calls[1].images, undefined, 'and not with every page');
  assert.deepEqual(calls.slice(1).map((c) => c.plan_page), ['', 'menu', 'about']);
  assert.equal(calls[1].plan, plan);
  assert.deepEqual(steps, ['Planning your site…', 'Building page 1 of 3: Home', 'Building page 2 of 3: Menu', 'Building page 3 of 3: About']);
  assert.equal(out.applied, true);
  assert.equal(out.error, '2 pages did not build. See the chat.');
  assert.equal(out.messages[0], 'Planned: marquee, 3 pages.');
  assert.equal(out.messages[1], 'Built 1 of 3 pages: Home.');
  assert.ok(out.messages[2].includes('Menu page did not build: The designer could not answer (504).'));
  assert.ok(out.messages[3].includes('About page did not build: pages[1]: Hero is not allowed twice'));
});

test('stagedBuild: a failed plan stops everything; a plan with no pages builds nothing', async () => {
  const bad = await stagedBuild({ siteId: 's1', message: LONG, request: async () => ({ error: 'Not allowed' }) });
  assert.equal(bad.applied, false);
  assert.deepEqual(bad.messages, ['I could not do that: Not allowed']);
  let n = 0;
  const empty = await stagedBuild({ siteId: 's1', message: LONG, request: async () => { n++; return { reply: 'Nothing to plan.', applied: false, plan: { layout: null, pages: [] } }; } });
  assert.equal(n, 1);
  assert.equal(empty.applied, false);
  assert.ok(empty.messages[1].includes('no pages'));
  assert.deepEqual(summaryLines({ pages: [] }, []), ['No pages were planned.']);
});
