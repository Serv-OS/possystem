// src/backoffice/sections/workforce/WfChat.jsx
// MARKER 5.11.102 Back Office team chat
//
// Workforce, Team chat (5.11.102): running ServOS Team Chat from Back Office.
//   Groups           every group this login runs (owners: the company; managers: their venues),
//                    new groups, rename, archive, members (picker with venue and position filters,
//                    add everyone shown), admins.
//   Reports to check (ChatReports, shared with the Manager app).
//   Owner and Admin only: Settings, Word lists, Moderation log, Export a person, Open a DM (with
//   a typed reason, logged).
// Everything goes through the team-chat function with this Back Office login; the database decides
// what this login may see and do (20261103a). Chat is company wide, so this screen is too: the
// venue switcher does not narrow it (a manager sees only their own venues' groups anyway).

import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { callTeamChat } from '../../../staff/chatSource';
import ChatReports from '../../../staff/ChatReports';
import { Card, Badge, inputStyle, labelStyle, LoadingCard, EmptyState } from '../../../staff/wfUi';

const KIND = { group: 'Group', venue: 'Venue group', position: 'Position group', announce: 'Announcements' };
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

function Tabs({ tabs, active, onTab }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
      {tabs.map(([k, lbl, n]) => (
        <button key={k} className={active === k ? 'btn btn-acc' : 'btn'} onClick={() => onTab(k)}>{lbl}{n ? ` (${n})` : ''}</button>
      ))}
    </div>
  );
}

export default function WfChat({ ctx, showToast }) {
  const orgId = isUuid(ctx?.venueOrgId) ? ctx.venueOrgId : null;
  const call = useCallback((body) => callTeamChat(supabase, orgId ? { org_id: orgId, ...body } : body), [orgId]);
  const [who, setWho] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('groups');
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    let alive = true;
    call({ action: 'bootstrap' }).then((r) => { if (!alive) return; if (r.ok) setWho(r); else setErr(r.message || 'Team chat is not switched on yet.'); });
    return () => { alive = false; };
  }, [call]);

  if (err) return <EmptyState icon="team" title="Team chat" body={err} />;
  if (!who) return <LoadingCard label="Loading team chat…" />;
  if (who.level === 'staff') return <EmptyState icon="team" title="Team chat" body="Running team chat is for managers and owners. Your own chats are in the staff app." />;
  const owner = who.level === 'owner';
  const tabs = [['groups', 'Groups'], ['reports', 'Reports to check', openCount],
    ...(owner ? [['settings', 'Settings'], ['words', 'Word lists'], ['log', 'Moderation log'], ['export', 'Export a person'], ['dm', 'Open a DM']] : [])];
  const toast = (msg, type = 'success') => showToast?.(msg, type);

  return (
    <div>
      <Tabs tabs={tabs} active={tab} onTab={setTab} />
      {tab === 'groups' && <Groups call={call} who={who} toast={toast} />}
      {tab === 'reports' && <Card><ChatReports call={call} onCount={setOpenCount} /></Card>}
      {tab === 'settings' && owner && <Settings call={call} who={who} setWho={setWho} toast={toast} />}
      {tab === 'words' && owner && <Words call={call} toast={toast} />}
      {tab === 'log' && owner && <Log call={call} />}
      {tab === 'export' && owner && <ExportPerson call={call} toast={toast} />}
      {tab === 'dm' && owner && <OpenDm call={call} />}
    </div>
  );
}

