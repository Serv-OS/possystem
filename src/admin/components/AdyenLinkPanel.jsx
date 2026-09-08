// src/admin/components/AdyenLinkPanel.jsx
//
// ServOS admin portal (?mode=admin): LINK TO ADYEN, the pull by reference
// block at the top of every Adyen venue's detail (8 Sep 2026, OWNER RULE 1).
//
// Adyen already holds the venue's store, balance account and account holder,
// created by FranPOS or Adyen with the venue code (SV-1007) as the STORE
// REFERENCE. Nothing is typed: the admin looks the venue up by that
// reference (adyen_lookup, read only), sees what Adyen holds in plain rows,
// then links it (adyen_link: ONE row write, the environment flip when the
// venue moves to live, origins and Apple Pay registered on the way). When
// no store carries the reference the candidate stores are offered as a pick
// list, and the store can be created with the reference
// (adyen_create_store_by_reference). All three fn actions are super_admin
// fenced; the fn answers 403 for anyone else.
//
// SAFETY (8 Sep 2026): nothing is written without ONE confirm built from the
// lookup's plan (go live and real money, a store that is not active, the
// stored ids replaced, the setup a flip clears). relink rides only after
// that yes, and only when the plan said the fn would refuse without it.
//
// Props:
//   location     the platform locations row (id, name, address, currency)
//   venueCode    ops locations.venue_code, the default reference (may be null)
//   environment  the venue's Adyen environment ('test' | 'live') as the list
//                or the status probe knows it. A live venue always looks and
//                links LIVE (the fn ignores environment: 'test' for it), so
//                the test box is hidden for one
//   callAdmin    (action, payload) => the adyen-terminal-admin answer; MUST
//                throw on a non-2xx with err.status and err.data set (the
//                409 needs_relink flow reads err.data)
//   onChanged    fired after a link or a store create changed the venue

import { useState } from 'react';
import { lookupRows, planLine, linkResultLines, candidateLabel, stashLine, LINK_FIELD_LABELS } from '../../lib/payments/adyenAdminRows';
import { referenceKey } from '../../lib/payments/adyenLink';

const S = {
  block: { marginTop: 14, padding: '14px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--acc-b, var(--bdr2))' },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' },
  desc: { fontSize: 12, color: 'var(--t3)', margin: '6px 0 0', lineHeight: 1.5 },
  input: { boxSizing: 'border-box', height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg1)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { boxSizing: 'border-box', minHeight: 34, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', borderColor: 'var(--acc)', color: '#0b0c10' },
  btnLive: { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  err: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--red-d, rgba(255,90,74,.1))', color: 'var(--red)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--red-b, var(--red))' },
  ok: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--grn-d, rgba(21,194,106,.1))', color: 'var(--grn)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--grn-b, var(--grn))' },
  warn: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--orn-b, var(--bdr2))' },
  inner: { marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)' },
};

const TONE_COLOR = {
  ok: 'var(--grn, #15C26A)',
  missing: 'var(--orn, #e8a020)',
  bad: 'var(--red)',
  live: 'var(--red)',
  test: 'var(--t2)',
  info: 'var(--t2)',
  err: 'var(--red)',
  warn: 'var(--orn, #e8a020)',
};

// One object Adyen holds: label, id in mono, the detail in plain words.
function FoundRow({ row }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) 1fr', gap: 10, padding: '5px 0', borderTop: '1px solid var(--bdr)', fontSize: 12.5, alignItems: 'baseline' }}>
      <span style={{ color: 'var(--t3)', fontWeight: 700 }}>
        <span style={{ color: TONE_COLOR[row.tone] || 'var(--t2)', marginRight: 6 }}>{row.tone === 'ok' ? '✓' : row.tone === 'bad' ? '✕' : '·'}</span>
        {row.label}
      </span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
        <span style={{ ...S.mono, color: 'var(--t1)' }}>{row.value}</span>
        {row.detail && <span style={{ color: 'var(--t3)' }}> · {row.detail}</span>}
      </span>
    </div>
  );
}

