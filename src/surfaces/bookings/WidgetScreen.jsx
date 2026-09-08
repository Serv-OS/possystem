// src/surfaces/bookings/WidgetScreen.jsx
//
// Widget — the embed reference for THIS venue. Three jobs: (1) the two live
// controls the widget obeys (on/off + how far ahead it sells), writing through
// updateBookingRules exactly like RulesScreen; (2) the public /book URL and
// the website embed snippet, tap-to-copy, plus a LIVE preview iframe of the
// real page; (3) the field → CRM mapping — internal documentation rendered as
// UI, so a host can answer "what happens to what the guest types".
//
// The slug lookup mirrors Back Office → Channels → Table bookings (which
// mirrors OnlineOrdering.jsx): platform DB `locations` row via ops_location_id
// (fallback: id) → online_slug → https://<slug>.<CUSTOMER_ROOT>/book. Kept as
// a local helper rather than importing BO code — the host stand bundle should
// not pull Back Office sections.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { getLocationId, platformSupabase } from '../../lib/supabase';
import { CUSTOMER_ROOT } from '../../lib/env';
import { mono, tintBg, tintBd, Chip, Stepper, ToggleRow } from './bits.jsx';

// Migration 20260811b column defaults — shown until a rules row exists.
const DEFAULT_WIDGET = { widgetEnabled: true, widgetMaxDaysAhead: 90 };

async function lookupVenueSlug() {
  try {
    const opsLocId = await getLocationId().catch(() => null);
    if (!opsLocId || !platformSupabase) return null;
    const select = 'id, online_slug';
    let r = (await platformSupabase.from('locations').select(select).eq('ops_location_id', opsLocId).maybeSingle()).data;
    if (!r) r = (await platformSupabase.from('locations').select(select).eq('id', opsLocId).maybeSingle()).data;
    return r?.online_slug || null;
  } catch { return null; }
}

// What each /book field becomes — the unified-CRM story, one card per field.
const CRM_MAP = [
  ['Name', 'matched on phone before a new guest profile is made'],
  ['Mobile', 'the match key across POS, bookings and marketing'],
  ['Email', 'stored with consent timestamp and source'],
  ['Dietary & allergens', 'surfaces on the POS check and the kitchen ticket'],
  ['Occasion', 'becomes the booking note — printed at the host stand and on the KDS'],
  ['Marketing consent', 'the only field that unlocks campaigns'],
];

const label = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--t3)' };
const panel = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: '14px 18px' };
const monoBox = {
  flex: '1 1 220px', minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--t1)',
  background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px',
  cursor: 'pointer', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

// The iOS shell (RposIOS user agent) sends every off-host FRAME load to Safari,
// so mounting the preview iframe inside the app rips the user out to the /book
// page on launch (all screens mount at boot — Pane only hides). In the shell we
// swap the preview for the copyable link; everywhere else the iframe mounts only
// while this screen is actually on show.
const IN_IOS_SHELL = typeof navigator !== 'undefined' && /RposIOS/.test(navigator.userAgent);