// ── People picker: venue and position filters, search, add everyone shown ────
function PeoplePicker({ call, picked, setPicked, single = false, exclude = [] }) {
  const [loc, setLoc] = useState('');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    call({ action: 'people', location_id: loc || null, role_key: role || null }).then((r) => { if (alive) setData(r.ok ? r : { people: [], venues: [], positions: [] }); });
    return () => { alive = false; };
  }, [call, loc, role]);
  const shown = useMemo(() => (data?.people || []).filter((p) => !exclude.includes(p.member_id) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))), [data, q, exclude]);
  const venueName = (id) => (data?.venues || []).find((v) => v.id === id)?.name || '';
  const toggle = (id) => (single ? setPicked([id]) : setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginBottom: 8 }}>
        <select value={loc} onChange={(e) => setLoc(e.target.value)} style={inputStyle}>
          <option value="">Every venue</option>
          {(data?.venues || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
          <option value="">Every position</option>
          {(data?.positions || []).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" style={inputStyle} />
      </div>
      {!single && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 12.5, color: 'var(--t3)' }}>
          <span>{shown.length} shown · {picked.length} picked</span>
          <button className="btn" onClick={() => setPicked([...new Set([...picked, ...shown.map((p) => p.member_id)])])}>Add everyone shown</button>
          {picked.length > 0 && <button className="btn" onClick={() => setPicked([])}>Clear</button>}
        </div>
      )}
      <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 10 }}>
        {data === null && <div style={{ padding: 12, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
        {shown.map((p) => (
          <label key={p.member_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer', fontSize: 13 }}>
            <input type={single ? 'radio' : 'checkbox'} checked={picked.includes(p.member_id)} onChange={() => toggle(p.member_id)} />
            <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
            <span style={{ color: 'var(--t3)', fontSize: 12 }}>{[p.role_key, venueName(p.location_id)].filter(Boolean).join(' · ') || (p.kind === 'office' ? 'Back Office' : '')}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Groups ───────────────────────────────────────────────────────────────────
function Groups({ call, who, toast }) {
  const [groups, setGroups] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(async () => { const r = await call({ action: 'admin.groups' }); setGroups(r.ok ? r.groups : []); }, [call]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);
  if (groups === null) return <LoadingCard />;
  const open = groups.find((g) => g.id === openId);
  if (open) return <GroupEditor call={call} group={open} who={who} toast={toast} onBack={() => { setOpenId(null); load(); }} />;
  if (creating) return <NewGroup call={call} who={who} toast={toast} onDone={(id) => { setCreating(false); load().then(() => id && setOpenId(id)); }} />;
  const list = groups.filter((g) => showArchived || !g.archived_at);
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Groups</div>
        <label style={{ fontSize: 12.5, color: 'var(--t3)', display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show closed</label>
        <div style={{ flex: 1 }} />
        <button className="btn btn-acc" onClick={() => setCreating(true)}>New group</button>
      </div>
      {list.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 13 }}>No groups yet.</div>}
      {list.map((g) => (
        <button key={g.id} onClick={() => setOpenId(g.id)} style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'center', padding: '10px 6px', borderBottom: '1px solid var(--bdr)', background: 'none', border: 'none', borderBottomStyle: 'solid', cursor: 'pointer', color: 'var(--t1)', fontFamily: 'inherit', textAlign: 'left' }}>
          <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{g.name || KIND[g.kind]}</span>
          <Badge tone={g.kind === 'announce' ? 'amber' : g.kind === 'venue' ? 'blue' : 'grey'}>{KIND[g.kind]}</Badge>
          {g.archived_at && <Badge tone="grey">Closed</Badge>}
          <span style={{ fontSize: 12, color: 'var(--t3)', width: 80, textAlign: 'right' }}>{g.members} people</span>
        </button>
      ))}
    </Card>
  );
}

function NewGroup({ call, who, toast, onDone }) {
  const [kind, setKind] = useState('group');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loc, setLoc] = useState('');
  const [role, setRole] = useState('');
  const [picked, setPicked] = useState([]);
  const [meta, setMeta] = useState({ venues: [], positions: [] });
  const [err, setErr] = useState('');
  useEffect(() => { call({ action: 'people' }).then((r) => r.ok && setMeta({ venues: r.venues || [], positions: r.positions || [] })); }, [call]);
  const owner = who.level === 'owner';
  const venues = owner ? meta.venues : meta.venues.filter((v) => (who.manages || []).includes(v.id));
  const save = async () => {
    setErr('');
    const r = await call({ action: 'group.create', kind, name, description, location_id: loc || null, role_key: role || null, members: kind === 'group' ? picked : [] });
    if (!r.ok) { setErr(r.message); return; }
    toast('Group made');
    onDone(r.conversation_id);
  };
  return (
    <Card>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>New group</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 10 }}>
        <label><span style={labelStyle}>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}>
            <option value="group">Group (people you pick)</option>
            <option value="position">Everyone in a position</option>
            <option value="announce">Announcements (only admins post)</option>
          </select></label>
        <label><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} style={inputStyle} /></label>
        {kind !== 'group' && (
          <label><span style={labelStyle}>Venue</span>
            <select value={loc} onChange={(e) => setLoc(e.target.value)} style={inputStyle}>
              {owner && <option value="">Every venue (company wide)</option>}
              {!owner && <option value="">Pick a venue</option>}
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></label>
        )}
        {kind === 'position' && (
          <label><span style={labelStyle}>Position</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
              <option value="">Pick a position</option>
              {meta.positions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></label>
        )}
      </div>
      <label style={{ display: 'block', marginBottom: 10 }}><span style={labelStyle}>Description (optional)</span><input value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} style={inputStyle} /></label>
      {kind === 'group'
        ? <><div style={labelStyle}>Members</div><PeoplePicker call={call} picked={picked} setPicked={setPicked} /></>
        : <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Everyone {kind === 'position' ? 'in that position' : 'working there'} joins automatically, and people join and leave as they start, move or leave.</div>}
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginTop: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-acc" disabled={!name.trim()} onClick={save}>Make group</button>
        <button className="btn" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </Card>
  );
}

