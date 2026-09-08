-- 20260721f_backfill_device_receipt_printers.sql
--
-- Backfill devices.receipt_printer_id so that receipt printing can FAIL CLOSED.
--
-- WHY THIS MUST SHIP WITH v5.5.835: until now `devices.receipt_printer_id` was a
-- dead write. Back Office → Devices let you pick a receipt printer, it saved, and
-- nothing ever read it. At print time printer.js scanned the WHOLE VENUE's printer
-- list for the first one carrying the 'receipt' role, so an MPOS handheld with no
-- printer set still printed to the counter. v5.5.835 makes the device assignment
-- authoritative and refuses to print when it is unset.
--
-- Consequence: every existing device whose receipt_printer_id is NULL would stop
-- printing the moment the release lands. This backfill hands each of them the same
-- printer the old role scan was already choosing, so counter POS + kiosk behaviour
-- is unchanged across the upgrade.
--
-- SELECTION RULE — mirrors the old client-side scan in printer.js `_printerForRole`:
--   * printers for the same location_id
--   * carrying the 'receipt' role. NOTE the null case: the client maps roles as
--     `r.meta?.roles || ['receipt']` (useSupabaseInit.js, PrinterRegistry.jsx), so a
--     printer row with no meta.roles key was ALSO treated as a receipt printer. The
--     `meta->'roles' is null` arm below reproduces that, otherwise those venues would
--     backfill to NULL and lose printing.
--   * earliest created_at wins — matches the deterministic `.order('created_at')`
--     added to the printers query in v5.5.835.
--   * printers with a usable ip are preferred over addressless ones. In a normal
--     venue (every printer has an ip) this is identical to plain created_at order;
--     it only differs where the oldest receipt printer has no address, in which case
--     the old code could never have thermally printed to it anyway.
--
-- DEVICE TYPES: 'pos' and 'kiosk' only.
--   * 'kds' never calls printReceipt at all (and the BO printer field is hidden for it).
--   * 'handheld' (MPOS) is DELIBERATELY EXCLUDED. A handheld printing to the counter
--     without anyone configuring it is the exact bug being fixed — those devices must
--     stay NULL until an operator sets a printer, at which point the MPOS "Print at
--     counter" button un-greys itself.
--
-- Only rows where receipt_printer_id IS NULL are touched — an operator's existing
-- explicit choice is never overwritten.
--
-- ROLLBACK: this only fills NULLs, so the inverse is to clear what it set:
--   update public.devices set receipt_printer_id = null
--    where type in ('pos','kiosk');
-- (Careful: that also clears assignments made by hand AFTER this ran. If that matters,
-- snapshot `select id, receipt_printer_id from public.devices` before applying.)

begin;

with pick as (
  select distinct on (p.location_id)
         p.location_id,
         p.id as printer_id
    from public.printers p
   where p.meta->'roles' is null
      or p.meta->'roles' ? 'receipt'
   order by p.location_id,
            (p.ip is null or p.ip = '') asc,   -- addressable printers first
            p.created_at asc
)
update public.devices d
   set receipt_printer_id = pick.printer_id
  from pick
 where d.location_id = pick.location_id
   and d.receipt_printer_id is null
   and d.type in ('pos', 'kiosk');

commit;

-- Post-apply sanity check (run manually, not part of the migration):
--   select type, count(*) filter (where receipt_printer_id is null) as unset,
--          count(*) as total
--     from public.devices group by type order by type;
-- Expect: 0 unset for 'pos' and 'kiosk' at any location that owns a receipt printer.
-- A location with NO printers at all still shows unset rows — that is correct, there
-- is nothing to point them at, and those devices will now warn instead of misprinting.
