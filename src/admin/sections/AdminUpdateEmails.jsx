// src/admin/sections/AdminUpdateEmails.jsx
//
// Company Admin, Email an update (ServOS staff only). Lives on the Messages to venues screen.
//
// WHY (Peter, 8 Oct 2026): he writes a what's new email for clients each week. "Do we have a way
// to email it to people that are registered in the back office? Right now it's only a few and I
// can manually send, but would be good to be able to send it out."
// His calls: subject plus a body in simple Markdown with a live preview; pick companies (all or
// some); every owner or manager login with Back Office access and an email, one email each,
// ServOS staff left out unless asked; the list of people is shown before Send; a test to himself
// first, and Send only opens once a test of the CURRENT text has gone (a changed word closes it
// again); the server checks the count it was shown and refuses if the list changed.
//
// This screen only asks. The update-emails-admin edge function decides who may send (ServOS
// staff with the second sign in step done), picks the people again, renders the email again with
// the same renderer this preview uses (lib/updateEmailRules.js) and writes one row per person
// (20261008b_OPS_update_emails.sql). Nothing here sends anything by itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callUpdateEmails, newBroadcastId } from '../../lib/updateEmails';
import {
  SUBJECT_MAX, BODY_MAX, MAX_RECIPIENTS_PER_SEND, ROLE_LABEL, NEEDS_UPDATE_LINE, NO_PROVIDER_LINE,
  cleanDraft, textHash, buildEmail, sendQuestion, sendResultLine, peopleWord, rollupSends, countsLine, formatWhen,
} from '../../lib/updateEmailRules';

const WHO_DEBOUNCE_MS = 300;
const PLACEHOLDER_BODY = `# What's new this week

A short line about the update.

## Orders screen
- The next step is named on the card
- **Bold** for the important bit

See the [help page](https://serv-os.app) for more.`;

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 4, letterSpacing: '-.01em', marginTop: 28 },
  sub: { fontSize: 14, color: 'var(--t3)', marginBottom: 20, maxWidth: 760, lineHeight: 1.5 },
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: 'var(--sh)' },
  h2: { fontSize: 16, fontWeight: 800, color: 'var(--t1)', marginBottom: 12 },
  label: { fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 6, display: 'block' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn: { padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' },
  primary: { background: 'var(--acc)', color: '#0b0c10' },
  ghost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  error: { padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 14, border: '1px solid var(--red-b)' },
  note: { padding: 12, background: 'var(--acc-d)', color: 'var(--t1)', borderRadius: 8, marginBottom: 14, fontSize: 14, border: '1px solid var(--acc-b)' },
  hint: { fontSize: 13, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 },
  check: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, color: 'var(--t1)', padding: '4px 0' },
  pill: (tone) => ({
    display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
    background: tone === 'red' ? 'var(--red-d)' : tone === 'acc' ? 'var(--acc-d)' : 'var(--bg3)',
    color: tone === 'red' ? 'var(--red)' : tone === 'acc' ? 'var(--acc)' : 'var(--t2)',
    border: `1px solid ${tone === 'red' ? 'var(--red-b)' : tone === 'acc' ? 'var(--acc-b)' : 'var(--bdr)'}`,
  }),
};