function GroupEditor({ call, group, toast, onBack }) {
  const [members, setMembers] = useState(null);
  const [name, setName] = useState(group.name || '');
  const [description, setDescription] = useState(group.description || '');
  const [policy, setPolicy] = useState(group.post_policy);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState([]);
  const [err, setErr] = useState('');
  const load = useCallback(async () => { const r = await call({ action: 'admin.members', conversation_id: group.id }); if (r.ok) setMembers(r.members); else { setErr(r.message); setMembers([]); } }, [call, group.id]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);
  const run = async (body, done) => { setErr(''); const r = await call({ conversation_id: group.id, ...body }); if (!r.ok) { setErr(r.message); return false; } if (done) toast(done); load(); return true; };
  const manual = group.kind === 'group';
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className="btn" onClick={onBack}>Back</button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{group.name || KIND[group.kind]}</div>
        <Badge tone="grey">{KIND[group.kind]}</Badge>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 10 }}>
        <label><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} style={inputStyle} /></label>
        <label><span style={labelStyle}>Description</span><input value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} style={inputStyle} /></label>
        {group.kind !== 'announce' && (
          <label><span style={labelStyle}>Who can post</span>
            <select value={policy} onChange={(e) => setPolicy(e.target.value)} style={inputStyle}>
              <option value="everyone">Everyone in it</option>
              <option value="admins">Admins only</option>
            </select></label>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-acc" onClick={() => run({ action: 'group.update', name, description, ...(group.kind !== 'announce' ? { post_policy: policy } : {}) }, 'Saved')}>Save</button>
        <button className="btn" onClick={() => run({ action: 'group.archive', archived: !group.archived_at }, group.archived_at ? 'Opened again' : 'Closed').then((ok) => ok && onBack())}>{group.archived_at ? 'Open again' : 'Close group'}</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={labelStyle}>Members {members ? `(${members.length})` : ''}</div>
        <div style={{ flex: 1 }} />
        {manual && <button className="btn" onClick={() => { setAdding((a) => !a); setPicked([]); }}>{adding ? 'Done adding' : 'Add people'}</button>}
      </div>
      {!manual && <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 8 }}>This group fills itself. You can choose its admins.</div>}
      {adding && (
        <div style={{ marginBottom: 14 }}>
          <PeoplePicker call={call} picked={picked} setPicked={setPicked} exclude={(members || []).map((m) => m.member_id)} />
          <button className="btn btn-acc" style={{ marginTop: 8 }} disabled={!picked.length} onClick={() => run({ action: 'members.add', member_ids: picked }, `Added ${picked.length}`).then((ok) => ok && setPicked([]))}>Add {picked.length}</button>
        </div>
      )}
      {(members || []).map((m) => (
        <div key={m.member_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>
          <span style={{ flex: 1, fontWeight: 600 }}>{m.name}</span>
          {m.role === 'admin' && <Badge tone="green">Admin</Badge>}
          <button className="btn" onClick={() => run({ action: 'members.admin', member_ids: [m.member_id], admin: m.role !== 'admin' })}>{m.role === 'admin' ? 'Not admin' : 'Make admin'}</button>
          {manual && <button className="btn" onClick={() => run({ action: 'members.remove', member_ids: [m.member_id] }, 'Removed')}>Remove</button>}
        </div>
      ))}
    </Card>
  );
}

