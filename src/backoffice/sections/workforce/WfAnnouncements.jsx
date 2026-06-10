// src/backoffice/sections/workforce/WfAnnouncements.jsx
//
// Workforce → Announcements. Compose a message to the team and broadcast it
// over the chosen channels (in-app + SMS), targeted at everyone, a section, or
// a role. Past announcements appear in a reverse-chronological feed below.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, inputStyle, labelStyle, groupColor, cellTint, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

const CHANNELS = [
  { key: 'inApp', lbl: 'In-app', icon: 'status' },
  { key: 'sms', lbl: 'SMS', icon: 'team' },
];

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Render the stored audience jsonb ({} = all, {sectionId} or {roleKey}) as a label.
function audienceLabel(audience, sections, roles) {
  if (!audience || !audience.kind || audience.kind === 'all') return 'All staff';
  if (audience.kind === 'section') {
    const s = (sections || []).find(x => x.id === audience.value);
    return s ? `${s.name} section` : 'Section';
  }
  if (audience.kind === 'role') {
    const r = roles?.map?.[audience.value];
    return r ? r.lbl : 'Role';
  }
  return 'All staff';
}

export default function WfAnnouncements({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [feed, setFeed] = useState([]);
  const [body, setBody] = useState('');
  const [audKind, setAudKind] = useState('all');   // all | section | role
  const [audValue, setAudValue] = useState('');
  const [channels, setChannels] = useState(['inApp']);

  const roleList = useMemo(() => roles?.list || [], [roles]);

  async function reload() {
    const rows = await wf.loadAnnouncements(ctx?.locationId);
    setFeed(rows || []);
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    wf.loadAnnouncements(ctx?.locationId)
      .then(rows => { if (live) setFeed(rows || []); })
      .catch(() => { if (live) setFeed([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ctx?.locationId]);

  function toggleChannel(key) {
    setChannels(cs => cs.includes(key) ? cs.filter(c => c !== key) : [...cs, key]);
  }

  function setAudienceKind(kind) {
    setAudKind(kind);
    if (kind === 'all') setAudValue('');
    else if (kind === 'section') setAudValue(sections?.[0]?.id || '');
    else if (kind === 'role') setAudValue(roleList[0]?.key || '');
  }

  async function send() {
    const text = body.trim();
    if (!text) { showToast('Write a message first', 'error'); return; }
    if (!channels.length) { showToast('Pick at least one channel', 'error'); return; }
    const audience = audKind === 'all' ? { kind: 'all' } : { kind: audKind, value: audValue };
    setSending(true);
    try {
      await wf.saveAnnouncement({ audience, channels, body: text }, ctx?.locationId, ctx?.orgId, ctx?.actor?.name);
      setBody('');
      await reload();
      showToast('Announcement sent', 'success');
    } catch (e) {
      showToast(e?.message || 'Could not send announcement', 'error');
      await reload();
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Composer */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <Icon name="sparkle" size={16} />
          <div style={{ fontSize: 15, fontWeight: 700 }}>New announcement</div>
        </div>

        <label style={labelStyle}>Message</label>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Share an update with the team — shift changes, reminders, kudos…"
          rows={4}
          style={{ ...inputStyle, height: 'auto', minHeight: 96, padding: '10px 12px', resize: 'vertical', lineHeight: 1.5 }}
        />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 14 }}>
          <div style={{ flex: '1 1 200px', minWidth: 180 }}>
            <label style={labelStyle}>Audience</label>
            <select value={audKind} onChange={e => setAudienceKind(e.target.value)} style={inputStyle}>
              <option value="all">All staff</option>
              <option value="section">By section</option>
              <option value="role">By role</option>
            </select>
          </div>
          {audKind === 'section' && (
            <div style={{ flex: '1 1 200px', minWidth: 180 }}>
              <label style={labelStyle}>Section</label>
              <select value={audValue} onChange={e => setAudValue(e.target.value)} style={inputStyle}>
                {(sections || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {audKind === 'role' && (
            <div style={{ flex: '1 1 200px', minWidth: 180 }}>
              <label style={labelStyle}>Role</label>
              <select value={audValue} onChange={e => setAudValue(e.target.value)} style={inputStyle}>
                {roleList.map(r => <option key={r.key} value={r.key}>{r.lbl}</option>)}
              </select>
            </div>
          )}
          <div style={{ flex: '1 1 200px', minWidth: 180 }}>
            <label style={labelStyle}>Channels</label>
            <div style={{ display: 'flex', gap: 8, height: 42, alignItems: 'center' }}>
              {CHANNELS.map(c => {
                const on = channels.includes(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={on ? 'btn btn-acc btn-sm' : 'btn btn-ghost btn-sm'}
                    onClick={() => toggleChannel(c.key)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <Icon name={on ? 'check' : c.icon} size={13} />{c.lbl}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5 }}>
              In-app = the staff <b>Time Clock</b>: the latest messages (last 14 days) show whenever someone enters their PIN. SMS texts everyone in the audience with a mobile on file.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-acc" onClick={send} disabled={sending || !body.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="status" size={14} />{sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </Card>

      {/* Feed */}
      {loading ? (
        <LoadingCard label="Loading announcements…" />
      ) : feed.length === 0 ? (
        <EmptyState
          icon="status"
          title="No announcements yet"
          body="Send your first message above. Posts appear here for the whole team, in-app and by SMS if you choose."
        />
      ) : (
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--t2)' }}>Recent</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {feed.map(a => {
              const author = a.authorName || 'Team';
              return (
                <div key={a.id} style={{ display: 'flex', gap: 12, padding: 14, borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
                  <div style={{ flexShrink: 0, width: 36, height: 36, borderRadius: '50%', background: cellTint(groupColor('mgmt'), 16), border: `1px solid ${cellTint(groupColor('mgmt'), 30)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>
                    {initials(author)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{author}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>{timeAgo(a.sentAt || a.createdAt)}</span>
                      <Badge tone="grey">{audienceLabel(a.audience, sections, roles)}</Badge>
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--t1)', lineHeight: 1.55, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.body}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      {(a.channels || []).map(ch => {
                        const def = CHANNELS.find(c => c.key === ch);
                        return <Badge key={ch} tone="blue">{def ? def.lbl : ch}</Badge>;
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