export default function WidgetScreen({ show = true }) {
  const bookingRules = useStore((s) => s.bookingRules);
  const updateBookingRules = useStore((s) => s.updateBookingRules);
  const currentLocationId = useStore((s) => s.currentLocationId);

  const widgetEnabled = bookingRules?.widgetEnabled ?? DEFAULT_WIDGET.widgetEnabled;
  const maxDays = bookingRules?.widgetMaxDaysAhead ?? DEFAULT_WIDGET.widgetMaxDaysAhead;

  // ── venue slug → public /book URL ───────────────────────────────────────────
  const [slug, setSlug] = useState(null);
  const [slugReady, setSlugReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setSlugReady(false);
    lookupVenueSlug().then((s) => { if (alive) { setSlug(s); setSlugReady(true); } });
    return () => { alive = false; };
  }, [currentLocationId]);

  const bookUrl = slug ? `https://${slug}.${CUSTOMER_ROOT}/book` : null;
  const embed = bookUrl
    ? `<iframe src="${bookUrl}" style="width:100%;max-width:560px;height:820px;border:0;border-radius:16px" title="Book a table" loading="lazy"></iframe>`
    : '';

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const copy = async (text, setFlag) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlag(true); setTimeout(() => setFlag(false), 1800);
    } catch { /* clipboard blocked — the text is shown for manual copy */ }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {/* ── controls + link + live preview ── */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px', minWidth: 300, maxWidth: 470 }}>
            <div style={panel}>
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>Booking widget</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8, lineHeight: 1.4 }}>
                The customer-facing /book page — the same optimiser and pacing rules as this host stand, sold from the venue website. Live — no save step.
              </div>
              <ToggleRow
                label="Sell bookings online"
                sub="Off takes the public booking page down immediately; the host stand keeps working."
                on={widgetEnabled}
                onToggle={() => updateBookingRules?.({ widgetEnabled: !widgetEnabled })}
              />
              <Stepper
                label="Book up to"
                sub="How far ahead the widget offers dates."
                value={maxDays}
                onChange={(v) => updateBookingRules?.({ widgetMaxDaysAhead: v })}
                step={7} min={7} max={365}
                fmt={(v) => `${v} days`}
              />
            </div>

            <div style={{ ...panel, marginTop: 12 }}>
              {bookUrl ? (
                <>
                  <div style={label}>Public booking URL</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 8, flexWrap: 'wrap' }}>
                    <button style={monoBox} title="Tap to copy" onClick={() => copy(bookUrl, setCopiedUrl)}>{bookUrl}</button>
                    <Chip onClick={() => copy(bookUrl, setCopiedUrl)} style={{ alignSelf: 'center' }}>
                      {copiedUrl ? 'Copied ✓' : 'Copy'}
                    </Chip>
                  </div>
                  <div style={{ ...label, marginTop: 16 }}>Website embed</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 8, flexWrap: 'wrap' }}>
                    <button
                      style={{ ...monoBox, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 }}
                      title="Tap to copy" onClick={() => copy(embed, setCopiedEmbed)}
                    >{embed}</button>
                    <Chip onClick={() => copy(embed, setCopiedEmbed)} style={{ alignSelf: 'center' }}>
                      {copiedEmbed ? 'Copied ✓' : 'Copy'}
                    </Chip>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
                    Paste this into the venue website; bookings land straight in this diary, and slots at the kitchen's pacing cap are never sold online.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
                  {slugReady
                    ? <>No venue slug yet — set one in <b>Back Office → Settings → Location settings</b> to get the public link, the website embed and the live preview here.</>
                    : 'Looking up the venue slug…'}
                </div>
              )}
            </div>

            <div style={{
              marginTop: 12, padding: '12px 14px', borderRadius: 12,
              background: tintBg('var(--blu)', 8), border: `1px solid ${tintBd('var(--blu)')}`,
              fontSize: 11, color: 'var(--blu)', lineHeight: 1.5,
            }}>
              <span style={{ fontWeight: 700 }}>Shared with Back Office.</span>{' '}
              <span style={{ color: 'var(--t2)' }}>
                Channels → Table bookings edits the same two controls — change them in either place, both react live.
              </span>
            </div>
            {!bookingRules && (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t4)', ...mono }}>
                Showing defaults — no rules saved for this venue yet. The first change writes them.
              </div>
            )}
          </div>

          {/* live preview of the real /book page — never inside the iOS shell */}
          {bookUrl && !IN_IOS_SHELL && (
            <div style={{ flex: '0 1 560px', minWidth: 320 }}>
              <div style={{ ...label, marginBottom: 8 }}>Live preview</div>
              {show && (
                <iframe
                  src={bookUrl}
                  title="Booking widget preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  style={{
                    width: 560, maxWidth: '100%', height: 640, display: 'block',
                    border: '1px solid var(--bdr)', borderRadius: 16, background: 'var(--bg1)',
                  }}
                />
              )}
              <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>
                The real page, live — what a guest sees right now, obeying this venue's rules and pacing.
                {!widgetEnabled && ' Selling is OFF, so guests currently see the closed notice.'}
              </div>
            </div>
          )}
          {bookUrl && IN_IOS_SHELL && (
            <div style={{ flex: '0 1 560px', minWidth: 320 }}>
              <div style={{ ...label, marginBottom: 8 }}>Preview</div>
              <div style={{ padding: 16, borderRadius: 14, border: '1px dashed var(--bdr2)', fontSize: 12, color: 'var(--t3)', lineHeight: 1.6 }}>
                The live preview opens in Safari on this device. Tap the booking link above to see exactly what a guest sees.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── right rail: field → CRM mapping (internal documentation as UI) ── */}
      <div style={{ width: 340, flexShrink: 0, background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', overflowY: 'auto', padding: 16 }}>
        <div style={label}>What the guest gives you</div>
        <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.55, margin: '4px 0 14px' }}>
          Captured once on the /book page and reused everywhere — no re-keying at the host stand.
        </div>
        {CRM_MAP.map(([field, dest]) => (
          <div key={field} style={{ padding: '11px 13px', borderRadius: 11, background: 'var(--bg2)', border: '1px solid var(--bdr)', marginBottom: 7 }}>
            <div style={{ fontSize: 12, fontWeight: 800 }}>{field}</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5, marginTop: 2, ...mono }}>{dest}</div>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--t4)', lineHeight: 1.55, marginTop: 12 }}>
          One guest record per person: the booking, the POS check and any campaign all point at the same profile, so spend, allergens and no-shows never split across systems.
        </div>
      </div>
    </div>
  );
}
