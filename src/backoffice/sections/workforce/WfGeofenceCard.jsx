// src/backoffice/sections/workforce/WfGeofenceCard.jsx
//
// Mobile clock-in geofence — the venue pin, the radius, and the on switch.
// Back Office → Workforce → Settings.
//
// HARD BLOCK (Peter's decision, 31 Aug 2026): outside the radius the staff app
// refuses the punch. This screen only sets the fence; the SERVER is the judge,
// so nothing here is ever sent to a phone to be trusted.
//
// The pin is set by STANDING AT THE VENUE and pressing "Use my location". Venue
// addresses in this database are too rough to geocode for a hard block
// ("123 Not sure yet"), so the operator's own position is the reliable source.

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Card, inputStyle, labelStyle } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; OpenStreetMap';
// Leaflet's default marker images 404 under Vite, so draw our own (same approach
// as GroupOrderSurface).
const venuePin = () => L.divIcon({
  className: '',
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#15C26A;'
      + 'border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
  iconSize: [18, 18], iconAnchor: [9, 9],
});

export default function WfGeofenceCard({ ctx, geofence, showToast, onSaved }) {
  const g = geofence || {};
  const [enabled, setEnabled]   = useState(!!g.enabled);
  const [lat, setLat]           = useState(g.lat ?? null);
  const [lng, setLng]           = useState(g.lng ?? null);
  const [radius, setRadius]     = useState(g.radius_m ?? 150);
  const [posLogin, setPosLogin] = useState(!!g.pos_login_clock_in);
  const [saving, setSaving]     = useState(false);
  const [locating, setLocating] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // The parent loads venue settings ASYNCHRONOUSLY and first renders this card
  // with an empty object. useState only reads its initial value once, so
  // without this the saved fence stayed invisible and the screen looked like it
  // had reset itself (it had not — the row was in the database all along).
  // Re-sync whenever a genuinely different saved fence arrives, but never while
  // the operator is mid-edit, which would yank the pin out from under them.
  const savedSig = JSON.stringify([g.enabled, g.lat, g.lng, g.radius_m, g.pos_login_clock_in]);
  const appliedSig = useRef(savedSig);
  useEffect(() => {
    if (appliedSig.current === savedSig) return;
    appliedSig.current = savedSig;
    setEnabled(!!g.enabled);
    setLat(g.lat ?? null);
    setLng(g.lng ?? null);
    setRadius(g.radius_m ?? 150);
    setPosLogin(!!g.pos_login_clock_in);
  }, [savedSig, g.enabled, g.lat, g.lng, g.radius_m, g.pos_login_clock_in]);

  const mapEl   = useRef(null);
  const mapRef  = useRef(null);
  const markRef = useRef(null);
  const circRef = useRef(null);

  // Build the map once the element exists AND we have a pin to show.
  useEffect(() => {
    if (!mapEl.current || mapRef.current || lat == null || lng == null) return;
    const map = L.map(mapEl.current, { attributionControl: false }).setView([lat, lng], 17);
    L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
    markRef.current = L.marker([lat, lng], { draggable: true, icon: venuePin() }).addTo(map);
    circRef.current = L.circle([lat, lng], { radius, color: '#15C26A', fillColor: '#15C26A', fillOpacity: 0.13, weight: 2 }).addTo(map);
    markRef.current.on('dragend', () => {
      const p = markRef.current.getLatLng();
      setLat(Number(p.lat.toFixed(6))); setLng(Number(p.lng.toFixed(6)));
    });
    mapRef.current = map;
    // Leaflet mis-sizes inside a tab that was hidden at mount.
    setTimeout(() => map.invalidateSize(), 60);
    return () => { map.remove(); mapRef.current = null; };
  }, [lat, lng, radius]);

  // Keep marker + circle following the numbers.
  useEffect(() => {
    if (!mapRef.current || lat == null || lng == null) return;
    markRef.current?.setLatLng([lat, lng]);
    circRef.current?.setLatLng([lat, lng]);
    mapRef.current.setView([lat, lng]);
  }, [lat, lng]);
  useEffect(() => { circRef.current?.setRadius(radius); }, [radius]);

  const useMyLocation = () => {
    if (!navigator.geolocation) { showToast('This browser cannot read your location', 'error'); return; }
    setLocating(true); setTestResult(null);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLat(Number(pos.coords.latitude.toFixed(6)));
        setLng(Number(pos.coords.longitude.toFixed(6)));
        setLocating(false);
        showToast(`Pinned here, accurate to about ${Math.round(pos.coords.accuracy)}m`, 'success');
      },
      err => {
        setLocating(false);
        showToast(err.code === 1 ? 'Location permission was refused' : 'Could not get your location', 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  // Walk-away test: am I inside the fence from where I am standing right now?
  const testFromHere = () => {
    if (lat == null) { showToast('Pin the venue first', 'error'); return; }
    if (!navigator.geolocation) { showToast('This browser cannot read your location', 'error'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        const d = wf.metresBetween(pos.coords.latitude, pos.coords.longitude, lat, lng);
        setTestResult({ distance: d, inside: d <= radius, accuracy: Math.round(pos.coords.accuracy) });
        setLocating(false);
      },
      () => { setLocating(false); showToast('Could not get your location', 'error'); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await wf.saveClockGeofence(
        { enabled, lat, lng, radius_m: radius, accuracy_ceiling_m: g.accuracy_ceiling_m ?? 100,
          pos_login_clock_in: posLogin },
        ctx.locationId, ctx.orgId,
      );
      onSaved?.(saved);
      showToast('Clock-in fence saved', 'success');
    } catch (e) {
      showToast(e.message || 'Could not save the fence', 'error');
    } finally { setSaving(false); }
  };

  const pinned = lat != null && lng != null;

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Clock in from a phone</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
            Staff can only clock in when they are at the venue
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>Allow clocking in from the staff app</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
              Off means only a device inside the venue can clock staff in. Staff can always use an
              in-venue device, so nobody is ever unable to start a shift.
            </span>
          </span>
        </label>

        <div>
          <div style={labelStyle}>Where the venue is</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <button className="btn btn-acc" onClick={useMyLocation} disabled={locating}>
              {locating ? 'Finding you…' : pinned ? 'Move pin to where I am' : 'Use my location'}
            </button>
            {pinned && (
              <button className="btn btn-ghost" onClick={testFromHere} disabled={locating}>
                Test from where I am
              </button>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>
            Stand at the staff entrance and press <b>Use my location</b>. You can drag the pin to adjust.
          </div>
        </div>

        {testResult && (
          <div style={{
            padding: '10px 12px', borderRadius: 10, fontSize: 13,
            background: testResult.inside ? 'var(--grn-d, rgba(21,194,106,.12))' : 'var(--orn-d, rgba(232,160,32,.12))',
            border: `1px solid ${testResult.inside ? 'var(--grn, #15C26A)' : 'var(--orn, #E8A020)'}`,
            color: 'var(--t1)',
          }}>
            You are <b>{testResult.distance}m</b> from the pin.{' '}
            {testResult.inside
              ? 'A staff member here COULD clock in.'
              : 'A staff member here would be REFUSED.'}
            <span style={{ color: 'var(--t3)' }}> (reading accurate to about {testResult.accuracy}m)</span>
          </div>
        )}

        {pinned ? (
          <div ref={mapEl} style={{ height: 260, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--bdr)' }} />
        ) : (
          <div style={{
            height: 120, borderRadius: 12, border: '1px dashed var(--bdr2)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: 'var(--t3)', fontSize: 13, textAlign: 'center', padding: 16,
          }}>
            No pin yet. Press <b style={{ margin: '0 4px' }}>Use my location</b> while you are at the venue.
          </div>
        )}

        <div>
          <div style={labelStyle}>How far from the pin still counts as at work</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            <input type="range" min="50" max="500" step="10" value={radius}
              onChange={e => setRadius(Number(e.target.value))} style={{ flex: 1 }} />
            <input type="number" min="50" max="2000" value={radius}
              onChange={e => setRadius(Math.min(2000, Math.max(50, Number(e.target.value) || 150)))}
              style={{ ...inputStyle, width: 90 }} />
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>metres</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>
            The green circle is what counts as at work. Check it covers your staff entrance but not
            the pub next door. 150m is a sensible start.
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                        borderTop: '1px solid var(--bdr)', paddingTop: 14 }}>
          <input type="checkbox" checked={posLogin} onChange={e => setPosLogin(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>Offer to start a shift when staff sign in to a till</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
              The first time someone signs in to the POS each day, it asks &ldquo;Start your shift?&rdquo;.
              It asks rather than clocking silently, so a manager stepping on the till for a minute
              does not open a shift they never meant to start. No location check is needed: the till
              is already in the venue. Kitchen staff who never touch a till still use the app or the
              clock screen.
            </span>
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-acc" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save fence'}
          </button>
        </div>
      </div>
    </Card>
  );
}
