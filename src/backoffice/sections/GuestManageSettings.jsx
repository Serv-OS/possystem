// src/backoffice/sections/GuestManageSettings.jsx
//
// Back Office, Channels, Table bookings: "Guest messages and online changes" (16 Oct 2026).
// The venue's switches for the guest's own change and cancel link and the booking texts and
// emails, the cancellation window (now real: online changes close that many hours before the
// booking), and the phone number guests are told to call.
//
// The window is a booking_rules column the store already saves (cancellationWindowHours). The
// three new columns (guest_manage_enabled, guest_messages_enabled, guest_phone, migration
// 20261016c) are read and written here directly, so the store and its other screens are not
// touched. Before that migration the card says so in words and the switches wait.
//
// TableBookings.jsx passes its own BoStepper, BoToggle and styles so the card looks the same.

import { useEffect, useState } from 'react';
import { supabase, isMock, getLocationId, getActiveLocationSync } from '../../lib/supabase';

const missingColumn = (e) => /42703|PGRST204|does not exist|schema cache/i.test(`${e?.code || ''} ${e?.message || ''}`);

export default function GuestManageSettings({ rules, patch, ui, showToast }) {
  const { Stepper, Toggle, S } = ui;
  // extra: null = loading, { missing: true } = before the migration, else the three values.
  const [extra, setExtra] = useState(null);
  const [phone, setPhone] = useState(null);   // the typed value; null = not touched

  useEffect(() => {
    let alive = true;
    (async () => {
      if (isMock || !supabase) { if (alive) setExtra({ manage: true, messages: true, phone: '' }); return; }
      const loc = getActiveLocationSync() || await getLocationId().catch(() => null);
      if (!loc) { if (alive) setExtra({ error: 'No venue selected.' }); return; }
      const { data, error } = await supabase.from('booking_rules')
        .select('guest_manage_enabled, guest_messages_enabled, guest_phone').eq('location_id', loc).maybeSingle();
      if (!alive) return;
      if (error) { setExtra(missingColumn(error) ? { missing: true, loc } : { error: error.message, loc }); return; }
      setExtra({ loc, manage: data?.guest_manage_enabled !== false, messages: data?.guest_messages_enabled !== false, phone: data?.guest_phone || '' });
    })();
    return () => { alive = false; };
  }, []);

  const save = async (col, value, words) => {
    if (!extra?.loc || extra.missing) return;
    const { error } = await supabase.from('booking_rules').upsert({ location_id: extra.loc, [col]: value }, { onConflict: 'location_id' });
    if (error) { showToast?.(`Not saved: ${error.message}`, 'error'); return false; }
    if (words) showToast?.(words, 'success');
    return true;
  };

  const ready = extra && !extra.missing && !extra.error;
  const phoneValue = phone !== null ? phone : (extra?.phone || '');
  const windowHours = Number(rules.cancellationWindowHours) || 0;

  return (
    <div style={{ ...S.section, marginTop: 14 }}>
      <div style={S.lbl}>Guest messages and online changes</div>
      <div style={S.hint}>
        Every booking with a phone or email gets a confirmation, a reminder the day before and 2 hours before, and a message when it is changed or cancelled.
        Each message carries the guest's own link to change or cancel, your phone number, address and a calendar link. The words are in Back Office, Message templates, Bookings.
      </div>
      {extra?.missing && (
        <div style={{ margin: '8px 0', padding: '9px 11px', borderRadius: 9, background: 'var(--orn-d, rgba(245,158,11,.1))', color: 'var(--orn)', fontSize: 12, fontWeight: 700, lineHeight: 1.45 }}>
          These switches arrive with the bookings database update (migration 20261016c). Until it runs, confirmations still go out, and guests change or cancel by phone.
        </div>
      )}
      {extra?.error && <div style={{ margin: '8px 0', fontSize: 12, color: 'var(--red)' }}>Could not read these settings: {extra.error}</div>}
      <Toggle label="Send booking texts and emails"
        sub="Confirmation, reminders, change and cancel messages. Off sends none of them for this venue."
        on={ready ? extra.messages : true}
        onToggle={async () => { if (!ready) return; const v = !extra.messages; if (await save('guest_messages_enabled', v, v ? 'Booking messages on' : 'Booking messages off')) setExtra({ ...extra, messages: v }); }} />
      <Toggle label="Guests can change or cancel online"
        sub="Their link lets them move the date, time or party size, or cancel. Off: the link shows the booking and your phone number."
        on={ready ? extra.manage : true}
        onToggle={async () => { if (!ready) return; const v = !extra.manage; if (await save('guest_manage_enabled', v, v ? 'Online changes on' : 'Online changes off')) setExtra({ ...extra, manage: v }); }} />
      <Stepper label="Cancellation window"
        sub={windowHours > 0
          ? `Online changes close ${windowHours} ${windowHours === 1 ? 'hour' : 'hours'} before the booking. After that the guest is asked to call you. Money paid is never refunded by itself: a cancel in time is flagged for you to refund.`
          : 'Guests can change or cancel online right up to the booking time. Money paid is never refunded by itself: a cancel is flagged for you to refund.'}
        value={windowHours} onChange={(v) => patch({ cancellationWindowHours: v })}
        step={2} min={0} max={72} fmt={(v) => (v ? `${v} h` : 'none')} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Phone number guests call</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2, lineHeight: 1.4 }}>Shown in every booking message and on the guest's page. Empty uses the phone on your receipts.</div>
        </div>
        <input value={phoneValue} disabled={!ready} placeholder="e.g. 01484 000000" inputMode="tel"
          onChange={(e) => setPhone(e.target.value)}
          onBlur={async () => {
            if (!ready || phone === null || phone.trim() === (extra.phone || '')) return;
            const v = phone.trim();
            if (await save('guest_phone', v || null, v ? 'Phone saved' : 'Phone cleared, the receipt phone is used')) { setExtra({ ...extra, phone: v }); setPhone(null); }
          }}
          style={{ ...S.inp, width: 200 }} />
      </div>
    </div>
  );
}