function Lines({ lines }) {
  if (!lines?.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      {lines.map((l, i) => l.tone === 'title' ? (
        <div key={i} style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--t1)' }}>{l.text}</div>
          <ul style={{ margin: '3px 0 0', paddingLeft: 18 }}>
            {(l.items || []).map((it, j) => <li key={j} style={{ fontSize: 12, lineHeight: 1.5, color: TONE_COLOR[it.tone] || 'var(--t2)', wordBreak: 'break-word' }}>{it.text}</li>)}
          </ul>
        </div>
      ) : (
        <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: TONE_COLOR[l.tone] || 'var(--t2)', wordBreak: 'break-word' }}>{l.text}</div>
      ))}
    </div>
  );
}

// Rough split of a free text address ("9a New Street, Huddersfield, HD3 4LN")
// for the create store form: the last comma part is the postcode, the one
// before it the town, the rest the street. The admin corrects it.
function splitAddress(text) {
  const parts = String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  return {
    line1: parts.length >= 3 ? parts.slice(0, -2).join(', ') : (parts[0] || ''),
    city: parts.length >= 3 ? parts[parts.length - 2] : (parts[1] || ''),
    postal_code: parts.length >= 2 ? parts[parts.length - 1] : '',
  };
}

export default function AdyenLinkPanel({ location, venueCode, environment, callAdmin, onChanged }) {
  const name = location?.name || 'this venue';
  // The reference sent: the venue code by default, editable for a venue
  // whose store was created under another reference.
  const [reference, setReference] = useState('');
  const [refTouched, setRefTouched] = useState(false);
  const effectiveReference = refTouched ? reference.trim() : String(venueCode || '').trim();
  // Look on the test system instead of live: only while the venue is still
  // on test (the fn links a live venue live whatever is asked, so the box
  // is not offered for one and a stale tick is not sent).
  const [useTest, setUseTest] = useState(false);
  const liveVenue = String(environment || '').trim().toLowerCase() === 'live';
  const lookTest = !liveVenue && useTest;
  // Fallback the fn asks for when the store names no balance account: the
  // account holder id. Shown only once a lookup said so.
  const [accountHolderId, setAccountHolderId] = useState('');
  // A candidate store chosen from the pick list (storeId skips the search).
  const [pickedStoreId, setPickedStoreId] = useState('');
  const [lookup, setLookup] = useState(null);      // the adyen_lookup answer
  const [linkAnswer, setLinkAnswer] = useState(null);
  const [busy, setBusy] = useState('');            // 'lookup' | 'link' | 'create'
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(() => ({ ...splitAddress(location?.address), phone: '' }));

  const lookupInputs = (storeId) => ({
    ...(effectiveReference ? { reference: effectiveReference } : {}),
    ...(storeId ? { storeId } : {}),
    ...(accountHolderId.trim() ? { accountHolderId: accountHolderId.trim() } : {}),
    ...(lookTest ? { environment: 'test' } : {}),
  });

  const failureText = (e) => e?.data?.error || e?.message || String(e);

  // keepAnswer: the re-read after a link keeps the Linked box on screen.
  const runLookup = async (storeId = pickedStoreId, { keepAnswer = false } = {}) => {
    setBusy('lookup'); setErr(''); setNotice('');
    if (!keepAnswer) setLinkAnswer(null);
    try {
      const r = await callAdmin('adyen_lookup', lookupInputs(storeId));
      if (r?.ok === false) throw new Error(r.error || 'lookup failed');
      setLookup(r);
      if (!r?.lookup?.found) setCreateOpen(false);
    } catch (e) {
      setLookup(null);
      setErr(failureText(e));
    }
    setBusy('');
  };

  // The ONE confirm before any write, from the lookup's plan: what the link
  // does (go live: real money), the store's status when it is not active,
  // the stored ids a same environment link replaces, and the setup a flip
  // clears (the fn sends provisioned and readers with the lookup).
  const confirmText = () => {
    const l = lookup.lookup;
    const plan = lookup.plan || {};
    const storeId = l.store?.id || '?';
    const status = String(l.store?.status || '');
    const live = lookup.environment === 'live';
    const flips = lookup.previous !== lookup.environment;
    const lines = [];
    if (live) {
      lines.push(flips
        ? `Switch ${name} to LIVE payments on the ${lookup.region} Adyen account and link it to store ${storeId}. Real cards are charged from then on.`
        : `Link ${name} to store ${storeId} on the ${lookup.region} LIVE Adyen account.`);
    } else {
      lines.push(`Link ${name} to store ${storeId} on the ${lookup.region} test account.`);
    }
    const inactive = !!status && status !== 'active';
    if (inactive) lines.push(`The store is ${status.toUpperCase()} at Adyen: it cannot take payments until Adyen makes it active.`);
    const conflicts = Array.isArray(plan.diff?.conflicts) ? plan.diff.conflicts : [];
    if (!flips && conflicts.length) {
      lines.push(`This REPLACES stored ids: ${conflicts.map((c) => `${LINK_FIELD_LABELS[c.field] || c.field} ${c.current} to ${c.next}`).join(', ')}.`);
    }
    if (flips) {
      const provisioned = Array.isArray(lookup.provisioned) ? lookup.provisioned : [];
      const readers = Number(lookup.readers) || 0;
      const bits = [provisioned.length ? 'store ids' : '', readers ? `${readers} card reader${readers === 1 ? '' : 's'}` : ''].filter(Boolean);
      // keepsSetup (8 Sep 2026): the fn keeps what the flip sets aside
      // (env_stash) and puts it back on a switch back. An older fn build
      // sends nothing and the setup is cleared for good.
      if (bits.length) {
        lines.push(lookup.keepsSetup
          ? `This sets aside the venue's ${lookup.previous} setup (${bits.join(' and ')}). Your ${lookup.previous} setup is kept and comes back if you switch back.`
          : `This CLEARS the venue's ${lookup.previous} setup (${bits.join(' and ')}). Register the readers again afterwards.`);
      } else if (plan.kind === 'refuse' && plan.reason && !inactive) lines.push(plan.reason);   // an older fn build without provisioned/readers
      const back = lookup.stashes && lookup.stashes[lookup.environment];
      if (back) lines.push(`The venue's ${lookup.environment} setup kept earlier comes back too, under the ids pulled here: ${stashLine('', back)}.`);
      if (lookup.stashWarning) lines.push(lookup.stashWarning);
    }
    return `${lines.join('\n\n')}\n\nContinue?`;
  };

  // relink: the plan said the fn refuses without it (a stored id replaced,
  // setup cleared, a store that is not active); it is sent ONLY after the
  // confirm above. confirmed: the 409 retry, already confirmed with the
  // fn's own reason (the venue changed between the lookup and the click).
  const runLink = async ({ relink = false, confirmed = false } = {}) => {
    if (!lookup?.lookup?.found) return;
    if (!confirmed && !window.confirm(confirmText())) return;
    setBusy('link'); setErr(''); setNotice('');
    try {
      const r = await callAdmin('adyen_link', { ...lookupInputs(pickedStoreId), ...(relink ? { relink: true } : {}) });
      if (r?.ok === false) throw new Error(r.error || 'link failed');
      setLinkAnswer(r);
      onChanged?.();
      // Read the venue again so the plan says noop and the button rests: a
      // stale plan kept 'Link and go live' clickable after the link.
      await runLookup(pickedStoreId, { keepAnswer: true });
      return;
    } catch (e) {
      if (e?.data?.needs_relink && !relink) {
        setBusy('');
        const kept = e.data.keepsSetup === true && e.data.previous && e.data.environment && e.data.previous !== e.data.environment
          ? `\n\nYour ${e.data.previous} setup is kept and comes back if you switch back.` : '';
        if (window.confirm(`${e.data.error || e.message}${kept}\n\nGo ahead and relink ${name}?`)) {
          await runLink({ relink: true, confirmed: true });
        }
        return;
      }
      setErr(failureText(e));
    }
    setBusy('');
  };

  const runCreate = async () => {
    if (!effectiveReference) { setErr('A store reference is needed. Type the venue code above.'); return; }
    if (!window.confirm(`Create a store with reference ${effectiveReference} for ${name} on Adyen?\n\nContinue?`)) return;
    setBusy('create'); setErr(''); setNotice('');
    try {
      // environment rides as on the lookup, so the store is created on the
      // account the lookup looked on (live by default), never on the
      // venue's current environment by accident.
      const r = await callAdmin('adyen_create_store_by_reference', {
        reference: effectiveReference,
        address: { line1: createForm.line1.trim(), city: createForm.city.trim(), postal_code: createForm.postal_code.trim() },
        phone: createForm.phone.trim(),
        ...(lookTest ? { environment: 'test' } : {}),
      });
      if (r?.ok === false) throw new Error(r.error === 'scope_missing' ? (r.detail || 'The Adyen credential lacks the Management "Stores" role.') : (r.error || 'store create failed'));
      const ref = r.reference || effectiveReference;
      const where = r.environment ? ` on ${r.environment}` : '';
      // Across environments (a test venue's live store) the fn does not
      // write the row: the link that follows maps it and moves the venue.
      let text;
      if (r.foundByReference) {
        text = r.mapped === false
          ? `Store ${r.storeId} already carries the reference ${ref}${where}.${r.hint ? ` ${r.hint}` : ''}`
          : `Store ${r.storeId} already carried the reference ${ref}${where} and is now mapped to ${name}.`;
      } else if (r.existing) {
        text = `${name} is already mapped to store ${r.storeId}${where}.`;
      } else {
        text = `Store ${r.storeId} created with reference ${ref}${where}.${r.mapped === false && r.hint ? ` ${r.hint}` : ''}`;
      }
      if (r.warning) text += ` ${r.warning}`;
      setNotice(text);
      setCreateOpen(false);
      setPickedStoreId('');
      onChanged?.();
      setBusy('');
      await runLookup('');
      return;
    } catch (e) { setErr(failureText(e)); }
    setBusy('');
  };

  const found = !!lookup?.lookup?.found;
  const rows = found ? lookupRows(lookup.lookup) : [];
  const plan = found ? planLine(lookup) : null;
  const candidates = Array.isArray(lookup?.lookup?.candidates) ? lookup.lookup.candidates : [];
  const errors = Array.isArray(lookup?.lookup?.errors) ? lookup.lookup.errors : [];
  const notes = Array.isArray(lookup?.lookup?.notes) ? lookup.lookup.notes : [];
  // The account holder fallback box only helps when the store names NO
  // balance account. When it names one and Adyen refused the read (no BCL
  // role on the key), a pasted holder id hits the same refusal: say so.
  const storeNamesBalance = !!lookup?.lookup?.store?.balanceAccountId;
  const noHolder = found && !lookup.lookup.accountHolder;
  const needsHolder = noHolder && !storeNamesBalance;
  const holderRefused = noHolder && storeNamesBalance && errors.some((t) => /refused/i.test(String(t)));
  // Two stores carrying the reference (one per merchant account): the fn
  // refuses to create a third, so the button is not offered; the pick list
  // is the way.
  const ambiguous = !!effectiveReference && candidates.filter((c) => referenceKey(c.reference) === referenceKey(effectiveReference)).length > 1;
  const targetLive = lookup?.environment === 'live';
  const flips = !!lookup && lookup.previous !== lookup.environment;
  const refuse = lookup?.plan?.kind === 'refuse';
  const clears = flips && ((Array.isArray(lookup.provisioned) && lookup.provisioned.length > 0) || Number(lookup.readers) > 0);
  const linkLabel = !lookup ? 'Link and go live'
    : lookup.plan?.kind === 'noop' ? 'Already linked'
    : targetLive && flips ? (clears ? `Link and go live (replaces ${lookup.previous} setup)` : 'Link and go live')
    : refuse ? 'Replace and relink'
    : targetLive ? 'Link on live' : 'Link on test';

  return (
    <div style={S.block}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ ...S.label, color: 'var(--acc)' }}>Link to Adyen (ServOS admin only)</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>
            Pull the venue&rsquo;s store, balance account, account holder and legal entity from Adyen by its reference
          </div>
          <div style={S.desc}>
            Adyen holds the venue under its venue code as the store reference. Nothing is typed: look it up, check what came back, then link.
            {liveVenue ? ' This venue is live, so it looks on the LIVE account for its region.' : lookTest ? ' Looking on the TEST system.' : ' Looks on the LIVE account for the venue’s region.'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={S.label}>Venue reference</span>
          <input
            style={{ ...S.input, ...S.mono, width: 160, letterSpacing: '.04em' }}
            value={refTouched ? reference : String(venueCode || '')}
            placeholder={venueCode ? String(venueCode) : 'SV-1007'}
            onChange={(e) => { setRefTouched(true); setReference(e.target.value.toUpperCase()); }}
            spellCheck={false} autoComplete="off"
          />
        </label>
        {refTouched && String(venueCode || '') && reference.trim() !== String(venueCode) && (
          <button style={{ ...S.btn, minHeight: 34 }} onClick={() => { setRefTouched(false); setReference(''); }} title={`Back to the venue code ${venueCode}`}>Use {venueCode}</button>
        )}
        {needsHolder && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={S.label}>Account holder id (fallback)</span>
            <input style={{ ...S.input, ...S.mono, width: 250 }} value={accountHolderId} placeholder="AH..."
              onChange={(e) => setAccountHolderId(e.target.value.trim())} spellCheck={false} autoComplete="off" />
          </label>
        )}
        <button style={{ ...S.btn, ...S.btnPrim, opacity: busy ? 0.6 : 1 }} disabled={!!busy || (!effectiveReference && !pickedStoreId)}
          title="Read the venue's store, balance account, account holder and legal entity from Adyen (nothing is written)"
          onClick={() => { setPickedStoreId(''); runLookup(''); }}>
          {busy === 'lookup' ? 'Looking up…' : 'Look up on Adyen'}
        </button>
        {!liveVenue && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t3)', minHeight: 34, cursor: 'pointer' }}
            title="Look on the test system instead of live (only while the venue is still on test cards)">
            <input type="checkbox" checked={useTest} onChange={(e) => { setUseTest(e.target.checked); setLookup(null); setLinkAnswer(null); }} />
            test system
          </label>
        )}
      </div>
      {!venueCode && !refTouched && (
        <div style={{ ...S.desc, color: 'var(--orn, #e8a020)' }}>This venue has no venue code yet. Set one in its Back Office (Venue settings), or type the store reference here.</div>
      )}

      {lookup && (
        <div style={S.inner}>
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>
            Looked on <span style={S.mono}>{lookup.merchantAccount}</span> ({lookup.region} {lookup.environment})
            {lookup.reference ? <> for reference <span style={S.mono}>{lookup.reference}</span></> : null}
            {pickedStoreId ? <> (store <span style={S.mono}>{pickedStoreId}</span> chosen from the list)</> : null}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, color: found ? 'var(--t1)' : 'var(--orn, #e8a020)' }}>{lookup.summary}</div>
          {rows.length > 0 && <div style={{ marginTop: 6 }}>{rows.map((r) => <FoundRow key={r.key} row={r} />)}</div>}
          {errors.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {errors.map((t, i) => <li key={i} style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--red)', wordBreak: 'break-word' }}>{t}</li>)}
            </ul>
          )}
          {notes.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {notes.map((t, i) => <li key={i} style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--orn, #e8a020)', wordBreak: 'break-word' }}>{t}</li>)}
            </ul>
          )}
          {needsHolder && !accountHolderId && (
            <div style={{ ...S.desc, color: 'var(--orn, #e8a020)' }}>
              The store names no balance account, so no account holder could be reached from it. If Adyen gave the venue&rsquo;s account holder id, put it in the fallback box and look up again.
            </div>
          )}
          {holderRefused && (
            <div style={{ ...S.desc, color: 'var(--orn, #e8a020)' }}>
              The store names balance account <span style={S.mono}>{lookup.lookup.store.balanceAccountId}</span> but Adyen refused the read (the red line above says which role the credential needs), so no account holder could be reached. Fix the credential and look up again; a pasted account holder id would hit the same refusal.
            </div>
          )}
          {plan && (
            <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: TONE_COLOR[plan.tone] || 'var(--t2)', lineHeight: 1.5 }}>{plan.text}</div>
          )}
          {found && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                style={{ ...S.btn, ...(targetLive ? S.btnLive : S.btnPrim), opacity: busy || lookup.plan?.kind === 'noop' ? 0.6 : 1 }}
                disabled={!!busy || lookup.plan?.kind === 'noop'}
                title={targetLive ? 'Write the ids to the venue, switch it live when it is not yet, and register origins and Apple Pay. You are asked to confirm first.' : 'Write the ids to the venue on test. You are asked to confirm first.'}
                onClick={() => runLink({ relink: refuse })}>
                {busy === 'link' ? 'Linking…' : linkLabel}
              </button>
              {(refuse || (targetLive && flips)) && (
                <span style={{ fontSize: 12, color: 'var(--t3)' }}>
                  {flips
                    ? `Moves ${name} to live${clears ? (lookup.keepsSetup ? ` and sets aside its ${lookup.previous} setup (kept, it comes back if you switch back)` : ` and clears its ${lookup.previous} setup`) : ''}.`
                    : 'Replaces the stored ids named above.'} You will be asked to confirm.
                </span>
              )}
            </div>
          )}

          {!found && (
            <div style={{ marginTop: 10 }}>
              {candidates.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 320px', minWidth: 0 }}>
                    <span style={S.label}>Stores on {lookup.merchantAccount} ({candidates.length})</span>
                    <select style={{ ...S.input, width: '100%' }} value={pickedStoreId} onChange={(e) => setPickedStoreId(e.target.value)}>
                      <option value="">Pick a store if one of these is {name}…</option>
                      {candidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
                    </select>
                  </label>
                  <button style={{ ...S.btn, ...S.btnPrim, opacity: !pickedStoreId || busy ? 0.6 : 1 }} disabled={!pickedStoreId || !!busy}
                    title="Read the chosen store and what hangs off it, then link from there"
                    onClick={() => runLookup(pickedStoreId)}>
                    {busy === 'lookup' ? 'Looking up…' : 'Look up this store'}
                  </button>
                </div>
              )}
              {!lookup.lookup?.scopeMissing && effectiveReference && !ambiguous && (
                <div style={{ marginTop: 10 }}>
                  {!createOpen ? (
                    <button style={S.btn} disabled={!!busy} onClick={() => setCreateOpen(true)}
                      title="No store carries this reference: create one on the merchant account with it">
                      Create store with reference {effectiveReference}
                    </button>
                  ) : (
                    <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr2)' }}>
                      <div style={{ ...S.label }}>Create store {effectiveReference} for {name}</div>
                      <div style={S.desc}>
                        The store is the record Adyen keeps for the venue: the address and phone number go on it as typed
                        {targetLive ? ', and on live they are required.' : '.'}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 10 }}>
                        {[
                          ['line1', 'Street address', '9a New Street'],
                          ['city', 'Town or city', 'Huddersfield'],
                          ['postal_code', 'Postcode', 'HD3 4LN'],
                          ['phone', 'Phone number', '+44 1484 000000'],
                        ].map(([key, label, ph]) => (
                          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={S.label}>{label}{targetLive ? ' *' : ''}</span>
                            <input style={S.input} value={createForm[key]} placeholder={ph}
                              onChange={(e) => setCreateForm((f) => ({ ...f, [key]: e.target.value }))} />
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button style={{ ...S.btn, ...S.btnPrim, opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={runCreate}>
                          {busy === 'create' ? 'Creating…' : 'Create store'}
                        </button>
                        <button style={S.btn} disabled={!!busy} onClick={() => setCreateOpen(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {linkAnswer && (
        <div style={S.inner}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--grn)' }}>Linked</div>
          <Lines lines={linkResultLines(linkAnswer, name)} />
        </div>
      )}
      {notice && <div style={S.ok}>{notice}</div>}
      {err && <div style={S.err}>{err}</div>}
    </div>
  );
}
