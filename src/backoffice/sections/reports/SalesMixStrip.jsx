// The "Sales mix" strip under the Business summary's four headline tiles (8 Oct 2026, D4c):
// one stacked bar, each group's money and share, and a link to the Sales mix report. It
// resolves groups itself through _salesMixData (the same resolver as the report, the Z report
// block and the owner app), so SalesSummary.jsx only mounts it: that file is shared with
// another branch and stays small.
//
//   one site        <SalesMixStrip checks fmt sites scope onOpen/>
//   several sites   <SalesMixStrip block fromSums onOpen/>  (once per currency block, b.fmt)
//
// fromSums (a long period across several sites, figures from the server day sums): the day
// sums carry no item or category figures at all, so the card says to pick 7 days or fewer.

import { useMemo } from 'react';
import { useOneSiteMix, usePartResolvers } from './_salesMixData';
import { mixView, mixFromChecks, mixRollup, nameAcross } from '../../../../supabase/functions/_shared/salesMix.js';
import { stripModel, toneVar, STRIP_NOTE, SUMS_NOTE } from '../../../lib/salesMixView.js';

const cardSt = { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px', marginBottom:12 };
const capsSt = { fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' };
const linkBtn = { background:'none', border:'none', padding:0, color:'var(--t3)', textDecoration:'underline', cursor:'pointer', fontFamily:'inherit', fontSize:12 };
const hintSt = { marginTop:8, fontSize:11.5, color:'var(--t4)' };

export default function SalesMixStrip(props) {
  if (props.block) return props.fromSums ? <SumsNote/> : <StripBlock {...props}/>;
  return <StripOne {...props}/>;
}

function Card({ onOpen, children }) {
  return (
    <div style={cardSt}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:10 }}>
        <div style={capsSt}>Sales mix</div>
        {onOpen && <button onClick={onOpen} style={linkBtn}>Open Sales mix ›</button>}
      </div>
      {children}
    </div>
  );
}

function SumsNote() {
  return <Card onOpen={null}><div style={{ fontSize:12, color:'var(--t4)' }}>{SUMS_NOTE}</div></Card>;
}

// The signed in site, or one OTHER ticked site (its own categories, read fresh).
function StripOne({ checks, fmt, sites, scope, onOpen }) {
  const one = useOneSiteMix({ sites, scope });
  const view = useMemo(() => mixView(mixFromChecks(checks, one.resolver), null, one.resolver), [checks, one.resolver]);
  if (one.menuLoading) return <Card onOpen={onOpen}><div style={{ fontSize:11, color:'var(--t4)' }}>Loading…</div></Card>;
  const model = stripModel(view, { failed: one.menuFailed });
  if (!model) return null;
  return <Card onOpen={onOpen}><StripBody model={model} fmt={fmt}/></Card>;
}

// One currency block of the split view: the sites' blocks added per group key (never across
// currencies), names from the signed in site's resolver first.
function StripBlock({ block, onOpen }) {
  const pr = usePartResolvers(block.parts);
  const view = useMemo(() => {
    const ordered = [...block.parts].sort((a, b) => (b.site?.isHome ? 1 : 0) - (a.site?.isHome ? 1 : 0));
    const resolvers = ordered.map((p) => pr.resolvers[p.id]).filter(Boolean);
    const views = block.parts.map((p) => {
      const r = pr.resolvers[p.id];
      return r ? mixView(mixFromChecks(p.rows, r), null, r) : null;
    });
    return mixRollup(views, { nameOf: (key) => nameAcross(resolvers, key) });
  }, [block, pr.resolvers]);
  if (pr.menusLoading) return <Card onOpen={onOpen}><div style={{ fontSize:11, color:'var(--t4)' }}>Loading…</div></Card>;
  const allFailed = block.parts.length > 0 && block.parts.every((p) => pr.menusFailed.includes(p.id));
  const model = stripModel(view, { failed: allFailed });
  if (!model) return null;
  return <Card onOpen={onOpen}><StripBody model={model} fmt={block.fmt}/></Card>;
}

function StripBody({ model, fmt }) {
  const { segments, words, hint } = model;
  const money = (n) => (fmt ? fmt(n) : n);
  return (
    <>
      <div role="img" aria-label={`Sales mix: ${words}`} style={{ display:'flex', gap:2, height:10, borderRadius:99, overflow:'hidden', background:'var(--bg3)' }}>
        {segments.map((s) => (
          <div key={s.key} style={{ flex:`${s.share} 0 0`, minWidth: s.share > 0 ? 3 : 0, background: toneVar(s.tone) }}/>
        ))}
      </div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 14px', fontSize:12, marginTop:8 }}>
        {segments.map((s) => (
          <span key={s.key} style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
            <span style={{ width:8, height:8, borderRadius:2, background: toneVar(s.tone), flexShrink:0 }}/>
            <span style={{ color:'var(--t2)', fontWeight:700 }}>{s.name} {s.share}%</span>
            <span style={{ color:'var(--t3)' }}>· {money(s.money)}</span>
          </span>
        ))}
      </div>
      {hint === 'failed' && <div style={hintSt}>The menu could not be read, so every sale shows as Other sales.</div>}
      {hint === 'all' && <div style={hintSt}>No sales groups set yet. Open Sales mix to set them up.</div>}
      {hint === 'most' && <div style={hintSt}>Most sales have no group yet. Set up groups in Sales mix.</div>}
      <div style={{ marginTop:6, fontSize:11, color:'var(--t4)' }}>{STRIP_NOTE}</div>
    </>
  );
}