export default function AdminUpdateEmails() {
  // The draft
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Who
  const [allCompanies, setAllCompanies] = useState(true);
  const [ticked, setTicked] = useState(() => new Set());
  const [ownersOnly, setOwnersOnly] = useState(false);
  const [includeStaff, setIncludeStaff] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [left, setLeft] = useState(null);
  const [whoLoaded, setWhoLoaded] = useState(false);
  // The choices the list on screen was loaded for. While they differ from the current choices
  // the list is stale and Send stays closed (8 Oct 2026, review: a tick swapped inside the
  // debounce showed one list and sent to another of the same size).
  const [loadedKey, setLoadedKey] = useState(null);
  const wantKey = useRef('');
  // Sent
  const [rows, setRows] = useState([]);
  const [historyCompanies, setHistoryCompanies] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [notReady, setNotReady] = useState(false);
  const [providerOk, setProviderOk] = useState(true);
  const [from, setFrom] = useState('');
  const [open, setOpen] = useState(null);
  // Screen
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  // The code of the text the last test carried. Send opens only while the draft still has it.
  const [testedHash, setTestedHash] = useState(null);
  // One id per draft: a retry after a lost reply can never email the same person twice. One id
  // is one text: the server refuses the id (already_sent) if the words changed in between.
  const draftId = useRef(newBroadcastId());

  const draft = useMemo(() => cleanDraft({ subject, bodyMd: body }), [subject, body]);
  const currentHash = useMemo(() => textHash(subject, body), [subject, body]);
  const tested = testedHash != null && testedHash === currentHash;
  const companyIds = allCompanies ? null : [...ticked];
  const count = recipients.length;
  const bodyLen = [...body].length;

  const loadHistory = useCallback(async ({ quiet = false } = {}) => {
    try {
      const res = await callUpdateEmails('history');
      setRows(res.rows || []);
      setHistoryCompanies(res.companies || []);
      setNotReady(res.ready === false);
      setProviderOk(res.provider_ready !== false);
      setFrom(res.from || '');
      if (!quiet) setErr('');
    } catch (e) {
      if (e.notReady) setNotReady(true);
      else if (!quiet) setErr(e.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadWho = useCallback(async (ids, owners, staff, key) => {
    try {
      const res = await callUpdateEmails('recipients', { company_ids: ids, owners_only: owners, include_staff: staff });
      // The choices moved on while this was in flight: that answer is for a list nobody wants.
      if (key !== wantKey.current) return;
      setCompanies(res.companies || []);
      setRecipients(res.recipients || []);
      setLeft(res.left || null);
      setLoadedKey(key);
    } catch (e) {
      if (key !== wantKey.current) return;
      if (e.notReady) setNotReady(true);
      else setErr(e.message);
    } finally {
      if (key === wantKey.current) setWhoLoaded(true);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => loadHistory(), 0);
    return () => clearTimeout(first);
  }, [loadHistory]);

  // The list of people follows the choices, a moment after the last tick.
  const tickedKey = [...ticked].sort().join(',');
  const whoKey = `${allCompanies ? 'all' : tickedKey}|${ownersOnly ? 'owners' : 'everyone'}|${includeStaff ? 'staff' : 'nostaff'}`;
  const whoStale = loadedKey !== whoKey;
  useEffect(() => {
    wantKey.current = whoKey;
    const t = setTimeout(() => loadWho(allCompanies ? null : tickedKey.split(',').filter(Boolean), ownersOnly, includeStaff, whoKey), WHO_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [loadWho, whoKey, allCompanies, tickedKey, ownersOnly, includeStaff]);

  const sends = useMemo(() => rollupSends(rows, historyCompanies), [rows, historyCompanies]);
  const preview = useMemo(() => buildEmail({
    subject: draft.ok ? draft.subject : (subject.trim() || 'Subject'),
    bodyMd: body.trim() ? body : '*Your email shows here as you type.*',
    companyName: recipients[0]?.company || 'the company',
  }), [draft, subject, body, recipients]);

  const toggleCompany = (id, on) => setTicked((prev) => {
    const next = new Set(prev);
    if (on) next.add(String(id)); else next.delete(String(id));
    return next;
  });

  const resetDraft = () => {
    setSubject(''); setBody(''); setTestedHash(null); draftId.current = newBroadcastId();
  };

  const sendTest = async () => {
    setErr(''); setNote('');
    if (!draft.ok) { setErr(draft.error); return; }
    setBusy('test');
    try {
      const res = await callUpdateEmails('test', { subject: draft.subject, body_md: draft.bodyMd });
      setTestedHash(currentHash);
      setNote(`Test sent to ${res.to}. Check it in your inbox, then Send. In the test the footer names ServOS; each person's email names their own company.`);
      await loadHistory({ quiet: true });
    } catch (e) {
      if (e.notReady) setNotReady(true);
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const send = async () => {
    setErr(''); setNote('');
    if (!draft.ok) { setErr(draft.error); return; }
    if (!tested) { setErr('Send yourself a test of this text first.'); return; }
    if (whoStale) { setErr('The list of people is still updating. Wait a moment, then Send.'); return; }
    if (!count) { setErr('Nobody matches those choices. Tick a company that has Back Office logins.'); return; }
    if (!window.confirm(sendQuestion(count))) return;
    setBusy('send');
    try {
      const res = await callUpdateEmails('send', {
        subject: draft.subject, body_md: draft.bodyMd, company_ids: companyIds, owners_only: ownersOnly, include_staff: includeStaff,
        // The count AND the people shown: the server refuses if either differs from its own list.
        expect_count: count, expect_emails: recipients.map((r) => r.email), broadcast_id: draftId.current,
      });
      // From what the server really SENT, not what was picked: a second try after a lost reply
      // sends only to those still waiting, and must not read as a second send.
      setNote(sendResultLine({ sent: res.sent, failed: res.failed, skipped: res.skipped, waiting: res.waiting }));
      // A clean send: the draft is done. With failures, or people an earlier try still holds, the
      // draft and its id stay, so Send again goes only to the people who have not had it.
      if (!res.failed && !res.waiting) resetDraft();
      await loadHistory({ quiet: true });
    } catch (e) {
      if (e.notReady) setNotReady(true);
      setErr(e.message);
      if (e.code === 'count_changed') await loadWho(companyIds, ownersOnly, includeStaff, whoKey);
      // An earlier try DID arrive (its reply was lost) and the words have changed since. That
      // send keeps its id and its words; this draft is a new email from here on.
      if (e.code === 'already_sent') { draftId.current = newBroadcastId(); await loadHistory({ quiet: true }); }
      if (e.code === 'test_first') setTestedHash(null);
    } finally {
      setBusy('');
    }
  };

  const sendDisabled = !!busy || notReady || !providerOk || !draft.ok || !tested || whoStale || count === 0 || count > MAX_RECIPIENTS_PER_SEND;
  const whyNotSend = !draft.ok ? (subject.trim() || body.trim() ? draft.error : '')
    : testedHash == null ? 'Send yourself a test first. Send opens once the test has gone.'
      : !tested ? 'The text changed since the test. Send yourself a new test.'
        : whoStale ? 'Updating the list…'
          : count === 0 ? 'Nobody matches those choices.'
            : count > MAX_RECIPIENTS_PER_SEND ? `That is more than ${MAX_RECIPIENTS_PER_SEND} people in one send. Tick fewer companies.` : '';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div data-testid="admin-update-emails">
      <div style={S.h1}>Email an update</div>
      <div style={S.sub}>
        Email your what's new to the people with a Back Office login at the companies you pick: every owner and
        manager, one email each, from {from || 'ServOS'}. Send yourself a test first. Send opens after the test.
      </div>

      {notReady && <div style={S.error} role="alert">{NEEDS_UPDATE_LINE}</div>}
      {!notReady && loaded && !providerOk && <div style={S.error} role="alert">{NO_PROVIDER_LINE}</div>}
      {err && !notReady && <div style={S.error} role="alert">{err}</div>}
      {note && <div style={S.note}>{note}</div>}

      {/* ── Write and preview ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ ...S.h2, marginBottom: 0, flex: 1 }}>The email</div>
            {(subject || body) && <button type="button" style={{ ...S.btn, ...S.ghost }} disabled={!!busy} onClick={resetDraft}>Start again</button>}
          </div>

          <label style={S.label} htmlFor="ue-subject">Subject</label>
          <input id="ue-subject" style={{ ...S.input, marginBottom: 4 }} value={subject} maxLength={SUBJECT_MAX}
            onChange={(e) => setSubject(e.target.value)} placeholder="What's new in ServOS this week" />
          <div style={{ ...S.hint, marginBottom: 14 }}>{[...subject].length} of {SUBJECT_MAX} characters.</div>

          <label style={S.label} htmlFor="ue-body">Email</label>
          <textarea id="ue-body" style={{ ...S.input, minHeight: 320, resize: 'vertical', lineHeight: 1.5, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 14 }} value={body}
            onChange={(e) => setBody(e.target.value)} placeholder={PLACEHOLDER_BODY} />
          <div style={{ ...S.hint, color: bodyLen > BODY_MAX ? 'var(--red)' : 'var(--t3)' }}>
            {bodyLen} of {BODY_MAX} characters. Paste from your doc. Headings start with # or ## or ###, bullets with -, numbered
            lists with 1., **bold**, *italic*, links as [words](https://...). A blank line starts a new paragraph. Anything else is
            plain text.
          </div>
        </div>

        <div>
          <div style={{ ...S.label, marginBottom: 8 }}>How it looks in their inbox</div>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html}
            style={{ width: '100%', height: 620, border: '1px solid var(--bdr)', borderRadius: 12, background: '#F5F7F4' }} />
        </div>
      </div>

      {/* ── Who ── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ ...S.h2, marginBottom: 0, flex: 1 }}>
            Goes to {peopleWord(count)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...S.btn, ...(allCompanies ? { background: 'var(--acc-d)', color: 'var(--acc)', border: '1px solid var(--acc-b)' } : S.ghost) }}
              aria-pressed={allCompanies} onClick={() => setAllCompanies(true)}>All companies</button>
            <button type="button" style={{ ...S.btn, ...(!allCompanies ? { background: 'var(--acc-d)', color: 'var(--acc)', border: '1px solid var(--acc-b)' } : S.ghost) }}
              aria-pressed={!allCompanies} onClick={() => setAllCompanies(false)}>Pick companies</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
          <div>
            {!allCompanies && (
              <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 12, borderTop: '1px solid var(--bdr)' }}>
                {whoLoaded && companies.length === 0 && <div style={{ fontSize: 14, color: 'var(--t3)', padding: '8px 0' }}>No companies to show.</div>}
                {companies.map((c) => (
                  <label key={c.id} style={{ ...S.check, borderBottom: '1px solid var(--bdr)', padding: '8px 0' }}>
                    <input type="checkbox" checked={ticked.has(String(c.id))} onChange={(e) => toggleCompany(c.id, e.target.checked)} style={{ width: 18, height: 18 }} />
                    <span style={{ flex: 1, fontWeight: 700, overflowWrap: 'anywhere' }}>{c.name || 'Unnamed company'}</span>
                    {c.status && c.status !== 'active' && <span style={S.pill('plain')}>{c.status}</span>}
                    <span style={{ fontSize: 13, color: 'var(--t3)' }}>{c.count === 1 ? '1 login' : `${c.count} logins`}</span>
                  </label>
                ))}
              </div>
            )}
            <label style={S.check}>
              <input type="checkbox" checked={ownersOnly} onChange={(e) => setOwnersOnly(e.target.checked)} style={{ width: 18, height: 18 }} />
              Owners only <span style={{ color: 'var(--t3)', fontSize: 13 }}>(leave managers out)</span>
            </label>
            <label style={S.check}>
              <input type="checkbox" checked={includeStaff} onChange={(e) => setIncludeStaff(e.target.checked)} style={{ width: 18, height: 18 }} />
              Include ServOS staff <span style={{ color: 'var(--t3)', fontSize: 13 }}>(serv-os.app and posup.co.uk logins)</span>
            </label>
            {left && (
              <div style={S.hint}>
                {left.staff > 0 && !includeStaff ? `${peopleWord(left.staff)} at ServOS left out. ` : ''}
                {left.noEmail > 0 ? `${left.noEmail === 1 ? '1 login has' : `${left.noEmail} logins have`} no email. ` : ''}
                {left.noAccess > 0 ? `${left.noAccess === 1 ? '1 login has' : `${left.noAccess} logins have`} Back Office switched off. ` : ''}
                {left.duplicate > 0 ? `${left.duplicate === 1 ? '1 address appears' : `${left.duplicate} addresses appear`} twice and gets one email. ` : ''}
              </div>
            )}
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto', borderTop: '1px solid var(--bdr)' }}>
            {!whoLoaded && <div style={{ fontSize: 14, color: 'var(--t3)', padding: '8px 0' }}>Loading…</div>}
            {whoLoaded && whoStale && <div style={{ fontSize: 14, color: 'var(--t3)', padding: '8px 0' }}>Updating the list…</div>}
            {whoLoaded && count === 0 && <div style={{ fontSize: 14, color: 'var(--t3)', padding: '8px 0' }}>{allCompanies ? 'No Back Office logins match.' : 'Tick a company.'}</div>}
            {recipients.map((r) => (
              <div key={r.email} style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderBottom: '1px dashed var(--bdr)', fontSize: 14 }}>
                <span style={{ minWidth: 150, fontWeight: 700, color: 'var(--t1)' }}>{r.name || 'No name'}</span>
                <span style={{ color: 'var(--t2)', overflowWrap: 'anywhere' }}>{r.email}</span>
                <span style={S.pill(r.role === 'owner' ? 'acc' : 'plain')}>{ROLE_LABEL[r.role] || r.role}</span>
                <span style={{ color: 'var(--t3)', fontSize: 13 }}>{r.company}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Test, then Send ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
          <button type="button" style={{ ...S.btn, ...S.ghost, opacity: (busy || notReady || !providerOk || !draft.ok) ? 0.6 : 1 }}
            disabled={!!busy || notReady || !providerOk || !draft.ok} onClick={sendTest}>
            {busy === 'test' ? 'Sending the test…' : (tested ? 'Send me the test again' : 'Send me a test')}
          </button>
          <button type="button" style={{ ...S.btn, ...S.primary, opacity: sendDisabled ? 0.5 : 1 }} disabled={sendDisabled} onClick={send}>
            {busy === 'send' ? 'Sending…' : `Send to ${peopleWord(count)}`}
          </button>
          {tested && !busy && <span style={S.pill('acc')}>Tested</span>}
          {whyNotSend && !busy && <span style={{ fontSize: 14, color: 'var(--t3)' }}>{whyNotSend}</span>}
        </div>
      </div>

      {/* ── Sent ── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ ...S.h2, marginBottom: 0, flex: 1 }}>Sent <span style={{ fontWeight: 500, color: 'var(--t3)', fontSize: 14 }}>last 180 days</span></div>
          <button type="button" style={{ ...S.btn, ...S.ghost }} onClick={() => loadHistory()}>Refresh</button>
        </div>
        {loaded && sends.length === 0 && <div style={{ fontSize: 14, color: 'var(--t3)' }}>Nothing sent yet.</div>}
        {sends.map((g) => {
          const isOpen = open === g.broadcastId;
          return (
            <div key={g.broadcastId} style={{ borderTop: '1px solid var(--bdr)', padding: '14px 0', opacity: g.isTest ? 0.8 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                {g.isTest
                  ? <span style={S.pill('plain')}>Test</span>
                  : <span style={S.pill(g.failed > 0 ? 'red' : g.queued > 0 ? 'plain' : 'acc')}>{countsLine(g)}</span>}
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {g.isTest ? 'Sent' : `To ${peopleWord(g.total)}, sent`} {formatWhen(g.sentAt, tz)} your time{g.sentByName ? ` by ${g.sentByName}` : ''}
                </span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', overflowWrap: 'anywhere' }}>{g.subject}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <button type="button" style={{ ...S.btn, ...S.ghost }} onClick={() => setOpen(isOpen ? null : g.broadcastId)} aria-expanded={isOpen}>
                  {isOpen ? 'Hide' : (g.total === 1 ? 'Show who and the text' : `Show the ${g.total} people and the text`)}
                </button>
              </div>
              {isOpen && (
                <div style={{ marginTop: 10 }}>
                  {g.recipients.map((r) => (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderTop: '1px dashed var(--bdr)', fontSize: 14 }}>
                      <span style={{ minWidth: 150, fontWeight: 700, color: 'var(--t1)' }}>{r.name || 'No name'}</span>
                      <span style={{ color: 'var(--t2)', overflowWrap: 'anywhere' }}>{r.email}</span>
                      {r.company && <span style={{ color: 'var(--t3)', fontSize: 13 }}>{r.company}</span>}
                      <span style={{ color: r.status === 'failed' ? 'var(--red)' : 'var(--t2)' }}>
                        {r.status === 'sent' ? 'Sent' : r.status === 'failed' ? `Failed: ${r.error || 'no reason given'}` : 'Queued'}
                      </span>
                    </div>
                  ))}
                  <pre style={{ marginTop: 12, padding: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--t1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{g.bodyMd}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
