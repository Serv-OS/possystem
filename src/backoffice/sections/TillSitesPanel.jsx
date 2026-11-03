// src/backoffice/sections/TillSitesPanel.jsx: Back Office, Team, a till user, Sites (5.12.39).
//
// Peter, 2 Nov 2026: "I also can't see any way within Team to be able to set which sites they work
// at", and "we need both": Workforce, Staff, Sites (for a staff record) and here (for a till user, who
// may have no Workforce record at all). Both show and change the same link (person_id, 20261111a):
//   Also works at   a till user at the other site with the same PIN, card, sign in method, till role
//                   and permissions; when they have a Workforce record, both records are made
//   Link            a till user made by hand at another site (same name) becomes the same person and
//                   takes this one's PIN and card
//   Unlink          this site only again
// Every change goes through a database door (wf_till_add_site, wf_till_link, wf_till_unlink,
// 20261113a) that checks access to every site involved; the words for a refusal come from
// staff/peopleAcrossSites.js linkErrorWords, as on the Workforce panel.

import { useEffect, useMemo, useState } from 'react';
import { supabase, isMock } from '../../lib/supabase';
import { otherSites, linkCandidates, sitesToAdd, linkErrorWords } from '../../staff/peopleAcrossSites';
import { tillRecords, tillDoor } from '../../staff/tillSites';

export default function TillSitesPanel({ member, orgCtx, showToast }) {
  const orgId = orgCtx?.orgId || null;
  const hereId = orgCtx?.locationId || null;
  const [state, setState] = useState({ loading: true, sites: [], records: [] });
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState([]);   // site ids ticked to add (any number: some people work at every site)
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null);   // 'unlink' | a till user id to link

  useEffect(() => {
    let live = true;
    (async () => {
      if (isMock || !supabase || !orgId) { if (live) setState({ loading: false, sites: [], records: [] }); return; }
      const [sitesRes, records] = await Promise.all([
        supabase.from('locations').select('id, name').eq('org_id', orgId).order('name'),
        tillRecords(orgId),
      ]);
      if (live) setState({ loading: false, sites: sitesRes?.data || [], records });
    })();
    return () => { live = false; };
  }, [orgId, member?.id, tick]);

  const names = useMemo(() => Object.fromEntries(state.sites.map((s) => [s.id, s.name])), [state.sites]);
  const me = useMemo(() => {
    const row = state.records.find((r) => r.id === member?.id);
    return { id: member?.id, name: member?.name, personId: row?.person_id ?? null, locationId: row?.location_id ?? hereId };
  }, [state.records, member, hereId]);
  const linked = otherSites(me, state.records, names);
  const candidates = linkCandidates(me, state.records, names);
  const canAdd = sitesToAdd(me, state.records, state.sites);

  const run = async (label, fn, done) => {
    setBusy(label);
    try { await fn(); if (done) showToast?.(done, 'success'); setTick((t) => t + 1); setPicked([]); }
    catch (e) { showToast?.(linkErrorWords(e), 'error'); }
    finally { setBusy(''); setConfirm(null); }
  };

  const box = { marginBottom: 20, padding: '12px 14px', background: 'var(--bg2)', borderRadius: 12, border: '1px solid var(--bdr)' };
  const btn = (accent) => ({ padding: '5px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700,
    background: accent ? 'var(--acc)' : 'var(--bg3)', border: accent ? 'none' : '1px solid var(--bdr2)', color: accent ? '#0b0c10' : 'var(--t2)' });

  if (!member) return null;
  return (
    <div style={box}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)', marginBottom: 2 }}>Sites</div>
      <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 10 }}>
        Where they work. At every site they have the same PIN and card. Their till role and permissions are set at each site.
      </div>
      {state.loading ? <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>Loading…</div>
        : state.sites.length < 2 ? <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>This company has one site.</div> : (
          <>
            <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 8 }}>
              <b>{names[me.locationId] || 'This site'}</b>
              {linked.filter((l) => !l.leaver).map((l) => <span key={l.staffId}>, <b>{l.site}</b></span>)}
              {linked.length === 0 && <span style={{ color: 'var(--t3)' }}> only</span>}
            </div>

            {candidates.map((c) => (
              <div key={c.staffId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, marginBottom: 8 }}>
                <span style={{ flex: 1, minWidth: 160 }}>Looks like the same person at <b>{c.site}</b> ({c.name})</span>
                {confirm !== c.staffId
                  ? <button style={btn(false)} disabled={!!busy} onClick={() => setConfirm(c.staffId)}>Link</button>
                  : <>
                      <span style={{ color: 'var(--t3)' }}>Their PIN and card at {c.site} become this one's.</span>
                      <button style={btn(false)} onClick={() => setConfirm(null)}>Cancel</button>
                      <button style={btn(true)} disabled={!!busy} onClick={() => run('link', () => tillDoor('wf_till_link', { p_member: member.id, p_other: c.staffId }), `${member.name} linked with ${c.site}`)}>{busy === 'link' ? 'Linking…' : 'Link them'}</button>
                    </>}
              </div>
            ))}

            {canAdd.length > 0 && (
              <div style={{ marginBottom: linked.length ? 10 : 0 }}>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Also works at (tick every site that applies)</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {canAdd.map((s) => {
                    const on = picked.includes(s.id);
                    return (
                      <button key={s.id} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                        style={{ ...btn(false), border: `1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, color: on ? 'var(--acc)' : 'var(--t2)' }}>
                        {on ? '✓ ' : ''}{s.name}
                      </button>
                    );
                  })}
                  {canAdd.length > 1 && <button style={btn(false)} onClick={() => setPicked(picked.length === canAdd.length ? [] : canAdd.map((s) => s.id))}>{picked.length === canAdd.length ? 'Clear' : 'Select all'}</button>}
                </div>
                <button style={btn(true)} disabled={!picked.length || !!busy}
                  onClick={() => run('add', async () => {
                    // One site at a time: each press of the door checks access to every site so far.
                    const done = [];
                    for (const id of picked) {
                      try { await tillDoor('wf_till_add_site', { p_member: member.id, p_location: id }); done.push(names[id] || 'a site'); }
                      catch (e) { if (done.length) showToast?.(`Added at ${done.join(', ')}.`, 'success'); throw e; }
                    }
                    showToast?.(`${member.name} now also works at ${done.join(', ')}, with the same PIN`, 'success');
                  }, null)}>
                  {busy === 'add' ? 'Adding…' : picked.length > 1 ? `Add ${picked.length} sites` : 'Add site'}
                </button>
              </div>
            )}

            {linked.length > 0 && (
              confirm !== 'unlink'
                ? <button style={btn(false)} disabled={!!busy} onClick={() => setConfirm('unlink')}>Unlink from other sites</button>
                : <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5 }}>
                    <span style={{ color: 'var(--t3)' }}>Their PIN stops being shared and their hours count here only.</span>
                    <button style={btn(false)} onClick={() => setConfirm(null)}>Keep</button>
                    <button style={btn(true)} disabled={!!busy} onClick={() => run('unlink', () => tillDoor('wf_till_unlink', { p_member: member.id }), `${member.name} is now at ${names[me.locationId] || 'this site'} only`)}>{busy === 'unlink' ? 'Unlinking…' : 'Unlink'}</button>
                  </span>
            )}
          </>
        )}
    </div>
  );
}