// ── Owner and Admin only ─────────────────────────────────────────────────────
function Settings({ call, who, setWho, toast }) {
  const [s, setS] = useState(who.settings || {});
  const [err, setErr] = useState('');
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setErr('');
    const r = await call({ action: 'settings.save', settings: s });
    if (!r.ok) { setErr(r.message); return; }
    setWho({ ...who, settings: s });
    toast('Chat settings saved');
  };
  const row = (label, key, options, help) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={labelStyle}>{label}</span>
      <select value={String(s[key])} onChange={(e) => set(key, options.find((o) => String(o[0]) === e.target.value)[0])} style={inputStyle}>
        {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
      {help && <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{help}</span>}
    </label>
  );
  return (
    <Card style={{ maxWidth: 620 }}>
      {row('Who can make groups', 'groups_by', [['managers', 'Managers and owners'], ['everyone', 'Everyone']])}
      {row('Direct messages', 'dm_scope', [['company', 'Anyone in the company'], ['venue', 'Only people at the same venue'], ['off', 'Off (managers can still message staff)']])}
      {row('Word filter', 'filter_level', [['standard', 'Standard: strong swearing and slurs'], ['strict', 'Strict: mild words too'], ['custom', 'Custom: slurs and your own list only']], 'Slurs and hate words are always blocked.')}
      {row('Automatic check for hurtful messages', 'ai_check', [[true, 'On: flags bullying, harassment, threats and sexual comments for you to check'], [false, 'Off']], 'It never blocks a message. It only puts it in Reports to check.')}
      {row('Keep messages for', 'keep_years', [[1, '1 year'], [2, '2 years'], [3, '3 years']], 'The moderation log is always kept for 6 years.')}
      {row('Text message backup', 'sms_backup_urgent', [[true, 'Text urgent announcements to anyone the app could not reach'], [false, 'Off']])}
      {row('Quiet when off shift', 'quiet_off_shift', [[true, 'Yes (urgent announcements and manager mentions still come through)'], [false, 'No']])}
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
      <button className="btn btn-acc" onClick={save}>Save settings</button>
    </Card>
  );
}

function Words({ call, toast }) {
  const [block, setBlock] = useState(null);
  const [allow, setAllow] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { call({ action: 'words.get' }).then((r) => { if (r.ok) { setBlock((r.block || []).join('\n')); setAllow((r.allow || []).join('\n')); } else { setErr(r.message); setBlock(''); } }); }, [call]);
  if (block === null) return <LoadingCard />;
  const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    setErr('');
    for (const [kind, text] of [['block', block], ['allow', allow]]) {
      const r = await call({ action: 'words.save', kind, phrases: lines(text) });
      if (!r.ok) { setErr(r.message); return; }
    }
    toast('Word lists saved');
  };
  const area = { ...inputStyle, height: 220, resize: 'vertical' };
  return (
    <Card>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <label><span style={labelStyle}>Also block (one per line)</span><textarea value={block} onChange={(e) => setBlock(e.target.value)} style={area} placeholder={'secret menu\ncompetitor name'} /></label>
        <label><span style={labelStyle}>Allow (one per line)</span><textarea value={allow} onChange={(e) => setAllow(e.target.value)} style={area} placeholder={'cock (The Cock, our pub)\nfag (a fag break)'} /></label>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t3)', margin: '8px 0 12px' }}>Allow switches off a built in word for your company. It can never let a slur through.</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
      <button className="btn btn-acc" onClick={save}>Save word lists</button>
    </Card>
  );
}

