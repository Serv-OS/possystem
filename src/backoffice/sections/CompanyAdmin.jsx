import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { CURRENCIES } from '../../lib/currency';

const S = {
  page: { padding: '32px 40px', maxWidth: 860 },
  h1: { fontFamily: 'inherit', fontSize: 22, fontWeight: 800, marginBottom: 4, color: 'var(--t1)' },
  sub: { fontSize: 13, color: 'var(--t3)', marginBottom: 32 },
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 24, marginBottom: 20 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: 600, color: 'var(--t3)', marginBottom: 4, display: 'block' },
  input: {
    width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--bdr)',
    background: 'var(--bg)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  btn: {
    padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
    fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
  },
  btnPrimary: { background: 'var(--acc)', color: '#fff' },
  btnGhost: { background: 'var(--bg3)', color: 'var(--t2)', border: '1px solid var(--bdr)' },
  badge: { padding: '3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--bdr)', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' },
  td: { padding: '12px 12px', borderBottom: '1px solid var(--bdr)', color: 'var(--t2)' },
};

export default function CompanyAdmin() {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('orgs'); // orgs | new-org | new-location | invite
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [locations, setLocations] = useState([]);
  const [form, setForm] = useState({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => { loadOrgs(); }, []);

  const loadOrgs = async () => {
    setLoading(true);
    const { data } = await supabase.from('organisations').select('*').order('created_at');
    setOrgs(data || []);
    setLoading(false);
  };

  const loadLocations = async (orgId) => {
    const { data } = await supabase.from('locations').select('*').eq('org_id', orgId).order('created_at');
    setLocations(data || []);
  };

  const selectOrg = async (org) => {
    setSelectedOrg(org);
    await loadLocations(org.id);
    setTab('org-detail');
  };

  const createOrg = async () => {
    if (!form.name?.trim()) return setError('Organisation name is required');
    setWorking(true); setError('');
    const slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { data, error: err } = await supabase.from('organisations').insert({
      name: form.name.trim(), slug: form.slug?.trim() || slug, status: 'active',
    }).select().single();
    if (err) { setWorking(false); return setError(err.message); }

    // v5.5.305: link the creating user to this org if they have none yet.
    // Without this, an owner who creates their company is never associated
    // with it (user_profiles.org_id stays null) → "no company assigned"
    // after sign-out. Only set it when empty so we never relocate an
    // existing multi-org user.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from('user_profiles').select('org_id').eq('id', user.id).single();
        if (!profile?.org_id) {
          await supabase.from('user_profiles').update({ org_id: data.id }).eq('id', user.id);
        }
      }
    } catch (e) { console.warn('[CompanyAdmin] link user to org failed:', e?.message); }

    setWorking(false);
    setSuccess(`✓ "${data.name}" created`);
    setForm({});
    await loadOrgs();
    await selectOrg(data);
  };

  const createLocation = async () => {
    if (!form.locName?.trim()) return setError('Location name is required');
    setWorking(true); setError('');
    const { data: loc, error: err } = await supabase.from('locations').insert({
      org_id: selectedOrg.id,
      name: form.locName.trim(),
      address: form.locAddress?.trim() || '',
      timezone: form.locTz || 'Europe/London',
      currency: form.locCurrency || 'GBP',
      status: 'active',
    }).select().single();
    if (err) { setWorking(false); return setError(err.message); }

    // v5.5.310: mirror the new location into the Platform DB (company + location)
    // so loyalty, gift cards, online ordering, QR, Challenge 21, message
    // templates and location settings can resolve its company. Without this the
    // location errors with "No platform row found for ops location ...".
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/provision-location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ ops_location_id: loc.id }),
      });
      const pr = await resp.json().catch(() => ({}));
      if (!resp.ok) console.warn('[CompanyAdmin] provision-location failed:', pr?.error);
    } catch (pe) { console.warn('[CompanyAdmin] provision-location threw:', pe?.message); }

    // If the current user has no location/org assigned yet, assign them to this
    // new location + its org. v5.5.305: also backfill org_id (was previously
    // only setting location_id, leaving the user with "no company assigned")
    // and create a user_locations row so access resolves via the junction.
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from('user_profiles').select('location_id, org_id').eq('id', user.id).single();
      const patch = {};
      if (!profile?.location_id) patch.location_id = loc.id;
      if (!profile?.org_id) patch.org_id = selectedOrg.id;
      if (Object.keys(patch).length) {
        await supabase.from('user_profiles').update(patch).eq('id', user.id);
      }
      await supabase.from('user_locations')
        .upsert({ user_id: user.id, location_id: loc.id, role: 'owner' }, { onConflict: 'user_id,location_id' });
    }

    // Create a subscription row for this location
    await supabase.from('subscriptions').insert({
      org_id: selectedOrg.id, location_id: loc.id,
      plan: 'free', gmv_this_month: 0, billing_period_start: new Date().toISOString().slice(0,10),
    });

    setWorking(false);
    setSuccess(`✓ Location "${loc.name}" created`);
    setForm(f => ({ ...f, locName: '', locAddress: '' }));
    await loadLocations(selectedOrg.id);
    setTab('org-detail');
  };

  const inviteOwner = async () => {
    if (!form.inviteEmail?.trim()) return setError('Email is required');
    setWorking(true); setError('');
    // Create auth user via Supabase admin invite
    const { error: err } = await supabase.auth.admin?.inviteUserByEmail(form.inviteEmail.trim(), {
      data: { role: 'owner', org_id: selectedOrg.id, full_name: form.inviteName || '' }
    });
    // Note: admin.inviteUserByEmail requires service_role key — for now we'll just note this
    // and handle via Supabase dashboard or a Supabase Edge Function
    setWorking(false);
    if (err) {
      // Fallback: show what to do manually
      setError(`To invite ${form.inviteEmail}: go to Supabase → Auth → Users → Send invitation. ` +
        `Then update their user_profiles row: org_id=${selectedOrg.id}, role=owner`);
      return;
    }
    setSuccess(`✓ Invitation sent to ${form.inviteEmail}`);
    setForm(f => ({ ...f, inviteEmail: '', inviteName: '' }));
  };

  const f = (key, val) => setForm(p => ({ ...p, [key]: val }));

  return (
    <div style={S.page}>
      <div style={S.h1}>🔐 Company Admin</div>
      <div style={S.sub}>Internal tool — create and manage restaurant organisations</div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {[
          { id: 'orgs', label: 'All organisations' },
          { id: 'new-org', label: '+ New organisation' },
        ].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setError(''); setSuccess(''); }}
            style={{ ...S.btn, ...(tab === t.id ? S.btnPrimary : S.btnGhost) }}>
            {t.label}
          </button>
        ))}
        {selectedOrg && (
          <button onClick={() => setTab('org-detail')}
            style={{ ...S.btn, ...(tab === 'org-detail' || tab === 'new-location' || tab === 'invite' ? S.btnPrimary : S.btnGhost) }}>
            {selectedOrg.name}
          </button>
        )}
      </div>

      {error && <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: 13, marginBottom: 16 }}>{error}</div>}
      {success && <div style={{ padding: '10px 14px', borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', fontSize: 13, marginBottom: 16 }}>{success}</div>}

      {/* ── All orgs ── */}
      {tab === 'orgs' && (
        <div style={S.card}>
          <div style={S.cardTitle}>🏢 Organisations ({orgs.length})</div>
          {loading ? <div style={{ color: 'var(--t3)', fontSize: 13 }}>Loading…</div> : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Slug</th>
                  <th style={S.th}>Status</th>
                  <th style={S.th}>Created</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {orgs.map(org => (
                  <tr key={org.id}>
                    <td style={{ ...S.td, fontWeight: 600, color: 'var(--t1)' }}>{org.name}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12 }}>{org.slug}</td>
                    <td style={S.td}>
                      <span style={{ ...S.badge, background: org.status === 'active' ? '#dcfce7' : '#fee2e2', color: org.status === 'active' ? '#166534' : '#991b1b' }}>
                        {org.status}
                      </span>
                    </td>
                    <td style={{ ...S.td, color: 'var(--t3)' }}>{new Date(org.created_at).toLocaleDateString('en-GB')}</td>
                    <td style={S.td}>
                      <button onClick={() => selectOrg(org)} style={{ ...S.btn, ...S.btnGhost, padding: '5px 12px' }}>Manage →</button>
                    </td>
                  </tr>
                ))}
                {orgs.length === 0 && <tr><td colSpan={5} style={{ ...S.td, color: 'var(--t3)', textAlign: 'center', padding: 32 }}>No organisations yet — create one to get started</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── New org ── */}
      {tab === 'new-org' && (
        <div style={S.card}>
          <div style={S.cardTitle}>🏢 Create new organisation</div>
          <div style={S.row}>
            <div>
              <label style={S.label}>Restaurant / company name *</label>
              <input style={S.input} placeholder="e.g. Dougboy Donuts" value={form.name || ''} onChange={e => f('name', e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Slug (auto-generated)</label>
              <input style={S.input} placeholder="dougboy-donuts" value={form.slug || ''} onChange={e => f('slug', e.target.value)} />
            </div>
          </div>
          <button onClick={createOrg} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>
            {working ? 'Creating…' : 'Create organisation →'}
          </button>
        </div>
      )}

      {/* ── Org detail ── */}
      {tab === 'org-detail' && selectedOrg && (
        <>
          <div style={S.card}>
            <div style={S.cardTitle}>🏢 {selectedOrg.name}
              <span style={{ ...S.badge, background: '#dcfce7', color: '#166534', marginLeft: 8 }}>{selectedOrg.status}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 20, fontFamily: 'monospace' }}>ID: {selectedOrg.id}</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
              <button onClick={() => { setTab('new-location'); setError(''); setSuccess(''); }} style={{ ...S.btn, ...S.btnPrimary }}>+ Add location</button>
              <button onClick={() => { setTab('invite'); setError(''); setSuccess(''); }} style={{ ...S.btn, ...S.btnGhost }}>✉ Invite owner</button>
            </div>

            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 12 }}>📍 Locations ({locations.length})</div>
            {locations.length === 0
              ? <div style={{ color: 'var(--t3)', fontSize: 13, padding: '20px 0' }}>No locations yet — add the first one above</div>
              : (
                <table style={S.table}>
                  <thead><tr>
                    <th style={S.th}>Location</th>
                    <th style={S.th}>Address</th>
                    <th style={S.th}>Timezone</th>
                    <th style={S.th}>Currency</th>
                    <th style={S.th}>Status</th>
                  </tr></thead>
                  <tbody>
                    {locations.map(loc => (
                      <tr key={loc.id}>
                        <td style={{ ...S.td, fontWeight: 600, color: 'var(--t1)' }}>{loc.name}</td>
                        <td style={{ ...S.td, color: 'var(--t3)' }}>{loc.address || '—'}</td>
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12 }}>{loc.timezone}</td>
                        <td style={{ ...S.td }}>{loc.currency}</td>
                        <td style={S.td}>
                          <span style={{ ...S.badge, background: '#dcfce7', color: '#166534' }}>{loc.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </>
      )}

      {/* ── New location ── */}
      {tab === 'new-location' && selectedOrg && (
        <div style={S.card}>
          <div style={S.cardTitle}>📍 Add location to {selectedOrg.name}</div>
          <div style={S.row}>
            <div>
              <label style={S.label}>Location name *</label>
              <input style={S.input} placeholder="e.g. Oxford Street" value={form.locName || ''} onChange={e => f('locName', e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Address</label>
              <input style={S.input} placeholder="123 Oxford St, London" value={form.locAddress || ''} onChange={e => f('locAddress', e.target.value)} />
            </div>
          </div>
          <div style={S.row}>
            <div>
              <label style={S.label}>Timezone</label>
              <select style={S.input} value={form.locTz || 'Europe/London'} onChange={e => f('locTz', e.target.value)}>
                <option value="Europe/London">Europe/London (GMT/BST)</option>
                <option value="Europe/Paris">Europe/Paris (CET)</option>
                <option value="America/New_York">America/New_York (EST)</option>
                <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
                <option value="Asia/Dubai">Asia/Dubai (GST)</option>
              </select>
            </div>
            <div>
              <label style={S.label}>Currency</label>
              <select style={S.input} value={form.locCurrency || 'GBP'} onChange={e => f('locCurrency', e.target.value)}>
                {Object.values(CURRENCIES).map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createLocation} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>
              {working ? 'Creating…' : 'Create location →'}
            </button>
            <button onClick={() => setTab('org-detail')} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Invite owner ── */}
      {tab === 'invite' && selectedOrg && (
        <div style={S.card}>
          <div style={S.cardTitle}>✉ Invite owner to {selectedOrg.name}</div>
          <p style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 20 }}>
            The owner will receive an email with a link to set their password and access the back office.
          </p>
          <div style={S.row}>
            <div>
              <label style={S.label}>Owner's email *</label>
              <input type="email" style={S.input} placeholder="owner@restaurant.com" value={form.inviteEmail || ''} onChange={e => f('inviteEmail', e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Full name</label>
              <input style={S.input} placeholder="Sarah Smith" value={form.inviteName || ''} onChange={e => f('inviteName', e.target.value)} />
            </div>
          </div>
          <div style={{ padding: '12px 16px', borderRadius: 8, background: 'var(--acc-d)', border: '1px solid var(--acc-b)', fontSize: 12, color: 'var(--t2)', marginBottom: 16 }}>
            ⚠️ <strong>Note:</strong> Sending invitations requires a Supabase service role key (not safe to put in the browser). 
            Until we add a backend Edge Function, invite users directly via <strong>Supabase → Authentication → Users → Send invitation</strong>, 
            then update their <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>user_profiles</code> row to set <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>org_id = {selectedOrg.id}</code> and <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>role = owner</code>.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={inviteOwner} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>
              {working ? 'Sending…' : '✉ Send invitation'}
            </button>
            <button onClick={() => setTab('org-detail')} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