function Log({ call }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { call({ action: 'log.list' }).then((r) => setRows(r.ok ? r.log : [])); }, [call]);
  if (rows === null) return <LoadingCard />;
  return (
    <Card>
      {rows.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 13 }}>Nothing logged yet.</div>}
      {rows.map((l) => (
        <div key={l.id} style={{ display: 'flex', gap: 10, padding: '8px 2px', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>
          <span style={{ width: 150, color: 'var(--t3)', flexShrink: 0 }}>{new Date(l.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span style={{ flex: 1 }}><b>{l.actor || 'Automatic check'}</b> {l.action}{l.target ? ` · ${l.target}` : ''}{l.reason ? ` · "${l.reason}"` : ''}</span>
        </div>
      ))}
    </Card>
  );
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ExportPerson({ call, toast }) {
  const [picked, setPicked] = useState([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    const r = await call({ action: 'export_person', member_id: picked[0], reason });
    if (!r.ok) { setErr(r.message); return; }
    const safe = String(r.person?.name || 'person').replace(/[^a-z0-9]+/gi, '_');
    const csv = ['when,chat,text,edited,original text,deleted,hidden'].concat((r.messages || []).map((m) =>
      [m.at, m.conversation, m.text, m.edited_at || '', m.original_text || '', m.deleted_at || '', m.hidden ? 'yes' : ''].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');
    download(`chat_${safe}.csv`, csv, 'text/csv');
    toast(`Exported ${(r.messages || []).length} messages. It is in the log.`);
  };
  return (
    <Card>
      <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 10 }}>Everything one person wrote, deleted messages included (for a subject access request or a disciplinary). The export and your reason go in the log.</div>
      <PeoplePicker call={call} picked={picked} setPicked={setPicked} single />
      <label style={{ display: 'block', margin: '10px 0' }}><span style={labelStyle}>Reason (at least 10 letters)</span><input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} style={inputStyle} /></label>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
      <button className="btn btn-acc" disabled={!picked.length || reason.trim().length < 10} onClick={go}>Export</button>
    </Card>
  );
}

function OpenDm({ call }) {
  const [dms, setDms] = useState(null);
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');
  const [msgs, setMsgs] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { call({ action: 'dm.list' }).then((r) => setDms(r.ok ? r.dms : [])); }, [call]);
  if (dms === null) return <LoadingCard />;
  const open = async () => {
    setErr('');
    const r = await call({ action: 'owner.open_dm', conversation_id: pick, reason });
    if (!r.ok) { setErr(r.message); return; }
    setMsgs(r.messages || []);
  };
  return (
    <Card>
      <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 10 }}>Direct messages are private. Open one only when you have to (a grievance, a safety worry, the law). Your reason is kept in the log for 6 years.</div>
      <label style={{ display: 'block', marginBottom: 10 }}><span style={labelStyle}>Direct message</span>
        <select value={pick} onChange={(e) => { setPick(e.target.value); setMsgs(null); }} style={inputStyle}>
          <option value="">Pick one</option>
          {dms.map((d) => <option key={d.id} value={d.id}>{(d.names || []).join(' and ')}</option>)}
        </select></label>
      <label style={{ display: 'block', marginBottom: 10 }}><span style={labelStyle}>Reason (at least 10 letters)</span><input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} style={inputStyle} /></label>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
      <button className="btn btn-acc" disabled={!pick || reason.trim().length < 10} onClick={open}>Open</button>
      {msgs && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--bdr)', paddingTop: 10 }}>
          {msgs.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 13 }}>No messages.</div>}
          {msgs.map((m) => (
            <div key={m.id} style={{ fontSize: 13, padding: '5px 0' }}>
              <span style={{ color: 'var(--t3)' }}>{new Date(m.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} </span>
              <b>{m.sender_name}: </b>{m.body || m.removed_text || ''}{m.deleted_at ? ' (deleted)' : ''}{m.status === 'hidden' ? ' (hidden)' : ''}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
